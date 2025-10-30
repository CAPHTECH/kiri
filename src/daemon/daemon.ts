#!/usr/bin/env node
/**
 * KIRI Daemon Main Process
 *
 * Single daemon per database, handles multiple client connections via Unix socket.
 * Manages DuckDB connection, watch mode, and graceful lifecycle.
 */

import { parseArgs } from "util";
import * as path from "path";
import { createServerRuntime } from "../server/runtime.js";
import { createRpcHandler } from "../server/rpc.js";
import { createSocketServer } from "./socket.js";
import { DaemonLifecycle } from "./lifecycle.js";
import type { ServerRuntime } from "../server/runtime.js";

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
 * CLI引数をパース
 */
function parseDaemonArgs(): DaemonOptions {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      db: { type: "string" },
      "socket-path": { type: "string" },
      watch: { type: "boolean", default: false },
      "daemon-timeout": { type: "string", default: "5" },
      "allow-degrade": { type: "boolean", default: false },
      "security-config": { type: "string" },
      "security-lock": { type: "string" },
    },
  });

  const repoRoot = path.resolve(values.repo || process.cwd());
  const databasePath = path.resolve(
    values.db || path.join(repoRoot, "var", "index.duckdb")
  );
  const socketPath = values["socket-path"]
    ? path.resolve(values["socket-path"])
    : `${databasePath}.sock`;

  return {
    repoRoot,
    databasePath,
    socketPath,
    watchMode: values.watch || false,
    idleTimeoutMinutes: parseInt(values["daemon-timeout"] || "5", 10),
    allowDegrade: values["allow-degrade"] || false,
    securityConfigPath: values["security-config"],
    securityLockPath: values["security-lock"],
  };
}

/**
 * メイン関数：デーモンプロセスを起動
 */
async function main() {
  const options = parseDaemonArgs();
  const lifecycle = new DaemonLifecycle(
    options.databasePath,
    options.idleTimeoutMinutes
  );

  try {
    // スタートアップロックを取得
    const lockAcquired = await lifecycle.acquireStartupLock();
    if (!lockAcquired) {
      console.error(
        "[Daemon] Another daemon is starting up. Exiting to avoid race condition."
      );
      process.exit(1);
    }

    await lifecycle.log(`Starting daemon for database: ${options.databasePath}`);

    // PIDファイルを作成
    await lifecycle.createPidFile();
    console.error(`[Daemon] PID: ${process.pid}`);

    // ServerRuntimeを作成（DuckDB接続、メトリクス、デグレード制御など）
    let runtime: ServerRuntime | null = null;
    try {
      const runtimeOptions: Parameters<typeof createServerRuntime>[0] = {
        repoRoot: options.repoRoot,
        databasePath: options.databasePath,
        allowDegrade: options.allowDegrade,
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

    // Unixソケットサーバーを作成
    const closeServer = await createSocketServer({
      socketPath: options.socketPath || `${options.databasePath}.sock`,
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

    await lifecycle.log(
      `Socket server listening on: ${options.socketPath || `${options.databasePath}.sock`}`
    );

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
