#!/usr/bin/env node
/**
 * KIRI Client Proxy
 *
 * Transparently bridges stdio (MCP client) ↔ Unix socket (daemon).
 * Auto-starts daemon if not running, handles retries and fallback.
 * Supports automatic reconnection on daemon restart.
 *
 * @see Issue #156: MCP接続がデーモン再起動時に切断され、自動再接続しない問題への対応
 */

import { spawn } from "child_process";
import * as net from "net";
import * as path from "path";
import * as readline from "readline";
import { fileURLToPath } from "url";

import packageJson from "../../package.json" with { type: "json" };
import { defineCli, type CliSpec } from "../shared/cli/args.js";
import { getSocketPath } from "../shared/utils/socket.js";
import { parsePositiveInt } from "../shared/utils/validation.js";

import { ConnectionManager, isRetriableError } from "./connection-manager.js";
import { startDaemon, isDaemonRunning, stopDaemon } from "./start-daemon.js";

/** Delay after stopping daemon before starting new processes */
const DAEMON_STOP_WAIT_MS = 1000;

/**
 * プロキシ設定オプション
 */
interface ProxyOptions {
  repoRoot: string;
  databasePath: string;
  socketPath: string;
  watchMode: boolean;
  debounceMs: number;
  maxRetries: number;
  retryDelayMs: number;
  allowDegrade: boolean;
  securityConfigPath?: string | undefined;
  securityLockPath?: string | undefined;
  fullIndex: boolean;
  /** 最大再接続試行回数（デフォルト: 10） */
  maxReconnectAttempts: number;
  /** 初期再接続遅延（ミリ秒、デフォルト: 500） */
  reconnectInitialDelayMs: number;
  /** 最大再接続遅延（ミリ秒、デフォルト: 30000） */
  reconnectMaxDelayMs: number;
}

/**
 * Build daemon startup options from proxy options
 */
function buildDaemonOptions(options: ProxyOptions) {
  return {
    repoRoot: options.repoRoot,
    databasePath: options.databasePath,
    socketPath: options.socketPath,
    watchMode: options.watchMode,
    debounceMs: options.debounceMs,
    allowDegrade: options.allowDegrade,
    securityConfigPath: options.securityConfigPath,
    securityLockPath: options.securityLockPath,
  };
}

/**
 * CLI specification for kiri proxy
 */
const PROXY_CLI_SPEC: CliSpec = {
  commandName: "kiri",
  description: "KIRI MCP Client Proxy - Bridges stdio (MCP client) ↔ Unix socket (daemon)",
  version: packageJson.version,
  usage: "kiri [options]",
  sections: [
    {
      title: "Repository / Database",
      options: [
        {
          flag: "repo",
          type: "string",
          description: "Repository root path",
          placeholder: "<path>",
          default: ".",
        },
        {
          flag: "db",
          type: "string",
          description: "Database file path (default: var/index.duckdb relative to --repo)",
          placeholder: "<path>",
        },
      ],
    },
    {
      title: "Daemon Connection",
      options: [
        {
          flag: "socket-path",
          type: "string",
          description: "Unix socket path for daemon connection",
          placeholder: "<path>",
        },
      ],
    },
    {
      title: "Watch Mode",
      options: [
        {
          flag: "watch",
          type: "boolean",
          description: "Enable watch mode for automatic re-indexing",
          default: false,
        },
        {
          flag: "debounce",
          type: "string",
          description: "Debounce delay in milliseconds for watch mode",
          placeholder: "<ms>",
          default: "500",
        },
      ],
    },
    {
      title: "Security",
      options: [
        {
          flag: "allow-degrade",
          type: "boolean",
          description: "Allow degraded mode without VSS/FTS extensions",
          default: false,
        },
        {
          flag: "security-config",
          type: "string",
          description: "Security configuration file path",
          placeholder: "<path>",
        },
        {
          flag: "security-lock",
          type: "string",
          description: "Security lock file path",
          placeholder: "<path>",
        },
      ],
    },
    {
      title: "Indexing",
      options: [
        {
          flag: "full",
          type: "boolean",
          description:
            "Run full reindex and exit (stops daemon if running, restarts after indexing)",
          default: false,
        },
      ],
    },
    {
      title: "Reconnection",
      options: [
        {
          flag: "max-reconnect-attempts",
          type: "string",
          description: "Maximum number of reconnection attempts (default: 10)",
          placeholder: "<count>",
          default: "10",
        },
        {
          flag: "reconnect-delay",
          type: "string",
          description: "Initial reconnection delay in milliseconds (default: 500)",
          placeholder: "<ms>",
          default: "500",
        },
        {
          flag: "reconnect-max-delay",
          type: "string",
          description: "Maximum reconnection delay in milliseconds (default: 30000)",
          placeholder: "<ms>",
          default: "30000",
        },
      ],
    },
  ],
  examples: [
    "kiri --repo /path/to/repo --db /path/to/index.duckdb",
    "kiri --watch --allow-degrade",
    "kiri --security-config config/security.yaml",
  ],
};

/**
 * CLI引数をパース
 */
function parseProxyArgs(): ProxyOptions {
  const { values } = defineCli(PROXY_CLI_SPEC);

  const repoRoot = path.resolve((values.repo as string | undefined) || process.cwd());
  const databasePath = path.resolve(
    (values.db as string | undefined) || path.join(repoRoot, "var", "index.duckdb")
  );
  const socketPath = values["socket-path"]
    ? path.resolve(values["socket-path"] as string)
    : getSocketPath(databasePath);

  return {
    repoRoot,
    databasePath,
    socketPath,
    watchMode: (values.watch as boolean) || false,
    debounceMs: parsePositiveInt(values.debounce as string | undefined, 500, "debounce delay"),
    maxRetries: 3,
    retryDelayMs: 1000,
    allowDegrade: (values["allow-degrade"] as boolean) || false,
    securityConfigPath: values["security-config"] as string | undefined,
    securityLockPath: values["security-lock"] as string | undefined,
    fullIndex: (values.full as boolean) || false,
    maxReconnectAttempts: parsePositiveInt(
      values["max-reconnect-attempts"] as string | undefined,
      10,
      "max reconnect attempts"
    ),
    reconnectInitialDelayMs: parsePositiveInt(
      values["reconnect-delay"] as string | undefined,
      500,
      "reconnect delay"
    ),
    reconnectMaxDelayMs: parsePositiveInt(
      values["reconnect-max-delay"] as string | undefined,
      30000,
      "reconnect max delay"
    ),
  };
}

/**
 * デーモンのバージョンをチェック
 *
 * Major/minor versionが一致しない場合はエラーを投げる
 */
async function checkDaemonVersion(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Version check timeout"));
    }, 3000);

    // pingリクエストを送信してバージョン情報を取得
    const pingRequest = {
      jsonrpc: "2.0",
      id: "version-check",
      method: "ping",
    };

    let responseReceived = false;

    const dataHandler = (data: Buffer) => {
      if (responseReceived) return;

      try {
        const response = JSON.parse(data.toString().trim());
        if (response.id === "version-check" && response.result) {
          responseReceived = true;
          clearTimeout(timeout);
          socket.removeListener("data", dataHandler);

          const daemonVersion = response.result.serverInfo?.version || "unknown";
          const clientVersion =
            typeof packageJson?.version === "string" ? packageJson.version : "0.0.0";

          // Major.minor バージョンを比較
          const daemonMajorMinor = daemonVersion.split(".").slice(0, 2).join(".");
          const clientMajorMinor = clientVersion.split(".").slice(0, 2).join(".");

          if (daemonMajorMinor !== clientMajorMinor) {
            reject(
              new Error(
                `Version mismatch: client ${clientVersion} is incompatible with daemon ${daemonVersion}. Restart the daemon to use the current version.`
              )
            );
          } else {
            console.error(
              `[Proxy] Version check passed: client=${clientVersion}, daemon=${daemonVersion}`
            );
            resolve();
          }
        }
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (parseErr) {
        clearTimeout(timeout);
        socket.removeListener("data", dataHandler);
        reject(new Error("Failed to parse version check response"));
      }
    };

    socket.on("data", dataHandler);
    socket.write(JSON.stringify(pingRequest) + "\n");
  });
}

/**
 * デーモンに接続を試みる（リトライロジック付き）
 */
async function _connectToDaemon(
  socketPath: string,
  maxRetries: number,
  retryDelayMs: number
): Promise<net.Socket> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const socket = net.connect(socketPath);

      // 接続成功を待つ
      await new Promise<void>((resolve, reject) => {
        socket.on("connect", () => resolve());
        socket.on("error", (err) => reject(err));
      });

      return socket;
    } catch (err) {
      console.error(
        `[Proxy] Connection attempt ${attempt}/${maxRetries} failed: ${(err as Error).message}`
      );

      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      } else {
        throw new Error(
          `Failed to connect to daemon after ${maxRetries} attempts. Connection error: ${(err as Error).message}`
        );
      }
    }
  }

  throw new Error("Unexpected error in _connectToDaemon");
}

/**
 * Stdio ↔ Socket ブリッジを確立（再接続対応版）
 *
 * ConnectionManagerを使用して、デーモン再起動時も自動的に再接続を試みる。
 * 再接続中のリクエストはRequestQueueでバッファリングされ、再接続後に再送信される。
 *
 * @see Issue #156
 */
function createReconnectingBridge(connectionManager: ConnectionManager): void {
  const requestQueue = connectionManager.getRequestQueue();

  // stdin → socket
  const stdinReader = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  stdinReader.on("line", async (line) => {
    // リクエストをキューに追加
    requestQueue.enqueue(line);

    const socket = connectionManager.getSocket();
    if (socket && connectionManager.getState().status === "connected") {
      try {
        socket.write(line + "\n");
      } catch (err) {
        console.error(`[Proxy] Write error: ${(err as Error).message}`);
        // 書き込みエラーは無視（再接続時に再送信される）
      }
    }
    // 接続されていない場合、リクエストはキューに保持され、再接続後に再送信される
  });

  stdinReader.on("close", () => {
    connectionManager.close();
    process.exit(0);
  });

  // socket → stdout のイベントリスナーを設定
  connectionManager.on("data", (data) => {
    // 改行区切りでレスポンスを処理
    const lines = data
      .toString()
      .split("\n")
      .filter((line) => line.trim());
    for (const line of lines) {
      console.log(line);

      // レスポンスを受信したらキューから削除
      try {
        const response = JSON.parse(line);
        if (response.id !== undefined && response.id !== null) {
          requestQueue.dequeue(response.id);
        }
      } catch {
        // JSONパースエラーは無視
      }
    }
  });

  // 再接続イベントのログ出力
  connectionManager.on("reconnecting", (attempt, maxAttempts, delayMs) => {
    console.error(
      `[Proxy] Reconnection attempt ${attempt}/${maxAttempts} (delay: ${Math.round(delayMs)}ms)`
    );
  });

  connectionManager.on("reconnected", () => {
    console.error("[Proxy] Reconnected to daemon successfully");
  });

  connectionManager.on("disconnected", (reason) => {
    console.error(`[Proxy] Connection lost: ${reason}. Attempting reconnection...`);
  });

  connectionManager.on("maxRetriesExceeded", () => {
    console.error("[Proxy] Max reconnection attempts exceeded. Exiting.");
    process.exit(1);
  });

  connectionManager.on("error", (err) => {
    if (!isRetriableError(err)) {
      console.error(`[Proxy] Fatal socket error: ${err.message}`);
      process.exit(1);
    }
    // 再接続可能なエラーはConnectionManagerが自動的に処理
  });
}

/**
 * Stdio ↔ Socket ブリッジを確立（レガシー版、後方互換性のために残す）
 *
 * @deprecated createReconnectingBridgeを使用してください
 */
function _bridgeStdioToSocket(socket: net.Socket): void {
  // stdin → socket
  const stdinReader = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  stdinReader.on("line", (line) => {
    socket.write(line + "\n");
  });

  stdinReader.on("close", () => {
    socket.end();
  });

  // socket → stdout
  const socketReader = readline.createInterface({
    input: socket,
    crlfDelay: Infinity,
  });

  socketReader.on("line", (line) => {
    console.log(line);
  });

  socket.on("end", () => {
    stdinReader.close();
    process.exit(0);
  });

  socket.on("error", (err) => {
    console.error(`[Proxy] Socket error: ${err.message}`);
    process.exit(1);
  });
}

/**
 * Run indexer as a child process to ensure DuckDB file lock is released
 */
async function runIndexerProcess(repoRoot: string, databasePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Get the path to the indexer CLI
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const indexerPath = path.join(__dirname, "../indexer/cli.js");

    const child = spawn(
      process.execPath,
      [indexerPath, "--repo", repoRoot, "--db", databasePath, "--full"],
      {
        stdio: ["ignore", "inherit", "inherit"],
      }
    );

    child.on("error", (err) => {
      reject(new Error(`Failed to spawn indexer: ${err.message}`));
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Indexer exited with code ${code}`));
      }
    });
  });
}

/**
 * Handle --full flag: stop daemon, run full index, restart daemon
 *
 * This function implements index-only mode where:
 * 1. Existing daemon is stopped (if running)
 * 2. Full reindex is performed (in child process to release DB lock)
 * 3. Daemon is restarted
 */
async function handleFullIndex(options: ProxyOptions): Promise<void> {
  try {
    // Step 1: Stop existing daemon if running (use configured socket path)
    const wasRunning = await isDaemonRunning(options.databasePath, options.socketPath);
    if (wasRunning) {
      console.error("[Full Index] Stopping existing daemon...");
      await stopDaemon(options.databasePath);
      await new Promise((resolve) => setTimeout(resolve, DAEMON_STOP_WAIT_MS));
      console.error("[Full Index] Daemon stopped");
    }

    // Step 2: Run full index in child process (ensures DB lock is released on exit)
    console.error(`[Full Index] Starting full reindex for ${options.repoRoot}...`);
    await runIndexerProcess(options.repoRoot, options.databasePath);
    console.error("[Full Index] Indexing complete");

    // Step 3: Restart daemon
    console.error("[Full Index] Starting daemon...");
    await startDaemon(buildDaemonOptions(options));
    console.error("[Full Index] Daemon started successfully");
  } catch (err) {
    const error = err as Error;
    console.error(`[Full Index] Failed: ${error.message}`);
    process.exit(1);
  }
}

/**
 * メイン関数：プロキシを起動
 *
 * ConnectionManagerを使用して、デーモン再起動時も自動的に再接続を試みる。
 *
 * @see Issue #156
 */
async function main() {
  const options = parseProxyArgs();

  // Handle --full flag: index-only mode
  if (options.fullIndex) {
    await handleFullIndex(options);
    return; // Exit without starting MCP proxy
  }

  try {
    // ConnectionManagerを作成
    const connectionManager = new ConnectionManager({
      socketPath: options.socketPath,
      databasePath: options.databasePath,
      repoRoot: options.repoRoot,
      maxReconnectAttempts: options.maxReconnectAttempts,
      reconnectInitialDelayMs: options.reconnectInitialDelayMs,
      reconnectMaxDelayMs: options.reconnectMaxDelayMs,
      watchMode: options.watchMode,
      debounceMs: options.debounceMs,
      allowDegrade: options.allowDegrade,
      securityConfigPath: options.securityConfigPath,
      securityLockPath: options.securityLockPath,
    });

    // 初回接続
    const socket = await connectionManager.connect();

    // バージョン互換性をチェック
    try {
      await checkDaemonVersion(socket);
    } catch (versionError) {
      const versionErr = versionError as Error;
      // バージョン不一致を検出した場合、自動的に再起動
      if (versionErr.message.includes("Version mismatch")) {
        console.error(`[Proxy] ${versionErr.message}`);
        console.error("[Proxy] Automatically restarting daemon with current version...");

        connectionManager.close();

        // 古いデーモンを停止
        await stopDaemon(options.databasePath);

        // 少し待ってから新しいデーモンを起動
        await new Promise((resolve) => setTimeout(resolve, DAEMON_STOP_WAIT_MS));

        // 新しいConnectionManagerを作成して再接続
        const newConnectionManager = new ConnectionManager({
          socketPath: options.socketPath,
          databasePath: options.databasePath,
          repoRoot: options.repoRoot,
          maxReconnectAttempts: options.maxReconnectAttempts,
          reconnectInitialDelayMs: options.reconnectInitialDelayMs,
          reconnectMaxDelayMs: options.reconnectMaxDelayMs,
          watchMode: options.watchMode,
          debounceMs: options.debounceMs,
          allowDegrade: options.allowDegrade,
          securityConfigPath: options.securityConfigPath,
          securityLockPath: options.securityLockPath,
        });

        const newSocket = await newConnectionManager.connect();

        console.error("[Proxy] Daemon restarted successfully, reconnecting...");

        // 再度バージョンチェック
        await checkDaemonVersion(newSocket);

        console.error(
          "[Proxy] Connected to daemon. Bridging stdio ↔ socket (with reconnection support)..."
        );

        // Stdio ↔ Socket ブリッジを確立（再接続対応版）
        createReconnectingBridge(newConnectionManager);
        return;
      }
      throw versionError;
    }

    console.error(
      "[Proxy] Connected to daemon. Bridging stdio ↔ socket (with reconnection support)..."
    );

    // Stdio ↔ Socket ブリッジを確立（再接続対応版）
    createReconnectingBridge(connectionManager);
  } catch (err) {
    const error = err as Error;
    console.error(`[Proxy] Failed to start proxy: ${error.message}`);
    console.error(`[Proxy] Check daemon log at: ${options.databasePath}.daemon.log`);
    console.error("[Proxy] Falling back to legacy stdio mode is not yet implemented");
    process.exit(1);
  }
}

// エントリーポイント
main().catch((err) => {
  console.error(`[Proxy] Unhandled error: ${err}`);
  process.exit(1);
});
