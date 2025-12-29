/**
 * Daemon Starter Utility
 *
 * Responsible for spawning daemon process in detached mode and waiting for readiness.
 */

import { spawn } from "child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import * as fs from "fs/promises";
import * as net from "net";
import * as path from "path";
import { fileURLToPath } from "url";

import { getSocketPath } from "../shared/utils/socket.js";

/**
 * 指定したPIDのプロセスが存在するかチェック
 *
 * @param pid - チェックするプロセスID
 * @returns プロセスが存在する場合はtrue
 */
function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    // シグナル0はプロセスを停止せず、存在チェックのみ
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCHはプロセスが存在しないことを意味
    return false;
  }
}

/**
 * スタートアップロックを取得（排他的作成）
 *
 * ロックファイルが存在しても、所有プロセスが死んでいればstale lockとして
 * 自動的にクリーンアップして再取得を試みる。
 *
 * @param startupLockPath - スタートアップロックファイルのパス
 * @returns ロック取得に成功した場合はtrue、他のプロセスが既にロック中の場合はfalse
 */
function tryAcquireStartupLock(startupLockPath: string): boolean {
  try {
    writeFileSync(startupLockPath, String(process.pid), { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // ロックが stale（所有プロセスが死んでいる）かチェック
      try {
        const existingPidStr = readFileSync(startupLockPath, "utf-8");
        const existingPid = parseInt(existingPidStr.trim(), 10);

        if (!isNaN(existingPid) && !isProcessRunning(existingPid)) {
          // Stale lock 検出 - 削除前に再検証（TOCTOU対策）
          console.error(
            `[StartDaemon] Removing stale startup lock (PID ${existingPid} not running)`
          );

          // PIDが再利用されていないか再確認
          if (existsSync(startupLockPath)) {
            const recheckPidStr = readFileSync(startupLockPath, "utf-8");
            const recheckPid = parseInt(recheckPidStr.trim(), 10);

            // PIDが一致し、まだプロセスが死んでいる場合のみ削除
            if (!isNaN(recheckPid) && recheckPid === existingPid && !isProcessRunning(recheckPid)) {
              unlinkSync(startupLockPath);

              // 再取得を試みる
              try {
                writeFileSync(startupLockPath, String(process.pid), { flag: "wx" });
                return true;
              } catch (retryErr) {
                // 再取得に失敗（他のプロセスが先に取得した）
                if ((retryErr as NodeJS.ErrnoException).code === "EEXIST") {
                  return false;
                }
                throw retryErr;
              }
            }
          }
        }
        // 生きているプロセスがロックを保持している
        return false;
      } catch (readErr) {
        // ロックファイルを読めない場合は安全のため取得失敗とする
        if ((readErr as NodeJS.ErrnoException).code !== "ENOENT") {
          return false;
        }
        // ENOENTの場合、ファイルが消えたので再取得を試みる
        try {
          writeFileSync(startupLockPath, String(process.pid), { flag: "wx" });
          return true;
        } catch (retryErr) {
          if ((retryErr as NodeJS.ErrnoException).code === "EEXIST") {
            return false;
          }
          throw retryErr;
        }
      }
    }
    throw err;
  }
}

/**
 * スタートアップロックを解放
 *
 * @param startupLockPath - スタートアップロックファイルのパス
 */
function releaseStartupLock(startupLockPath: string): void {
  try {
    if (existsSync(startupLockPath)) {
      unlinkSync(startupLockPath);
    }
  } catch (err) {
    // ファイルが存在しない場合は無視
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[StartDaemon] Failed to release startup lock: ${err}`);
    }
  }
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
 * LAW-002: Exclusive Startup
 * - スタートアップロック取得者のみがデーモンをspawnできる
 * - ロック取得失敗時は既存デーモンの起動完了を待つ
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

  // スタートアップロックパス（lifecycle.tsと同じパスを使用）
  const startupLockPath = `${databasePath}.daemon.starting`;

  // スタートアップロックを取得
  const lockAcquired = tryAcquireStartupLock(startupLockPath);

  if (!lockAcquired) {
    // 別のプロセスがデーモンを起動中 - 既存デーモンの起動完了を待つ
    console.error(
      "[StartDaemon] Another process is starting daemon, waiting for it to become ready..."
    );
    await waitForDaemonReady(socketPath, readyTimeoutMs);
    return;
  }

  // ロックを取得できた場合のみデーモンを起動
  try {
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

    // データベースの親ディレクトリを自動作成（.kiri/ などが存在しない場合）
    const dbDir = path.dirname(databasePath);
    await fs.mkdir(dbDir, { recursive: true });

    // デーモンログファイル
    const logFilePath = `${databasePath}.daemon.log`;
    const logFile = await fs.open(logFilePath, "a");

    // デタッチモードでデーモンを起動
    const daemon = spawn(process.execPath, [daemonScriptPath, ...args], {
      detached: true,
      stdio: ["ignore", logFile.fd, logFile.fd],
    });

    daemon.unref(); // 親プロセスがデーモンの終了を待たない

    console.error(`[StartDaemon] Spawned daemon process (PID: ${daemon.pid})`);
    console.error(`[StartDaemon] Daemon log: ${logFilePath}`);

    // ソケットが準備完了するまで待つ（既定で240秒、環境変数で調整可能）
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
        console.error("[StartDaemon] Daemon is ready");
        await logFile.close();
        return;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (_err) {
        // まだ準備できていない、再試行
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    }

    // タイムアウト
    await logFile.close();
    throw new Error(
      `Daemon did not become ready within ${Math.round(effectiveTimeoutMs / 1000)} seconds. Check log: ${logFilePath}`
    );
  } finally {
    // スタートアップロックを解放（成功/失敗に関わらず）
    releaseStartupLock(startupLockPath);
  }
}

/**
 * デーモンが準備完了するまで待つ
 *
 * 別プロセスがデーモンを起動中の場合に使用
 *
 * @param socketPath - ソケットパス
 * @param readyTimeoutMs - タイムアウト（ミリ秒）
 */
async function waitForDaemonReady(socketPath: string, readyTimeoutMs?: number): Promise<void> {
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
      console.error("[StartDaemon] Daemon (started by another process) is ready");
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
