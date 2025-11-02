/**
 * Tests for proxy client with automatic daemon restart on version mismatch
 */

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { stopDaemon } from "../../src/client/start-daemon.js";

// proxy.ts は直接インポートできないため、start-daemon の stopDaemon をテストして
// 自動再起動の基盤を確認する

describe("Proxy Daemon Restart", () => {
  let tmpDir: string;
  let databasePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kiri-proxy-test-"));
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

  describe("stopDaemon used by proxy for version mismatch recovery", () => {
    it("can stop daemon with stale PID file (simulating version mismatch scenario)", async () => {
      const pidFilePath = `${databasePath}.daemon.pid`;
      const startupLockPath = `${databasePath}.daemon.starting`;

      // シミュレーション: 古いバージョンのデーモンが残っている
      const stalePid = 999999;
      await fs.writeFile(pidFilePath, String(stalePid), "utf-8");
      await fs.writeFile(startupLockPath, String(stalePid), "utf-8");

      // stopDaemon が呼ばれると、スタイルPIDファイルをクリーンアップ
      await stopDaemon(databasePath);

      // ファイルが削除されていることを確認
      await expect(fs.access(pidFilePath)).rejects.toThrow();
      await expect(fs.access(startupLockPath)).rejects.toThrow();
    });

    it("handles missing PID file gracefully (already cleaned up)", async () => {
      // PIDファイルが存在しない場合もエラーにならないことを確認
      await expect(stopDaemon(databasePath)).resolves.not.toThrow();
    });
  });
});
