#!/usr/bin/env node
/**
 * KIRI Daemon Main Process
 *
 * Single daemon per database, handles multiple client connections via Unix socket.
 * Manages DuckDB connection, watch mode, and graceful lifecycle.
 */

import * as path from "path";

import packageJson from "../../package.json" with { type: "json" };
import { ensureDatabaseIndexed } from "../server/indexBootstrap.js";
import { createRpcHandler } from "../server/rpc.js";
import { createServerRuntime } from "../server/runtime.js";
import type { ServerRuntime } from "../server/runtime.js";
import { defineCli, type CliSpec } from "../shared/cli/args.js";
import { getSocketPath } from "../shared/utils/socket.js";
import { parsePositiveInt } from "../shared/utils/validation.js";

import { DaemonLifecycle } from "./lifecycle.js";
import { createSocketServer } from "./socket.js";

/**
 * デーモン設定オプション
 */
interface DaemonOptions {
  repoRoot: string;
  databasePath: string;
  socketPath?: string | undefined;
  watchMode: boolean;
  idleTimeoutMinutes: number;
  allowDegrade: boolean;
  securityConfigPath?: string | undefined;
  securityLockPath?: string | undefined;
}

/**
 * CLI specification for kiri-daemon
 */
const DAEMON_CLI_SPEC: CliSpec = {
  commandName: "kiri-daemon",
  description: "KIRI Daemon Process - Manages DuckDB connection and handles client requests",
  version: packageJson.version,
  usage: "kiri-daemon [options]",
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
      title: "Daemon Lifecycle",
      options: [
        {
          flag: "socket-path",
          type: "string",
          description: "Unix socket path for daemon connection",
          placeholder: "<path>",
        },
        {
          flag: "daemon-timeout",
          type: "string",
          description: "Idle timeout in minutes before daemon auto-shutdown",
          placeholder: "<minutes>",
          default: "5",
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
    "kiri-daemon --repo /path/to/repo --db /path/to/index.duckdb",
    "kiri-daemon --watch --daemon-timeout 10",
    "kiri-daemon --socket-path /tmp/kiri.sock",
  ],
};

/**
 * CLI引数をパース
 */
function parseDaemonArgs(): DaemonOptions {
  const { values } = defineCli(DAEMON_CLI_SPEC);

  const repoRoot = path.resolve((values.repo as string | undefined) || process.cwd());
  const databasePath = path.resolve(
    (values.db as string | undefined) || path.join(repoRoot, "var", "index.duckdb")
  );
  const socketPath = values["socket-path"]
    ? path.resolve(values["socket-path"] as string)
    : getSocketPath(databasePath, { ensureDir: true });

  return {
    repoRoot,
    databasePath,
    socketPath,
    watchMode: (values.watch as boolean) || false,
    idleTimeoutMinutes: parsePositiveInt(
      values["daemon-timeout"] as string | undefined,
      5,
      "daemon timeout (minutes)"
    ),
    allowDegrade: (values["allow-degrade"] as boolean) || false,
    securityConfigPath: values["security-config"] as string | undefined,
    securityLockPath: values["security-lock"] as string | undefined,
  };
}

/**
 * メイン関数：デーモンプロセスを起動
 */
async function main() {
  const options = parseDaemonArgs();
  const lifecycle = new DaemonLifecycle(options.databasePath, options.idleTimeoutMinutes);

  try {
    // スタートアップロックを取得
    const lockAcquired = await lifecycle.acquireStartupLock();
    if (!lockAcquired) {
      console.error("[Daemon] Another daemon is starting up. Exiting to avoid race condition.");
      process.exit(1);
    }

    await lifecycle.log(`Starting daemon for database: ${options.databasePath}`);

    // PIDファイルを作成
    await lifecycle.createPidFile();
    console.error(`[Daemon] PID: ${process.pid}`);

    // データベースが存在しない場合、自動的にインデックスを作成
    await ensureDatabaseIndexed(
      options.repoRoot,
      options.databasePath,
      options.allowDegrade,
      false
    );

    // ServerRuntimeを作成（DuckDB接続、メトリクス、デグレード制御など）
    let runtime: ServerRuntime | null = null;
    try {
      const runtimeOptions: Parameters<typeof createServerRuntime>[0] = {
        repoRoot: options.repoRoot,
        databasePath: options.databasePath,
        allowDegrade: options.allowDegrade,
        allowWriteLock: true, // Daemon mode should auto-create security lock
      };

      if (options.securityConfigPath) {
        runtimeOptions.securityConfigPath = options.securityConfigPath;
      }
      if (options.securityLockPath) {
        runtimeOptions.securityLockPath = options.securityLockPath;
      }

      runtime = await createServerRuntime(runtimeOptions);

      await lifecycle.log(`Runtime initialized for repo: ${options.repoRoot}`);
    } catch (err) {
      const error = err as Error;
      await lifecycle.log(`Failed to create runtime: ${error.message}`);
      console.error(`[Daemon] Failed to create runtime: ${error.message}`);
      await lifecycle.removePidFile();
      await lifecycle.releaseStartupLock();
      process.exit(1);
    }

    // RPCハンドラを作成（既存のロジックを再利用）
    const rpcHandler = createRpcHandler(runtime);

    // ソケットサーバーを作成（プラットフォームに応じてUnixソケットまたはWindows名前付きパイプ）
    const socketPath =
      options.socketPath || getSocketPath(options.databasePath, { ensureDir: true });
    const closeServer = await createSocketServer({
      socketPath,
      onRequest: async (request) => {
        lifecycle.incrementConnections();
        try {
          return await rpcHandler(request);
        } finally {
          lifecycle.decrementConnections();
        }
      },
      onError: async (error) => {
        await lifecycle.log(`Connection error: ${error.message}`);
        console.error(`[Daemon] Connection error: ${error.message}`);
      },
    });

    await lifecycle.log(`Socket server listening on: ${socketPath}`);

    // スタートアップロックを解放（起動完了）
    await lifecycle.releaseStartupLock();

    // ウォッチモードの設定
    if (options.watchMode) {
      lifecycle.setWatchModeActive(true);
      await lifecycle.log("Watch mode enabled (daemon will not auto-stop)");
      console.error("[Daemon] Watch mode enabled (daemon will not auto-stop)");
      // TODO: IndexWatcherの統合
    }

    // グレースフルシャットダウンの設定
    lifecycle.onShutdown(async () => {
      await lifecycle.log("Shutting down daemon...");
      console.error("[Daemon] Closing server...");
      await closeServer();
      console.error("[Daemon] Closing runtime...");
      if (runtime) {
        await runtime.close();
      }
    });

    lifecycle.setupGracefulShutdown();

    await lifecycle.log("Daemon started successfully");
    console.error("[Daemon] Ready to accept connections");
  } catch (err) {
    const error = err as Error;
    await lifecycle.log(`Fatal error: ${error.message}`);
    console.error(`[Daemon] Fatal error: ${error.message}`);
    await lifecycle.removePidFile();
    await lifecycle.releaseStartupLock();
    process.exit(1);
  }
}

// エントリーポイント
main().catch(async (err) => {
  console.error(`[Daemon] Unhandled error: ${err}`);
  process.exit(1);
});
