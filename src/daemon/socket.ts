/**
 * IPC Transport Layer for KIRI Daemon
 *
 * Provides IPC communication between daemon and clients:
 * - Unix/Linux/macOS: Unix domain sockets
 * - Windows: Named pipes
 * Handles multiple concurrent client connections with newline-delimited JSON-RPC protocol.
 */

import * as fs from "fs/promises";
import * as net from "net";
import * as os from "os";
import * as readline from "readline";

import PQueue from "p-queue";

import type { JsonRpcRequest, RpcHandleResult } from "../server/rpc.js";
import { acquireLock, releaseLock } from "../shared/utils/lockfile.js";

/**
 * Socket server configuration
 */
export interface SocketServerOptions {
  /** Socket path (Unix socket file path or Windows named pipe) */
  socketPath: string;
  /** Handler function for JSON-RPC requests */
  onRequest: (request: JsonRpcRequest) => Promise<RpcHandleResult | null>;
  /** Optional callback when a client connects */
  onClientConnected?: () => void;
  /** Optional callback when a client disconnects */
  onClientDisconnected?: () => void;
  /** Optional error handler for connection errors */
  onError?: (error: Error) => void;
}

/**
 * ソケットサーバーを作成し、複数クライアント接続を処理する
 *
 * @param options - サーバー設定
 * @returns クリーンアップ用のcloseハンドラ
 */
export async function createSocketServer(
  options: SocketServerOptions
): Promise<() => Promise<void>> {
  const { socketPath, onRequest, onError, onClientConnected, onClientDisconnected } = options;
  const isWindows = os.platform() === "win32";

  // プラットフォーム非依存の排他ロックでデーモン重複起動を防止
  // ロックファイルベースの検出により、IPC接続テストより信頼性が高い
  const lockfilePath = `${socketPath}.lock`;
  try {
    acquireLock(lockfilePath);
  } catch (error) {
    const err = error as Error;
    throw new Error(
      `Failed to acquire daemon lock: ${err.message}. ` +
        `Another daemon may be running. Lock file: ${lockfilePath}`
    );
  }

  // Unix系の場合: 既存のソケットファイルが残っている場合は削除
  // ロック取得済みのため、古いソケットファイルの削除は安全
  if (!isWindows) {
    try {
      await fs.unlink(socketPath);
    } catch (err) {
      // ファイルが存在しない場合は無視
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
  // Windows: 名前付きパイプは自動的にクリーンアップされるため、特別な処理不要
  // ロックファイルにより二重起動は既に防止済み

  const server = net.createServer((socket) => {
    onClientConnected?.();

    let closed = false;
    const markClosed = () => {
      if (closed) {
        return;
      }
      closed = true;
      onClientDisconnected?.();
    };

    socket.on("close", markClosed);

    handleClientConnection(socket, onRequest, onError);
  });

  // ソケット/名前付きパイプをリッスン
  await new Promise<void>((resolve, reject) => {
    server.listen(socketPath, () => {
      resolve();
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      // プラットフォーム固有のエラーメッセージを提供
      if (err.code === "EADDRINUSE") {
        const msg = isWindows
          ? `Named pipe already in use: ${socketPath}. Another daemon may be running.`
          : `Socket file in use: ${socketPath}. Another daemon may be running or stale socket exists.`;
        reject(new Error(msg));
      } else if (err.code === "EACCES") {
        reject(
          new Error(
            `Permission denied for socket: ${socketPath}. Run as administrator or check permissions.`
          )
        );
      } else {
        reject(new Error(`Failed to listen on ${socketPath}: ${err.message} (code: ${err.code})`));
      }
    });
  });

  // Unix系の場合: ソケットファイルのパーミッションを0600に設定（所有者のみアクセス可能）
  // Windows: 名前付きパイプにはファイルパーミッションが存在しないためスキップ
  if (!isWindows) {
    await fs.chmod(socketPath, 0o600);
  }

  console.error(`[Daemon] Listening on socket: ${socketPath}`);

  // クリーンアップハンドラを返す
  return async () => {
    return new Promise<void>((resolve) => {
      server.close(async () => {
        // 排他ロックを解放
        releaseLock(lockfilePath);

        // Unix系の場合のみソケットファイルを削除
        // Windows: 名前付きパイプは自動的にクリーンアップされる
        if (!isWindows) {
          try {
            await fs.unlink(socketPath);
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
          } catch (_err) {
            // 削除エラーは無視（既に削除されている可能性）
          }
        }
        resolve();
      });
    });
  };
}

/**
 * リクエストキューの同時実行数
 * DuckDBは単一接続で同時クエリをサポートしないため、
 * 並列リクエストによるタイムアウトを防ぐために1に設定
 *
 * @see Issue #XXX: 並列リクエストでAbortErrorが発生する問題
 */
const REQUEST_QUEUE_CONCURRENCY = 1;

/**
 * クライアント接続を処理する
 *
 * 各接続に対して：
 * 1. 改行区切りのJSON-RPCメッセージを読み取る
 * 2. onRequestハンドラを呼び出す（キューで順次処理）
 * 3. レスポンスを改行区切りで返す
 *
 * Note: リクエストはPQueueでシリアライズされ、DuckDBへの
 * 同時クエリによるタイムアウトを防止します。
 */
function handleClientConnection(
  socket: net.Socket,
  onRequest: (request: JsonRpcRequest) => Promise<RpcHandleResult | null>,
  onError?: (error: Error) => void
): void {
  const rl = readline.createInterface({
    input: socket,
    crlfDelay: Infinity,
  });

  // リクエストをシリアライズするためのキュー
  // DuckDBは単一接続で複数の同時クエリを処理できないため、
  // 並列リクエストを順次処理することでタイムアウトを防止
  const requestQueue = new PQueue({ concurrency: REQUEST_QUEUE_CONCURRENCY });

  rl.on("line", (line) => {
    // キューに追加して順次処理（awaitしないことで入力受付を継続）
    requestQueue.add(async () => {
      let request: JsonRpcRequest | null = null;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch (err) {
        const error = err as Error;
        if (onError) {
          onError(error);
        }

        const errorResponse = {
          jsonrpc: "2.0" as const,
          id: null,
          error: {
            code: -32700,
            message: "Parse error: Invalid JSON received.",
          },
        };
        socket.write(JSON.stringify(errorResponse) + "\n");
        return;
      }

      try {
        const result = await onRequest(request);
        if (result) {
          const hasResponseId = typeof request.id === "string" || typeof request.id === "number";
          if (!hasResponseId) {
            return;
          }
          // Extract response from RpcHandleResult (statusCode is only for HTTP)
          socket.write(JSON.stringify(result.response) + "\n");
        }
      } catch (err) {
        const error = err as Error;
        if (onError) {
          onError(error);
        }

        const hasResponseId =
          request && (typeof request.id === "string" || typeof request.id === "number");
        if (!hasResponseId) {
          return;
        }

        // エラーレスポンスを送信
        const errorResponse = {
          jsonrpc: "2.0" as const,
          id: request.id,
          error: {
            code: -32603,
            message: `Internal error: ${error.message}`,
          },
        };
        socket.write(JSON.stringify(errorResponse) + "\n");
      }
    });
  });

  socket.on("error", (err) => {
    if (onError) {
      onError(err);
    }
  });

  socket.on("end", () => {
    rl.close();
    // キューが空になるのを待たずに接続を閉じる
    // 残っているタスクは完了まで実行される
    requestQueue.clear();
  });
}
