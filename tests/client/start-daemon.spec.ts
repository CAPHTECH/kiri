/**
 * Tests for daemon starter utility
 */

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isDaemonRunning } from "../../src/client/start-daemon.js";

describe("Daemon Starter", () => {
  let tmpDir: string;
  let databasePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kiri-starter-test-"));
    databasePath = path.join(tmpDir, "test.duckdb");
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

  describe("isDaemonRunning", () => {
    it("returns false when no PID file exists", async () => {
      const running = await isDaemonRunning(databasePath);
      expect(running).toBe(false);
    });

    it("returns false when PID file contains stale PID", async () => {
      const pidFilePath = `${databasePath}.daemon.pid`;

      // 存在しないPIDを書き込む
      const nonExistentPid = 999999;
      await fs.writeFile(pidFilePath, String(nonExistentPid), "utf-8");

      const running = await isDaemonRunning(databasePath);
      expect(running).toBe(false);

      // PIDファイルは残っていることを確認（積極的なクリーンアップは行わない）
      await fs.access(pidFilePath); // Should not throw
    });

    it("returns false when daemon process exists but socket is not responsive", async () => {
      const pidFilePath = `${databasePath}.daemon.pid`;

      // 現在のプロセスのPIDを書き込む（ソケットは存在しない）
      await fs.writeFile(pidFilePath, String(process.pid), "utf-8");

      const running = await isDaemonRunning(databasePath);
      expect(running).toBe(false);

      // PIDファイルは残っていることを確認（デーモン起動中の可能性があるため）
      await fs.access(pidFilePath); // Should not throw
    });

    it("does not clean up stale files to avoid race conditions", async () => {
      const pidFilePath = `${databasePath}.daemon.pid`;
      const socketPath = `${databasePath}.sock`;

      // 存在しないPIDとソケットファイルを作成
      await fs.writeFile(pidFilePath, "999999", "utf-8");
      await fs.writeFile(socketPath, "", "utf-8"); // ダミーソケット

      const running = await isDaemonRunning(databasePath);
      expect(running).toBe(false);

      // ファイルは残っていることを確認（デーモン自身がクリーンアップを担当）
      await fs.access(pidFilePath); // Should not throw
      await fs.access(socketPath); // Should not throw
    });

    it("preserves startup lock file to avoid interfering with daemon startup", async () => {
      const pidFilePath = `${databasePath}.daemon.pid`;
      const startupLockPath = `${databasePath}.daemon.starting`;

      // 存在しないPIDとスタートアップロックを作成
      await fs.writeFile(pidFilePath, "999999", "utf-8");
      await fs.writeFile(startupLockPath, "999999", "utf-8");

      const running = await isDaemonRunning(databasePath);
      expect(running).toBe(false);

      // ファイルは残っていることを確認（起動中のデーモンを妨害しないため）
      await fs.access(pidFilePath); // Should not throw
      await fs.access(startupLockPath); // Should not throw
    });
  });
});
