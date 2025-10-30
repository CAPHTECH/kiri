/**
 * Unix Socket Transport Layer for KIRI Daemon
 *
 * Provides IPC communication between daemon and clients via Unix domain sockets.
 * Handles multiple concurrent client connections with newline-delimited JSON-RPC protocol.
 */

import * as net from "net";
import * as fs from "fs/promises";
import * as readline from "readline";
import type { JsonRpcRequest, RpcHandleResult } from "../server/rpc.js";

/**
 * Unix socket server configuration
 */
export interface SocketServerOptions {
  /** Unix socket file path (e.g., /path/to/database.duckdb.sock) */
  socketPath: string;
  /** Handler function for JSON-RPC requests */
  onRequest: (request: JsonRpcRequest) => Promise<RpcHandleResult>;
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

  // 既存のソケットファイルが残っている場合は削除
  try {
    await fs.unlink(socketPath);
  } catch (err) {
    // ファイルが存在しない場合は無視
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  const server = net.createServer((socket) => {
    handleClientConnection(socket, onRequest, onError);
  });

  // Unixソケットをリッスン
  await new Promise<void>((resolve, reject) => {
    server.listen(socketPath, () => {
      resolve();
    });
    server.on("error", reject);
  });

  // ソケットファイルのパーミッションを0600に設定（所有者のみアクセス可能）
  await fs.chmod(socketPath, 0o600);

  console.error(`[Daemon] Listening on socket: ${socketPath}`);

  // クリーンアップハンドラを返す
  return async () => {
    return new Promise<void>((resolve) => {
      server.close(async () => {
        try {
          await fs.unlink(socketPath);
        } catch (err) {
          // 削除エラーは無視（既に削除されている可能性）
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
  onRequest: (request: JsonRpcRequest) => Promise<RpcHandleResult>,
  onError?: (error: Error) => void
): void {
  const rl = readline.createInterface({
    input: socket,
    crlfDelay: Infinity,
  });

  rl.on("line", async (line) => {
    try {
      const request = JSON.parse(line) as JsonRpcRequest;
      const result = await onRequest(request);
      // Extract response from RpcHandleResult (statusCode is only for HTTP)
      socket.write(JSON.stringify(result.response) + "\n");
    } catch (err) {
      const error = err as Error;
      if (onError) {
        onError(error);
      }

      // エラーレスポンスを送信
      const errorResponse = {
        jsonrpc: "2.0" as const,
        id: null,
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
