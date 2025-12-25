/**
 * Tests for daemon lifecycle management
 */

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DaemonLifecycle } from "../../src/daemon/lifecycle.js";

describe("DaemonLifecycle", () => {
  let tmpDir: string;
  let databasePath: string;
  let lifecycle: DaemonLifecycle;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kiri-lifecycle-test-"));
    databasePath = path.join(tmpDir, "test.duckdb");
    lifecycle = new DaemonLifecycle(databasePath, 0.1); // 0.1分 = 6秒のタイムアウト
  });

  afterEach(async () => {
    // クリーンアップ
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err) {
      // Ignore cleanup errors
    }
  });

  it("creates PID file with current process ID", async () => {
    await lifecycle.createPidFile();

    const pidFilePath = lifecycle.getPidFilePath();
    const content = await fs.readFile(pidFilePath, "utf-8");
    expect(parseInt(content.trim(), 10)).toBe(process.pid);
  });

  it("removes PID file successfully", async () => {
    await lifecycle.createPidFile();
    const pidFilePath = lifecycle.getPidFilePath();

    // PIDファイルが存在することを確認
    await fs.access(pidFilePath);

    await lifecycle.removePidFile();

    // PIDファイルが削除されたことを確認
    await expect(fs.access(pidFilePath)).rejects.toThrow();
  });

  it("acquires startup lock exclusively", async () => {
    const acquired1 = await lifecycle.acquireStartupLock();
    expect(acquired1).toBe(true);

    // 同じロックを再度取得しようとすると失敗する
    const acquired2 = await lifecycle.acquireStartupLock();
    expect(acquired2).toBe(false);

    await lifecycle.releaseStartupLock();
  });

  it("detects and removes stale startup lock (dead process)", async () => {
    const lockPath = lifecycle.getStartupLockPath();

    // 存在しないPIDでロックファイルを作成（stale lock をシミュレート）
    const nonExistentPid = 999999;
    await fs.writeFile(lockPath, String(nonExistentPid), "utf-8");

    // stale lockを検出して再取得できるはず
    const acquired = await lifecycle.acquireStartupLock();
    expect(acquired).toBe(true);

    // ロックファイルは現在のプロセスのPIDで更新されているはず
    const content = await fs.readFile(lockPath, "utf-8");
    expect(parseInt(content.trim(), 10)).toBe(process.pid);

    await lifecycle.releaseStartupLock();
  });

  it("does not remove lock held by running process", async () => {
    const lockPath = lifecycle.getStartupLockPath();

    // 現在のプロセスのPIDでロックファイルを作成（生きているプロセス）
    await fs.writeFile(lockPath, String(process.pid), "utf-8");

    // 別のlifecycleインスタンスで取得を試みる
    const lifecycle2 = new DaemonLifecycle(databasePath, 0.1);
    const acquired = await lifecycle2.acquireStartupLock();
    expect(acquired).toBe(false);

    // ロックファイルは元のPIDのまま
    const content = await fs.readFile(lockPath, "utf-8");
    expect(parseInt(content.trim(), 10)).toBe(process.pid);

    // クリーンアップ
    await fs.unlink(lockPath);
  });

  it("handles invalid PID in stale lock file", async () => {
    const lockPath = lifecycle.getStartupLockPath();

    // 無効なPIDでロックファイルを作成
    await fs.writeFile(lockPath, "invalid-pid", "utf-8");

    // 無効なPIDは安全のため取得失敗とする
    const acquired = await lifecycle.acquireStartupLock();
    expect(acquired).toBe(false);

    // クリーンアップ
    await fs.unlink(lockPath);
  });

  it("releases startup lock successfully", async () => {
    await lifecycle.acquireStartupLock();
    const lockPath = lifecycle.getStartupLockPath();

    // ロックファイルが存在することを確認
    await fs.access(lockPath);

    await lifecycle.releaseStartupLock();

    // ロックファイルが削除されたことを確認
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it("checkRunning returns PID for running daemon", async () => {
    await lifecycle.createPidFile();

    const pid = await lifecycle.checkRunning();
    expect(pid).toBe(process.pid);
  });

  it("checkRunning returns null for non-existent PID file", async () => {
    const pid = await lifecycle.checkRunning();
    expect(pid).toBeNull();
  });

  it("checkRunning returns null for stale PID file", async () => {
    const pidFilePath = lifecycle.getPidFilePath();

    // 存在しないPIDを書き込む
    const nonExistentPid = 999999;
    await fs.writeFile(pidFilePath, String(nonExistentPid), "utf-8");

    const pid = await lifecycle.checkRunning();
    expect(pid).toBeNull();
  });

  it("tracks active connections correctly", () => {
    lifecycle.incrementClients();
    lifecycle.incrementConnections();
    lifecycle.incrementConnections();
    expect(() => lifecycle.incrementConnections()).not.toThrow();

    lifecycle.decrementConnections();
    lifecycle.decrementConnections();
    lifecycle.decrementConnections();

    // 0未満にならないことを確認（内部的に）
    expect(() => lifecycle.decrementConnections()).not.toThrow();
  });

  it("watch mode disables idle timeout", async () => {
    const shutdownCallback = vi.fn();
    lifecycle.onShutdown(async () => {
      await shutdownCallback();
    });

    lifecycle.incrementClients();
    lifecycle.setWatchModeActive(true);

    // 接続が0になってもシャットダウンされないはず
    lifecycle.incrementConnections();
    lifecycle.decrementConnections();

    // 少し待機してもシャットダウンされないことを確認
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(shutdownCallback).not.toHaveBeenCalled();
  });

  it("watch mode still shuts down when no clients", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as (code?: string | number | null) => never);

    const shutdownCallback = vi.fn();
    lifecycle.onShutdown(async () => {
      await shutdownCallback();
    });

    lifecycle.setWatchModeActive(true);

    lifecycle.incrementConnections();
    lifecycle.decrementConnections();

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(shutdownCallback).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
  });

  it("idle timeout triggers shutdown when connections reach zero", async () => {
    // process.exit をモック
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as (code?: string | number | null) => never);

    const shutdownCallback = vi.fn();
    lifecycle.onShutdown(async () => {
      await shutdownCallback();
    });

    lifecycle.incrementClients();
    lifecycle.incrementConnections();
    lifecycle.decrementConnections();

    // タイムアウト（0.1分 = 6秒）より長く待機
    await new Promise((resolve) => setTimeout(resolve, 7000));

    expect(shutdownCallback).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);

    // モックをリストア
    exitSpy.mockRestore();
  }, 10000); // テストタイムアウトを10秒に設定

  it("writes log messages to log file", async () => {
    const logFilePath = lifecycle.getLogFilePath();

    await lifecycle.log("Test log message 1");
    await lifecycle.log("Test log message 2");

    const content = await fs.readFile(logFilePath, "utf-8");
    expect(content).toContain("Test log message 1");
    expect(content).toContain("Test log message 2");

    // ISO 8601形式のタイムスタンプが含まれることを確認
    expect(content).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("handles concurrent log writes", async () => {
    const logMessages = Array.from({ length: 10 }, (_, i) => `Log message ${i}`);

    await Promise.all(logMessages.map((msg) => lifecycle.log(msg)));

    const logFilePath = lifecycle.getLogFilePath();
    const content = await fs.readFile(logFilePath, "utf-8");

    logMessages.forEach((msg) => {
      expect(content).toContain(msg);
    });
  });

  it("graceful shutdown setup registers signal handlers", () => {
    const originalListeners = process.listenerCount("SIGTERM");
    lifecycle.setupGracefulShutdown();
    const newListeners = process.listenerCount("SIGTERM");

    expect(newListeners).toBeGreaterThan(originalListeners);
  });

  describe("zombie metrics", () => {
    it("initializes with zero values", () => {
      const metrics = lifecycle.getZombieMetrics();
      expect(metrics.detectedTotal).toBe(0);
      expect(metrics.cleanupSuccessTotal).toBe(0);
      expect(metrics.cleanupFailureTotal).toBe(0);
    });

    it("records zombie detection", () => {
      lifecycle.recordZombieDetected();
      lifecycle.recordZombieDetected();

      const metrics = lifecycle.getZombieMetrics();
      expect(metrics.detectedTotal).toBe(2);
    });

    it("records successful cleanup", () => {
      lifecycle.recordZombieCleanup(true);
      lifecycle.recordZombieCleanup(true);

      const metrics = lifecycle.getZombieMetrics();
      expect(metrics.cleanupSuccessTotal).toBe(2);
      expect(metrics.cleanupFailureTotal).toBe(0);
    });

    it("records failed cleanup", () => {
      lifecycle.recordZombieCleanup(false);

      const metrics = lifecycle.getZombieMetrics();
      expect(metrics.cleanupSuccessTotal).toBe(0);
      expect(metrics.cleanupFailureTotal).toBe(1);
    });

    it("tracks mixed cleanup results", () => {
      lifecycle.recordZombieDetected();
      lifecycle.recordZombieCleanup(true);
      lifecycle.recordZombieDetected();
      lifecycle.recordZombieCleanup(false);
      lifecycle.recordZombieDetected();
      lifecycle.recordZombieCleanup(true);

      const metrics = lifecycle.getZombieMetrics();
      expect(metrics.detectedTotal).toBe(3);
      expect(metrics.cleanupSuccessTotal).toBe(2);
      expect(metrics.cleanupFailureTotal).toBe(1);
    });

    it("returns snapshot that does not change when metrics are updated", () => {
      lifecycle.recordZombieDetected();
      const snapshot = lifecycle.getZombieMetrics();

      lifecycle.recordZombieDetected();
      lifecycle.recordZombieCleanup(true);

      // スナップショットは変更されない
      expect(snapshot.detectedTotal).toBe(1);
      expect(snapshot.cleanupSuccessTotal).toBe(0);

      // 新しいスナップショットは最新値
      const newSnapshot = lifecycle.getZombieMetrics();
      expect(newSnapshot.detectedTotal).toBe(2);
      expect(newSnapshot.cleanupSuccessTotal).toBe(1);
    });
  });
});
