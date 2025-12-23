#!/usr/bin/env node
/**
 * KIRI Daemon Main Process
 *
 * Single daemon per database, handles multiple client connections via Unix socket.
 * Manages DuckDB connection, watch mode, and graceful lifecycle.
 */

import * as path from "path";

import packageJson from "../../package.json" with { type: "json" };
import { IndexWatcher } from "../indexer/watch.js";
import { ensureDatabaseIndexed } from "../server/indexBootstrap.js";
import { createRpcHandler } from "../server/rpc.js";
import { createServerRuntime } from "../server/runtime.js";
import type { ServerRuntime } from "../server/runtime.js";
import { defineCli, type CliSpec } from "../shared/cli/args.js";
import { getSocketPath } from "../shared/utils/socket.js";
import { parsePositiveInt } from "../shared/utils/validation.js";

import { DaemonLifecycle } from "./lifecycle.js";
import { createSocketServer } from "./socket.js";
import {
  detectAndCleanupZombie,
  extractPidFromLockError,
  isDuckDBLockConflictError,
} from "./zombie-detector.js";

/**
 * デーモン設定オプション
 */
interface DaemonOptions {
  repoRoot: string;
  databasePath: string;
  socketPath?: string | undefined;
  watchMode: boolean;
  debounceMs: number;
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
          description: "Database file path (default: var/index.duckdb relative to --repo)",
          placeholder: "<path>",
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
    debounceMs: parsePositiveInt(values.debounce as string | undefined, 500, "debounce delay"),
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
    // ゾンビdaemonによるDuckDBロック競合時は、ゾンビ検出・クリーンアップ後にリトライ
    let runtime: ServerRuntime | null = null;
    let watcher: IndexWatcher | null = null;
    const MAX_RUNTIME_RETRY_ATTEMPTS = 2;
    const socketPath =
      options.socketPath || getSocketPath(options.databasePath, { ensureDir: true });

    for (let attempt = 0; attempt < MAX_RUNTIME_RETRY_ATTEMPTS; attempt++) {
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
        break; // 成功
      } catch (err) {
        const error = err as Error;

        // DuckDBロック競合エラーの場合、ゾンビ検出・クリーンアップを試みる
        if (isDuckDBLockConflictError(error) && attempt < MAX_RUNTIME_RETRY_ATTEMPTS - 1) {
          const conflictingPid = extractPidFromLockError(error.message);

          if (conflictingPid !== null) {
            await lifecycle.log(
              `DuckDB lock conflict detected (PID ${conflictingPid}). Checking for zombie...`
            );

            const cleaned = await detectAndCleanupZombie(conflictingPid, socketPath);

            if (cleaned) {
              await lifecycle.log(`Zombie daemon cleaned up. Retrying...`);
              // DuckDBがロックを解放するのを待つ
              await new Promise((resolve) => setTimeout(resolve, 1000));
              continue; // リトライ
            }

            // 正常動作中のdaemonがいる場合
            await lifecycle.log(`Another daemon is running normally. Exiting.`);
          }
        }

        // リトライ不可またはリトライ失敗
        await lifecycle.log(`Failed to create runtime: ${error.message}`);
        console.error(`[Daemon] Failed to create runtime: ${error.message}`);
        await lifecycle.removePidFile();
        await lifecycle.releaseStartupLock();
        process.exit(1);
      }
    }

    // ウォッチモードの設定（自動インクリメンタル再インデックス）
    // 注意: watch modeの起動に失敗してもデーモン自体は継続起動する
    if (options.watchMode) {
      lifecycle.setWatchModeActive(true);
      await lifecycle.log("Watch mode enabled (daemon will not auto-stop)");
      console.error("[Daemon] Watch mode enabled (daemon will not auto-stop)");

      watcher = new IndexWatcher({
        repoRoot: options.repoRoot,
        databasePath: options.databasePath,
        debounceMs: options.debounceMs,
      });

      try {
        await watcher.start();
      } catch (watchError) {
        // Watch modeの起動失敗は致命的エラーではない
        // デーモンは継続起動し、検索機能は正常に動作する
        // 自動再インデックスのみが無効になる
        const errorMessage = watchError instanceof Error ? watchError.message : String(watchError);
        await lifecycle.log(`Watch mode failed to start: ${errorMessage}`);
        console.error(`[Daemon] ⚠️  Watch mode disabled due to error: ${errorMessage}`);
        console.error(`[Daemon] Daemon will continue without automatic re-indexing.`);
        console.error(
          `[Daemon] To fix: increase file descriptor limit (ulimit -n 65536) or reduce watched files.`
        );
        watcher = null;
        lifecycle.setWatchModeActive(false);
      }
    }

    // RPCハンドラを作成（既存のロジックを再利用）
    // Note: runtimeはリトライループで必ず初期化されるか、初期化失敗時はprocess.exit(1)で終了する
    const rpcHandler = createRpcHandler(runtime!);

    // ソケットサーバーを作成（プラットフォームに応じてUnixソケットまたはWindows名前付きパイプ）
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

    // グレースフルシャットダウンの設定
    lifecycle.onShutdown(async () => {
      await lifecycle.log("Shutting down daemon...");
      if (watcher) {
        console.error("[Daemon] Stopping watch mode...");
        await watcher.stop().catch(() => {
          /* ignore */
        });
      }
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
