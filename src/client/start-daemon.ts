/**
 * Daemon Starter Utility
 *
 * Responsible for spawning daemon process in detached mode and waiting for readiness.
 *
 * NOTE: スタートアップロックは daemon 側 (src/daemon/lifecycle.ts) のみが管理する。
 * proxy 側でロックを取得すると、spawnされた daemon がロック取得に失敗して終了する。
 */

import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as net from "net";
import * as path from "path";
import { fileURLToPath } from "url";

import { getSocketPath } from "../shared/utils/socket.js";

/**
 * ソケットが準備完了するまでポーリング
 *
 * startDaemonとwaitForDaemonReadyで共通のポーリングロジック
 *
 * @param socketPath - ソケットパス
 * @param readyTimeoutMs - タイムアウト（ミリ秒、未指定時は環境変数または240秒）
 * @param successMessage - 成功時に出力するメッセージ
 */
async function pollSocketReady(
  socketPath: string,
  readyTimeoutMs: number | undefined,
  successMessage: string
): Promise<void> {
  const envTimeoutSeconds = process.env.KIRI_DAEMON_READY_TIMEOUT
    ? Number.parseFloat(process.env.KIRI_DAEMON_READY_TIMEOUT)
    : undefined;
  const effectiveTimeoutMs =
    readyTimeoutMs ??
    (Number.isFinite(envTimeoutSeconds) && envTimeoutSeconds! > 0
      ? envTimeoutSeconds! * 1000
      : 240_000);
  const pollIntervalMs = 500;
  const maxAttempts = Math.max(1, Math.ceil(effectiveTimeoutMs / pollIntervalMs));

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // ソケット接続を試みる
      const socket = net.connect(socketPath);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          socket.destroy();
          reject(new Error("Socket connection timeout"));
        }, pollIntervalMs);

        socket.on("connect", () => {
          clearTimeout(timeout);
          socket.end();
          resolve();
        });

        socket.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      // 接続成功
      console.error(successMessage);
      return;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err) {
      // まだ準備できていない、再試行
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  // タイムアウト
  throw new Error(
    `Daemon did not become ready within ${Math.round(effectiveTimeoutMs / 1000)} seconds.`
  );
}

/**
 * デーモン起動オプション
 */
export interface StartDaemonOptions {
  repoRoot: string;
  databasePath: string;
  socketPath: string;
  watchMode: boolean;
  debounceMs?: number | undefined;
  allowDegrade: boolean;
  securityConfigPath?: string | undefined;
  securityLockPath?: string | undefined;
  readyTimeoutMs?: number | undefined;
}

/**
 * デーモンが実行中かチェック
 *
 * PIDファイルの存在とプロセスの存在、ソケット接続可能性を確認
 *
 * @param databasePath - データベースパス（PIDファイルのパス導出に使用）
 * @param customSocketPath - カスタムソケットパス（指定された場合はデフォルトを上書き）
 */
export async function isDaemonRunning(
  databasePath: string,
  customSocketPath?: string
): Promise<boolean> {
  const pidFilePath = `${databasePath}.daemon.pid`;
  const socketPath = customSocketPath ?? getSocketPath(databasePath);

  try {
    // PIDファイルが存在するかチェック
    const pidStr = await fs.readFile(pidFilePath, "utf-8");
    const pid = parseInt(pidStr.trim(), 10);

    // プロセスが実際に存在するかチェック
    try {
      process.kill(pid, 0); // シグナル0は存在チェック
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err) {
      // プロセスが存在しない場合、PIDファイルは古い
      // Note: クリーンアップは意図的に行わない（デーモン起動中の競合を防ぐため）
      console.error("[StartDaemon] Stale PID file detected");
      return false;
    }

    // ソケットに接続してpingヘルスチェックを実行
    try {
      const socket = net.connect(socketPath);

      const healthCheck = await new Promise<boolean>((resolve, reject) => {
        const timeout = setTimeout(() => {
          socket.destroy();
          reject(new Error("Health check timeout"));
        }, 2000);

        let responseReceived = false;

        socket.on("connect", () => {
          // pingリクエストを送信
          const pingRequest = {
            jsonrpc: "2.0",
            id: 1,
            method: "ping",
          };
          socket.write(JSON.stringify(pingRequest) + "\n");
        });

        socket.on("data", (data) => {
          if (responseReceived) return;

          try {
            const response = JSON.parse(data.toString().trim());
            // 正常なpingレスポンスを確認
            if (response.result && response.result.status === "ok") {
              responseReceived = true;
              clearTimeout(timeout);
              socket.end();
              resolve(true);
            } else {
              clearTimeout(timeout);
              socket.destroy();
              reject(new Error("Invalid ping response"));
            }
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
          } catch (_parseErr) {
            clearTimeout(timeout);
            socket.destroy();
            reject(new Error("Failed to parse health check response"));
          }
        });

        socket.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      return healthCheck;
    } catch (err) {
      // ソケット接続失敗またはヘルスチェック失敗（起動中の可能性もあるため、クリーンアップは行わない）
      console.error(
        `[StartDaemon] Daemon health check failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

/**
 * デーモンプロセスを停止
 *
 * PIDファイルから読み取り、グレースフルシャットダウンを試みる
 */
export async function stopDaemon(databasePath: string): Promise<void> {
  const pidFilePath = `${databasePath}.daemon.pid`;
  const startupLockPath = `${databasePath}.daemon.starting`;

  try {
    const pidStr = await fs.readFile(pidFilePath, "utf-8");
    const pid = parseInt(pidStr.trim(), 10);

    // プロセスが存在するかチェック
    try {
      process.kill(pid, 0);
    } catch {
      // プロセスが存在しない場合はクリーンアップのみ
      console.error("[StopDaemon] Process not found, cleaning up files");
      await fs.unlink(pidFilePath).catch(() => {
        // ファイルが存在しない場合は無視
      });
      await fs.unlink(startupLockPath).catch(() => {
        // ファイルが存在しない場合は無視
      });
      return;
    }

    // SIGTERM でグレースフルシャットダウン
    console.error(`[StopDaemon] Stopping daemon (PID: ${pid})...`);
    process.kill(pid, "SIGTERM");

    // 最大5秒待機してから強制終了
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        process.kill(pid, 0);
      } catch {
        // プロセスが終了した
        console.error("[StopDaemon] Daemon stopped gracefully");
        await fs.unlink(pidFilePath).catch(() => {});
        await fs.unlink(startupLockPath).catch(() => {});
        return;
      }
    }

    // タイムアウトした場合は強制終了
    console.error("[StopDaemon] Force killing daemon...");
    process.kill(pid, "SIGKILL");
    await fs.unlink(pidFilePath).catch(() => {});
    await fs.unlink(startupLockPath).catch(() => {});
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // PIDファイルが存在しない場合は何もしない
      return;
    }
    throw err;
  }
}

/**
 * デーモンプロセスを起動
 *
 * デタッチモードで起動し、ソケットが準備完了するまで待つ。
 * スタートアップロックにより、同時に複数のプロセスがデーモンを起動することを防ぐ。
 *
 * LAW-001: Single Daemon Invariant
 * - 同一データベースパスに対して、常に最大1つのデーモンのみが存在する
 *
 * LAW-002: Exclusive Startup (daemon側で強制)
 * - daemon側がスタートアップロックを管理する (src/daemon/lifecycle.ts)
 * - 複数のproxyが同時にdaemonをspawnしても、1つだけが正常起動する
 */
export async function startDaemon(options: StartDaemonOptions): Promise<void> {
  const {
    repoRoot,
    databasePath,
    socketPath,
    watchMode,
    debounceMs,
    allowDegrade,
    securityConfigPath,
    securityLockPath,
    readyTimeoutMs,
  } = options;

  // データベースの親ディレクトリを自動作成
  const dbDir = path.dirname(databasePath);
  await fs.mkdir(dbDir, { recursive: true });

  // デーモン実行ファイルのパスを解決
  // 開発時: src/daemon/daemon.ts, ビルド後: dist/src/daemon/daemon.js
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const daemonScriptPath = path.resolve(__dirname, "../daemon/daemon.js");

  // デーモン起動引数
  const args = ["--repo", repoRoot, "--db", databasePath, "--socket-path", socketPath];

  if (watchMode) {
    args.push("--watch");
    if (debounceMs !== undefined) {
      args.push("--debounce", String(debounceMs));
    }
  }

  if (allowDegrade) {
    args.push("--allow-degrade");
  }

  if (securityConfigPath) {
    args.push("--security-config", securityConfigPath);
  }

  if (securityLockPath) {
    args.push("--security-lock", securityLockPath);
  }

  // デーモンログファイル
  const logFilePath = `${databasePath}.daemon.log`;
  let logFile: fs.FileHandle | undefined;

  try {
    logFile = await fs.open(logFilePath, "a");

    // デタッチモードでデーモンを起動
    const daemon = spawn(process.execPath, [daemonScriptPath, ...args], {
      detached: true,
      stdio: ["ignore", logFile.fd, logFile.fd],
    });

    daemon.unref(); // 親プロセスがデーモンの終了を待たない

    console.error(`[StartDaemon] Spawned daemon process (PID: ${daemon.pid})`);
    console.error(`[StartDaemon] Daemon log: ${logFilePath}`);

    // ソケットが準備完了するまで待つ
    await pollSocketReady(socketPath, readyTimeoutMs, "[StartDaemon] Daemon is ready");
  } finally {
    // logFileハンドルを必ず閉じる
    if (logFile) {
      await logFile.close().catch(() => {});
    }
  }
}
