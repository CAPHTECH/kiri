/**
 * Daemon Lifecycle Management
 *
 * Handles PID file creation, idle timeout, health checks, and graceful shutdown.
 */

import * as fs from "fs/promises";
import * as path from "path";

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
        return false;
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
      } catch (err) {
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
    this.idleTimer = setTimeout(async () => {
      console.error(
        `[Daemon] Idle timeout (${this.idleTimeoutMinutes} minutes) reached. Shutting down...`
      );
      if (this.shutdownCallback) {
        await this.shutdownCallback();
      }
      process.exit(0);
    }, this.idleTimeoutMinutes * 60 * 1000);
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
   * ログファイルにメッセージを書き込む
   */
  async log(message: string): Promise<void> {
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} ${message}\n`;
    try {
      await fs.appendFile(this.logFilePath, logMessage, "utf-8");
    } catch (err) {
      console.error(`Failed to write to log file: ${err}`);
    }
  }
}
