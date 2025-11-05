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

import type { JsonRpcRequest, RpcHandleResult } from "../server/rpc.js";

/**
 * Socket server configuration
 */
export interface SocketServerOptions {
  /** Socket path (Unix socket file path or Windows named pipe) */
  socketPath: string;
  /** Handler function for JSON-RPC requests */
  onRequest: (request: JsonRpcRequest) => Promise<RpcHandleResult | null>;
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
  const { socketPath, onRequest, onError } = options;
  const isWindows = os.platform() === "win32";

  // Unix系の場合: 既存のソケットファイルが残っている場合は削除
  if (!isWindows) {
    try {
      await fs.unlink(socketPath);
    } catch (err) {
      // ファイルが存在しない場合は無視
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  } else {
    // Windows: 古い名前付きパイプへの接続を試みて、既存デーモンの検出
    // 接続失敗 = パイプが存在しない（安全に作成可能）
    // 接続成功 = 既に他のデーモンが実行中（エラー）
    const testSocket = net.connect(socketPath);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        testSocket.destroy();
        // タイムアウト = パイプが存在するが応答なし（古いパイプの可能性）
        console.error(`[Daemon] Warning: Stale pipe may exist at ${socketPath}, proceeding...`);
        resolve();
      }, 1000);

      testSocket.on("connect", () => {
        clearTimeout(timeout);
        testSocket.destroy();
        reject(
          new Error(`Daemon already running on pipe: ${socketPath}. Stop existing daemon first.`)
        );
      });

      testSocket.on("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        // ENOENT/ECONNREFUSED = パイプが存在しない（正常）
        // その他 = 異常状態（ログに記録して続行）
        if (err.code !== "ENOENT" && err.code !== "ECONNREFUSED") {
          console.error(`[Daemon] Warning: Pipe error during check: ${err.message}`);
        }
        resolve();
      });
    });
  }

  const server = net.createServer((socket) => {
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
 * クライアント接続を処理する
 *
 * 各接続に対して：
 * 1. 改行区切りのJSON-RPCメッセージを読み取る
 * 2. onRequestハンドラを呼び出す
 * 3. レスポンスを改行区切りで返す
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

  rl.on("line", async (line) => {
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

  socket.on("error", (err) => {
    if (onError) {
      onError(err);
    }
  });

  socket.on("end", () => {
    rl.close();
  });
}
