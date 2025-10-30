/**
 * Tests for Unix socket transport layer
 */

import * as fs from "fs/promises";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSocketServer } from "../../src/daemon/socket.js";
import type { JsonRpcRequest, RpcHandleResult } from "../../src/server/rpc.js";

describe("Socket Transport", () => {
  let socketPath: string;
  let closeServer: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    // 一時ディレクトリにソケットファイルを作成
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kiri-socket-test-"));
    socketPath = path.join(tmpDir, "test.sock");
  });

  afterEach(async () => {
    if (closeServer) {
      await closeServer();
      closeServer = null;
    }

    // ソケットファイルとディレクトリをクリーンアップ
    try {
      await fs.unlink(socketPath);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err) {
      // Already deleted
    }

    try {
      await fs.rmdir(path.dirname(socketPath));
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err) {
      // Already deleted
    }
  });

  it("creates socket server and accepts connections", async () => {
    const handler = async (request: JsonRpcRequest): Promise<RpcHandleResult> => {
      return {
        response: {
          jsonrpc: "2.0",
          id: request.id,
          result: { echo: request.method },
        },
        statusCode: 200,
      };
    };

    closeServer = await createSocketServer({
      socketPath,
      onRequest: handler,
    });

    // ソケットファイルが作成されたことを確認
    const stats = await fs.stat(socketPath);
    expect(stats.isSocket()).toBe(true);

    // パーミッションが0600であることを確認（所有者のみアクセス可能）
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("handles JSON-RPC request and returns response", async () => {
    const handler = async (request: JsonRpcRequest): Promise<RpcHandleResult> => {
      return {
        response: {
          jsonrpc: "2.0",
          id: request.id,
          result: { method: request.method, params: request.params },
        },
        statusCode: 200,
      };
    };

    closeServer = await createSocketServer({
      socketPath,
      onRequest: handler,
    });

    // クライアント接続
    const client = net.connect(socketPath);
    await new Promise<void>((resolve) => client.on("connect", () => resolve()));

    // リクエスト送信
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "test.method",
      params: { foo: "bar" },
    };

    const rl = readline.createInterface({ input: client, crlfDelay: Infinity });

    const responsePromise = new Promise<string>((resolve) => {
      rl.once("line", (line) => resolve(line));
    });

    client.write(JSON.stringify(request) + "\n");

    const responseLine = await responsePromise;
    const response = JSON.parse(responseLine);

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    expect(response.result).toEqual({
      method: "test.method",
      params: { foo: "bar" },
    });

    client.end();
  });

  it("handles multiple concurrent client connections", async () => {
    let requestCount = 0;

    const handler = async (request: JsonRpcRequest): Promise<RpcHandleResult> => {
      requestCount++;
      return {
        response: {
          jsonrpc: "2.0",
          id: request.id,
          result: { count: requestCount },
        },
        statusCode: 200,
      };
    };

    closeServer = await createSocketServer({
      socketPath,
      onRequest: handler,
    });

    // 3つのクライアントを同時に接続
    const clients = await Promise.all([
      net.connect(socketPath),
      net.connect(socketPath),
      net.connect(socketPath),
    ]);

    await Promise.all(
      clients.map((client) => new Promise<void>((resolve) => client.on("connect", () => resolve())))
    );

    // 各クライアントからリクエスト送信
    const responses = await Promise.all(
      clients.map(async (client, index) => {
        const rl = readline.createInterface({ input: client, crlfDelay: Infinity });
        const responsePromise = new Promise<string>((resolve) => {
          rl.once("line", (line) => resolve(line));
        });

        const request = {
          jsonrpc: "2.0",
          id: index,
          method: "test",
        };

        client.write(JSON.stringify(request) + "\n");
        const responseLine = await responsePromise;
        client.end();
        return JSON.parse(responseLine);
      })
    );

    // すべてのレスポンスが返ってきたことを確認
    expect(responses).toHaveLength(3);
    expect(requestCount).toBe(3);

    responses.forEach((response, index) => {
      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(index);
      expect(response.result).toHaveProperty("count");
    });
  });

  it("handles handler errors gracefully", async () => {
    const handler = async (): Promise<RpcHandleResult> => {
      throw new Error("Handler error");
    };

    let errorCaught = false;
    const onError = () => {
      errorCaught = true;
    };

    closeServer = await createSocketServer({
      socketPath,
      onRequest: handler,
      onError,
    });

    const client = net.connect(socketPath);
    await new Promise<void>((resolve) => client.on("connect", () => resolve()));

    const rl = readline.createInterface({ input: client, crlfDelay: Infinity });
    const responsePromise = new Promise<string>((resolve) => {
      rl.once("line", (line) => resolve(line));
    });

    const request = { jsonrpc: "2.0", id: 1, method: "test" };
    client.write(JSON.stringify(request) + "\n");

    const responseLine = await responsePromise;
    const response = JSON.parse(responseLine);

    // エラーレスポンスが返ることを確認
    expect(response.jsonrpc).toBe("2.0");
    expect(response.error).toBeDefined();
    expect(response.error.code).toBe(-32603);
    expect(response.error.message).toContain("Internal error");
    expect(errorCaught).toBe(true);

    client.end();
  });

  it("cleans up socket file on close", async () => {
    const handler = async (request: JsonRpcRequest): Promise<RpcHandleResult> => {
      return {
        response: { jsonrpc: "2.0", id: request.id, result: {} },
        statusCode: 200,
      };
    };

    closeServer = await createSocketServer({
      socketPath,
      onRequest: handler,
    });

    // ソケットファイルが存在することを確認
    await fs.access(socketPath);

    // サーバーをクローズ
    await closeServer();
    closeServer = null;

    // ソケットファイルが削除されたことを確認
    await expect(fs.access(socketPath)).rejects.toThrow();
  });

  it("handles malformed JSON gracefully", async () => {
    const handler = async (request: JsonRpcRequest): Promise<RpcHandleResult> => {
      return {
        response: { jsonrpc: "2.0", id: request.id, result: {} },
        statusCode: 200,
      };
    };

    let errorCaught = false;
    const onError = () => {
      errorCaught = true;
    };

    closeServer = await createSocketServer({
      socketPath,
      onRequest: handler,
      onError,
    });

    const client = net.connect(socketPath);
    await new Promise<void>((resolve) => client.on("connect", () => resolve()));

    const rl = readline.createInterface({ input: client, crlfDelay: Infinity });
    const responsePromise = new Promise<string>((resolve) => {
      rl.once("line", (line) => resolve(line));
    });

    // 不正なJSONを送信
    client.write("{ invalid json }\n");

    const responseLine = await responsePromise;
    const response = JSON.parse(responseLine);

    // エラーレスポンスが返ることを確認
    expect(response.error).toBeDefined();
    expect(errorCaught).toBe(true);

    client.end();
  });
});
