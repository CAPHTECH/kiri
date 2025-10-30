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

    lifecycle.setWatchModeActive(true);

    // 接続が0になってもシャットダウンされないはず
    lifecycle.incrementConnections();
    lifecycle.decrementConnections();

    // 少し待機してもシャットダウンされないことを確認
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(shutdownCallback).not.toHaveBeenCalled();
  });

  it("idle timeout triggers shutdown when connections reach zero", async () => {
    // process.exit をモック
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as (code?: number) => never);

    const shutdownCallback = vi.fn();
    lifecycle.onShutdown(async () => {
      await shutdownCallback();
    });

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
});
