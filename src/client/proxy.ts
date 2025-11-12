#!/usr/bin/env node
/**
 * KIRI Client Proxy
 *
 * Transparently bridges stdio (MCP client) ↔ Unix socket (daemon).
 * Auto-starts daemon if not running, handles retries and fallback.
 */

import * as net from "net";
import * as path from "path";
import * as readline from "readline";

import packageJson from "../../package.json" with { type: "json" };
import { defineCli, type CliSpec } from "../shared/cli/args.js";
import { getSocketPath } from "../shared/utils/socket.js";

import { startDaemon, isDaemonRunning, stopDaemon } from "./start-daemon.js";

/**
 * プロキシ設定オプション
 */
interface ProxyOptions {
  repoRoot: string;
  databasePath: string;
  socketPath: string;
  watchMode: boolean;
  maxRetries: number;
  retryDelayMs: number;
  allowDegrade: boolean;
  securityConfigPath?: string | undefined;
  securityLockPath?: string | undefined;
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
          description: "Database file path",
          placeholder: "<path>",
          default: "var/index.duckdb",
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
    maxRetries: 3,
    retryDelayMs: 1000,
    allowDegrade: (values["allow-degrade"] as boolean) || false,
    securityConfigPath: values["security-config"] as string | undefined,
    securityLockPath: values["security-lock"] as string | undefined,
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
async function connectToDaemon(
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

  throw new Error("Unexpected error in connectToDaemon");
}

/**
 * Stdio ↔ Socket ブリッジを確立
 */
function bridgeStdioToSocket(socket: net.Socket): void {
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
 * メイン関数：プロキシを起動
 */
async function main() {
  const options = parseProxyArgs();

  try {
    // デーモンが実行中かチェック
    const running = await isDaemonRunning(options.databasePath);

    if (!running) {
      console.error("[Proxy] Daemon not running. Starting daemon...");

      // デーモンを起動
      await startDaemon({
        repoRoot: options.repoRoot,
        databasePath: options.databasePath,
        socketPath: options.socketPath,
        watchMode: options.watchMode,
        allowDegrade: options.allowDegrade,
        securityConfigPath: options.securityConfigPath,
        securityLockPath: options.securityLockPath,
      });

      console.error("[Proxy] Daemon started successfully");
    }

    // デーモンに接続
    const socket = await connectToDaemon(
      options.socketPath,
      options.maxRetries,
      options.retryDelayMs
    );

    // バージョン互換性をチェック
    try {
      await checkDaemonVersion(socket);
    } catch (versionError) {
      const versionErr = versionError as Error;
      // バージョン不一致を検出した場合、自動的に再起動
      if (versionErr.message.includes("Version mismatch")) {
        console.error(`[Proxy] ${versionErr.message}`);
        console.error("[Proxy] Automatically restarting daemon with current version...");

        socket.destroy();

        // 古いデーモンを停止
        await stopDaemon(options.databasePath);

        // 少し待ってから新しいデーモンを起動
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // 新しいデーモンを起動
        await startDaemon({
          repoRoot: options.repoRoot,
          databasePath: options.databasePath,
          socketPath: options.socketPath,
          watchMode: options.watchMode,
          allowDegrade: options.allowDegrade,
          securityConfigPath: options.securityConfigPath,
          securityLockPath: options.securityLockPath,
        });

        console.error("[Proxy] Daemon restarted successfully, reconnecting...");

        // 再接続を試みる
        const newSocket = await connectToDaemon(
          options.socketPath,
          options.maxRetries,
          options.retryDelayMs
        );

        // 再度バージョンチェック
        await checkDaemonVersion(newSocket);

        console.error("[Proxy] Connected to daemon. Bridging stdio ↔ socket...");

        // Stdio ↔ Socket ブリッジを確立
        bridgeStdioToSocket(newSocket);
        return;
      }
      throw versionError;
    }

    console.error("[Proxy] Connected to daemon. Bridging stdio ↔ socket...");

    // Stdio ↔ Socket ブリッジを確立
    bridgeStdioToSocket(socket);
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
