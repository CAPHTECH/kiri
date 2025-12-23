/**
 * Daemon Lifecycle Management
 *
 * Handles PID file creation, idle timeout, health checks, and graceful shutdown.
 */

import * as fs from "fs/promises";

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
 * PIDファイルとスタートアップロックを管理する
 */
export class DaemonLifecycle {
  private readonly pidFilePath: string;
  private readonly startupLockPath: string;
  private readonly logFilePath: string;
  private idleTimer: NodeJS.Timeout | null = null;
  private activeConnections = 0;
  private watchModeActive = false;
  private shutdownCallback?: () => Promise<void>;
  private readonly maxLogSizeBytes: number = 10 * 1024 * 1024; // 10MB
  private readonly maxLogBackups: number = 3;

  constructor(
    private readonly databasePath: string,
    private readonly idleTimeoutMinutes: number = 5
  ) {
    this.pidFilePath = `${databasePath}.daemon.pid`;
    this.startupLockPath = `${databasePath}.daemon.starting`;
    this.logFilePath = `${databasePath}.daemon.log`;
  }

  /**
   * PIDファイルパスを取得
   */
  getPidFilePath(): string {
    return this.pidFilePath;
  }

  /**
   * スタートアップロックファイルパスを取得
   */
  getStartupLockPath(): string {
    return this.startupLockPath;
  }

  /**
   * ログファイルパスを取得
   */
  getLogFilePath(): string {
    return this.logFilePath;
  }

  /**
   * スタートアップロックを取得（排他的作成）
   *
   * ロックファイルが存在しても、所有プロセスが死んでいればstale lockとして
   * 自動的にクリーンアップして再取得を試みる。
   *
   * @returns ロック取得に成功した場合はtrue、他のプロセスが既にロック中の場合はfalse
   */
  async acquireStartupLock(): Promise<boolean> {
    try {
      await fs.writeFile(this.startupLockPath, String(process.pid), {
        flag: "wx", // 排他的作成
      });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // ロックが stale（所有プロセスが死んでいる）かチェック
        try {
          const existingPidStr = await fs.readFile(this.startupLockPath, "utf-8");
          const existingPid = parseInt(existingPidStr.trim(), 10);

          if (!isNaN(existingPid) && !isProcessRunning(existingPid)) {
            // Stale lock 検出 - 削除前に再検証（TOCTOU対策）
            console.error(`[Daemon] Removing stale startup lock (PID ${existingPid} not running)`);

            // PIDが再利用されていないか再確認
            try {
              const recheckPidStr = await fs.readFile(this.startupLockPath, "utf-8");
              const recheckPid = parseInt(recheckPidStr.trim(), 10);

              // PIDが一致し、まだプロセスが死んでいる場合のみ削除
              if (
                !isNaN(recheckPid) &&
                recheckPid === existingPid &&
                !isProcessRunning(recheckPid)
              ) {
                await fs.unlink(this.startupLockPath);

                // 再取得を試みる
                try {
                  await fs.writeFile(this.startupLockPath, String(process.pid), {
                    flag: "wx",
                  });
                  return true;
                } catch (retryErr) {
                  // 再取得に失敗（他のプロセスが先に取得した）
                  if ((retryErr as NodeJS.ErrnoException).code === "EEXIST") {
                    return false;
                  }
                  throw retryErr;
                }
              }
            } catch (recheckErr) {
              // 再検証中にファイルが消えた（他のプロセスが処理した）
              if ((recheckErr as NodeJS.ErrnoException).code === "ENOENT") {
                // 消えたので再取得を試みる
                try {
                  await fs.writeFile(this.startupLockPath, String(process.pid), {
                    flag: "wx",
                  });
                  return true;
                } catch (retryErr) {
                  if ((retryErr as NodeJS.ErrnoException).code === "EEXIST") {
                    return false;
                  }
                  throw retryErr;
                }
              }
              throw recheckErr;
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
            await fs.writeFile(this.startupLockPath, String(process.pid), {
              flag: "wx",
            });
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
   */
  async releaseStartupLock(): Promise<void> {
    try {
      await fs.unlink(this.startupLockPath);
    } catch (err) {
      // ファイルが存在しない場合は無視
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`Failed to release startup lock: ${err}`);
      }
    }
  }

  /**
   * PIDファイルを作成
   */
  async createPidFile(): Promise<void> {
    await fs.writeFile(this.pidFilePath, String(process.pid), "utf-8");
  }

  /**
   * PIDファイルを削除
   */
  async removePidFile(): Promise<void> {
    try {
      await fs.unlink(this.pidFilePath);
    } catch (err) {
      // ファイルが存在しない場合は無視
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`Failed to remove PID file: ${err}`);
      }
    }
  }

  /**
   * デーモンが実行中かチェック（PIDファイルとプロセスの存在確認）
   *
   * @returns デーモンが実行中の場合はPID、それ以外はnull
   */
  async checkRunning(): Promise<number | null> {
    try {
      const pidStr = await fs.readFile(this.pidFilePath, "utf-8");
      const pid = parseInt(pidStr.trim(), 10);

      // プロセスが実際に存在するかチェック
      try {
        process.kill(pid, 0); // シグナル0は存在チェック
        return pid;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (_err) {
        // プロセスが存在しない場合、PIDファイルは古い
        return null;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  /**
   * ウォッチモードの状態を設定
   */
  setWatchModeActive(active: boolean): void {
    this.watchModeActive = active;
    if (active) {
      // ウォッチモードが有効な場合、アイドルタイマーをキャンセル
      this.resetIdleTimer();
    }
  }

  /**
   * アクティブ接続数を増やす
   */
  incrementConnections(): void {
    this.activeConnections++;
    this.resetIdleTimer();
  }

  /**
   * アクティブ接続数を減らす
   */
  decrementConnections(): void {
    this.activeConnections = Math.max(0, this.activeConnections - 1);
    if (this.activeConnections === 0) {
      this.startIdleTimer();
    }
  }

  /**
   * シャットダウンコールバックを登録
   */
  onShutdown(callback: () => Promise<void>): void {
    this.shutdownCallback = callback;
  }

  /**
   * アイドルタイマーをリセット
   */
  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /**
   * アイドルタイマーを開始
   *
   * ウォッチモードが有効でなく、タイムアウトが0でない場合のみ開始
   */
  private startIdleTimer(): void {
    if (this.watchModeActive || this.idleTimeoutMinutes === 0) {
      return;
    }

    this.resetIdleTimer();
    this.idleTimer = setTimeout(
      async () => {
        // タイマー発火時に再度チェック（レースコンディション対策）
        if (this.activeConnections === 0 && !this.watchModeActive) {
          console.error(
            `[Daemon] Idle timeout (${this.idleTimeoutMinutes} minutes) reached. Shutting down...`
          );
          if (this.shutdownCallback) {
            await this.shutdownCallback();
          }
          process.exit(0);
        }
      },
      this.idleTimeoutMinutes * 60 * 1000
    );
  }

  /**
   * グレースフルシャットダウンを設定
   */
  setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      console.error(`[Daemon] Received ${signal}. Shutting down gracefully...`);

      this.resetIdleTimer();

      if (this.shutdownCallback) {
        await this.shutdownCallback();
      }

      await this.removePidFile();
      await this.releaseStartupLock();

      process.exit(0);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  }

  /**
   * ログファイルをローテーション
   *
   * ファイルサイズが maxLogSizeBytes を超えた場合、古いログをバックアップして新しいログを開始
   */
  private async rotateLogIfNeeded(): Promise<void> {
    try {
      const stats = await fs.stat(this.logFilePath);
      if (stats.size < this.maxLogSizeBytes) {
        return; // ローテーション不要
      }

      // 既存のバックアップをシフト (.log.3 -> .log.4 は削除, .log.2 -> .log.3, etc.)
      for (let i = this.maxLogBackups; i > 0; i--) {
        const oldBackup = `${this.logFilePath}.${i}`;
        const newBackup = `${this.logFilePath}.${i + 1}`;
        try {
          await fs.access(oldBackup);
          if (i === this.maxLogBackups) {
            // 最古のバックアップは削除
            await fs.unlink(oldBackup);
          } else {
            // バックアップをリネーム
            await fs.rename(oldBackup, newBackup);
          }
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (_err) {
          // ファイルが存在しない場合は無視
        }
      }

      // 現在のログファイルを .log.1 にリネーム
      await fs.rename(this.logFilePath, `${this.logFilePath}.1`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`Failed to rotate log file: ${err}`);
      }
    }
  }

  /**
   * ログファイルにメッセージを書き込む
   *
   * ファイルサイズが制限を超えた場合、自動的にローテーションを実行
   */
  async log(message: string): Promise<void> {
    // ローテーションチェック（非同期だがログ書き込みはブロックしない）
    this.rotateLogIfNeeded().catch((err) => {
      console.error(`Log rotation failed: ${err}`);
    });

    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} ${message}\n`;
    try {
      await fs.appendFile(this.logFilePath, logMessage, "utf-8");
    } catch (err) {
      console.error(`Failed to write to log file: ${err}`);
    }
  }
}
