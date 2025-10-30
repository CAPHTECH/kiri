/**
 * Integration tests for daemon-client communication
 */

import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs/promises";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runIndexer } from "../../src/indexer/cli.js";

describe.skip("Daemon Integration", () => {
  let tmpDir: string;
  let repoRoot: string;
  let databasePath: string;
  let socketPath: string;
  let daemonProcess: ChildProcess | null = null;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kiri-daemon-integration-"));
    repoRoot = path.join(tmpDir, "repo");
    databasePath = path.join(tmpDir, "test.duckdb");
    socketPath = `${databasePath}.sock`;

    // テスト用リポジトリを作成
    await fs.mkdir(repoRoot, { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "test.ts"),
      'export function hello() { return "world"; }',
      "utf-8"
    );

    // リポジトリをインデックス
    await runIndexer({ repoRoot, databasePath, full: true });
  });

  afterEach(async () => {
    // デーモンプロセスを停止
    if (daemonProcess) {
      daemonProcess.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        daemonProcess!.on("exit", () => resolve());
        setTimeout(() => {
          if (daemonProcess && !daemonProcess.killed) {
            daemonProcess.kill("SIGKILL");
          }
          resolve();
        }, 5000);
      });
      daemonProcess = null;
    }

    // クリーンアップ
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err) {
      // Ignore cleanup errors
    }
  });

  async function startDaemon(): Promise<void> {
    const daemonScript = path.resolve(__dirname, "../../dist/src/daemon/daemon.js");

    daemonProcess = spawn(
      process.execPath,
      [daemonScript, "--repo", repoRoot, "--db", databasePath, "--socket-path", socketPath],
      {
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    // デーモンの起動を待つ
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Daemon startup timeout"));
      }, 10000);

      daemonProcess!.stderr!.on("data", (data: Buffer) => {
        const output = data.toString();
        if (output.includes("Ready to accept connections")) {
          clearTimeout(timeout);
          resolve();
        }
      });

      daemonProcess!.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    // ソケットが作成されるまで待つ
    for (let i = 0; i < 50; i++) {
      try {
        await fs.access(socketPath);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  it("daemon accepts client connections and handles requests", async () => {
    await startDaemon();

    // クライアント接続
    const client = net.connect(socketPath);
    await new Promise<void>((resolve) => client.on("connect", () => resolve()));

    const rl = readline.createInterface({ input: client, crlfDelay: Infinity });

    // initializeリクエストを送信
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    };

    const responsePromise = new Promise<string>((resolve) => {
      rl.once("line", (line) => resolve(line));
    });

    client.write(JSON.stringify(request) + "\n");

    const responseLine = await responsePromise;
    const response = JSON.parse(responseLine);

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    expect(response.result).toBeDefined();
    expect(response.result.serverInfo).toBeDefined();
    expect(response.result.serverInfo.name).toBe("kiri");

    client.end();
  });

  it("daemon handles multiple concurrent client connections", async () => {
    await startDaemon();

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
          method: "tools/list",
        };

        client.write(JSON.stringify(request) + "\n");
        const responseLine = await responsePromise;
        client.end();
        return JSON.parse(responseLine);
      })
    );

    // すべてのレスポンスが正常に返ることを確認
    expect(responses).toHaveLength(3);
    responses.forEach((response, index) => {
      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(index);
      expect(response.result).toBeDefined();
      expect(response.result.tools).toBeDefined();
      expect(Array.isArray(response.result.tools)).toBe(true);
    });
  });

  it("daemon creates PID file on startup", async () => {
    await startDaemon();

    const pidFilePath = `${databasePath}.daemon.pid`;
    const pidContent = await fs.readFile(pidFilePath, "utf-8");
    const pid = parseInt(pidContent.trim(), 10);

    expect(pid).toBeGreaterThan(0);
    expect(pid).toBe(daemonProcess!.pid);
  });

  it("daemon cleans up PID file on shutdown", async () => {
    await startDaemon();

    const pidFilePath = `${databasePath}.daemon.pid`;

    // PIDファイルが存在することを確認
    await fs.access(pidFilePath);

    // デーモンを停止
    daemonProcess!.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      daemonProcess!.on("exit", () => resolve());
    });
    daemonProcess = null;

    // PIDファイルが削除されたことを確認（少し待機）
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await expect(fs.access(pidFilePath)).rejects.toThrow();
  });

  it("daemon handles tools/call request correctly", async () => {
    await startDaemon();

    const client = net.connect(socketPath);
    await new Promise<void>((resolve) => client.on("connect", () => resolve()));

    const rl = readline.createInterface({ input: client, crlfDelay: Infinity });

    // tools/callリクエストを送信（files.search）
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "files.search",
        arguments: {
          query: "hello",
          limit: 5,
        },
      },
    };

    const responsePromise = new Promise<string>((resolve) => {
      rl.once("line", (line) => resolve(line));
    });

    client.write(JSON.stringify(request) + "\n");

    const responseLine = await responsePromise;
    const response = JSON.parse(responseLine);

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    expect(response.result).toBeDefined();
    expect(response.result.content).toBeDefined();
    expect(Array.isArray(response.result.content)).toBe(true);

    client.end();
  });
});
