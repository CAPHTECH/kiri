#!/usr/bin/env tsx
/**
 * 並列リクエストテストスクリプト
 *
 * kiri daemonに対して並列リクエストを送信し、
 * タイムアウトが発生しないことを確認する。
 *
 * 使用方法:
 *   1. daemonを起動: node dist/src/daemon/daemon.js --repo . --db .kiri/index.duckdb --socket-path /tmp/kiri-test.sock
 *   2. テスト実行: tsx scripts/test-parallel-requests.ts
 */

import * as net from "net";
import * as readline from "readline";

const SOCKET_PATH = process.env.SOCKET_PATH || "/tmp/kiri-test.sock";
const CONCURRENT_REQUESTS = 4;
const TIMEOUT_MS = 30000;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

async function sendRequest(socket: net.Socket, request: JsonRpcRequest): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Request ${request.id} timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    const rl = readline.createInterface({ input: socket });

    const handler = (line: string) => {
      try {
        const response = JSON.parse(line) as JsonRpcResponse;
        if (response.id === request.id) {
          clearTimeout(timeout);
          rl.removeListener("line", handler);
          resolve(response);
        }
      } catch {
        // 他のレスポンスは無視
      }
    };

    rl.on("line", handler);
    socket.write(JSON.stringify(request) + "\n");
  });
}

async function main() {
  console.log(`Connecting to socket: ${SOCKET_PATH}`);

  const socket = net.connect(SOCKET_PATH);

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  console.log("Connected successfully");

  // 並列リクエストを生成
  const requests: JsonRpcRequest[] = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "context_bundle",
        arguments: { goal: "daemon lifecycle", limit: 3 },
      },
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "files_search",
        arguments: { query: "DuckDB", limit: 3 },
      },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "snippets_get",
        arguments: { path: "src/daemon/socket.ts", view: "full" },
      },
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "deps_closure",
        arguments: { path: "src/daemon/daemon.ts", direction: "outbound" },
      },
    },
  ];

  console.log(`Sending ${CONCURRENT_REQUESTS} parallel requests...`);
  const startTime = Date.now();

  try {
    // 全リクエストを並列送信
    const promises = requests.map((req) => sendRequest(socket, req));
    const results = await Promise.all(promises);

    const elapsed = Date.now() - startTime;
    console.log(`\nAll ${CONCURRENT_REQUESTS} requests completed in ${elapsed}ms`);

    // 結果を表示
    for (const result of results) {
      if (result.error) {
        console.log(`  Request ${result.id}: ERROR - ${result.error.message}`);
      } else {
        console.log(`  Request ${result.id}: SUCCESS`);
      }
    }

    console.log("\n✅ Parallel request test PASSED");
    socket.end();
    process.exit(0);
  } catch (error) {
    const err = error as Error;
    console.error(`\n❌ Parallel request test FAILED: ${err.message}`);
    socket.end();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
