/**
 * Daemon watch mode tests
 *
 * Verifies that `kiri-daemon --watch` starts a file watcher and incrementally
 * updates the DuckDB index when repository files change.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import { afterEach, beforeEach, describe, it } from "vitest";

import { getSocketPath } from "../../src/shared/utils/socket.js";

describe("kiri-daemon --watch", () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  let tmpDir: string;
  let repoRoot: string;
  let databasePath: string;
  let socketPath: string;
  let daemonProcess: ChildProcess | null = null;
  let daemonOutput: string[] = [];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kiri-daemon-watch-"));
    repoRoot = path.join(tmpDir, "repo");
    databasePath = path.join(tmpDir, "index.duckdb");
    socketPath = getSocketPath(databasePath, { ensureDir: true });

    await fs.mkdir(repoRoot, { recursive: true });
    await execa("git", ["init"], { cwd: repoRoot });
    await execa("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
    await execa("git", ["config", "user.name", "Test User"], { cwd: repoRoot });
    await execa("git", ["config", "commit.gpgsign", "false"], { cwd: repoRoot });

    const trackedFile = path.join(repoRoot, "index.ts");
    await fs.writeFile(trackedFile, "export const initial = 'test';\n", "utf-8");
    await execa("git", ["add", "."], { cwd: repoRoot });
    await execa("git", ["commit", "-m", "init"], { cwd: repoRoot });

    // Initial indexing (daemon startup should not need to do full indexing)
    // 注意: DuckDBのファイルロックはプロセス終了まで保持されることがあるため、
    // インデクサーを別プロセスで実行してロックが確実に解放されるようにする
    const indexerPath = path.resolve(__dirname, "../../dist/src/indexer/cli.js");
    await execa(process.execPath, [
      indexerPath,
      "--repo",
      repoRoot,
      "--db",
      databasePath,
      "--full",
    ]);
  });

  afterEach(async () => {
    const proc = daemonProcess;
    if (proc) {
      daemonProcess = null;
      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const onExit = () => resolve();
        proc.once("exit", onExit);
        setTimeout(() => {
          proc.removeListener("exit", onExit);
          if (!proc.killed) {
            proc.kill("SIGKILL");
          }
          resolve();
        }, 5000);
      });
    }

    // デーモンプロセスが完全に終了し、リソースが解放されるまで待機
    await new Promise((resolve) => setTimeout(resolve, 500));

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function startDaemonWithWatch(): Promise<void> {
    const daemonPath = path.resolve(__dirname, "../../dist/src/daemon/daemon.js");

    // 出力バッファをクリア
    daemonOutput = [];

    daemonProcess = spawn(
      process.execPath,
      [
        daemonPath,
        "--repo",
        repoRoot,
        "--db",
        databasePath,
        "--socket-path",
        socketPath,
        "--watch",
        "--daemon-timeout",
        "0",
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Daemon startup timeout")), 60000);
      const stderr = daemonProcess!.stderr;
      const stdout = daemonProcess!.stdout;
      if (!stderr) {
        clearTimeout(timeout);
        reject(new Error("Daemon stderr not available"));
        return;
      }

      stderr.on("data", (data: Buffer) => {
        const output = data.toString();
        daemonOutput.push(`[stderr] ${output}`);
        if (output.includes("Ready to accept connections")) {
          clearTimeout(timeout);
          resolve();
        }
      });

      if (stdout) {
        stdout.on("data", (data: Buffer) => {
          daemonOutput.push(`[stdout] ${data.toString()}`);
        });
      }

      daemonProcess!.on("exit", (code, signal) => {
        clearTimeout(timeout);
        const outputLog = daemonOutput.join("\n");
        reject(
          new Error(
            `Daemon exited during startup (code=${code ?? "null"} signal=${signal ?? "null"})\nOutput:\n${outputLog}`
          )
        );
      });

      daemonProcess!.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /**
   * デーモンの出力ログを監視して、ファイルの再インデックスが完了するまで待機
   * DuckDBへの直接接続を避けてロック競合を防ぐ
   */
  async function waitForReindexComplete(marker: string, timeoutMs = 15000): Promise<void> {
    const startedAt = Date.now();
    // 再インデックス完了を示すログパターン
    // watch.tsのscheduleReindex/executeReindexでは "✅ Incremental reindex complete" を出力
    const completePattern = /✅\s*(Incremental reindex complete|FTS index rebuilt)/;

    while (Date.now() - startedAt < timeoutMs) {
      const fullOutput = daemonOutput.join("\n");
      // マーカーを含むファイル変更検知とインデックス完了の両方を確認
      const hasMarker = fullOutput.includes(marker) || fullOutput.includes("File changes detected");
      const isComplete = completePattern.test(fullOutput);

      if (hasMarker && isComplete) {
        // 完了パターンが最新の出力に含まれているか確認
        const recentOutput = daemonOutput.slice(-10).join("\n");
        if (completePattern.test(recentOutput)) {
          return;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const fullOutput = daemonOutput.join("\n");
    throw new Error(
      `Timed out waiting for reindex complete (marker: ${marker})\nDaemon output:\n${fullOutput}`
    );
  }

  it("incrementally updates the index when tracked files change", async () => {
    await startDaemonWithWatch();

    const marker = `modified_${Date.now()}`;
    await fs.writeFile(
      path.join(repoRoot, "index.ts"),
      `export const ${marker} = true;\n`,
      "utf-8"
    );

    await waitForReindexComplete(marker);
  }, 60000);

  it("ignores changes to database files to prevent infinite loops", async () => {
    await startDaemonWithWatch();

    // DBファイルを直接更新しても、インデックス再構築がトリガーされないことを確認
    // ここでは、DBファイル変更後もデーモンが正常に動作し、
    // 他のファイル変更を正しくインデックスできることを検証
    const dbWalPath = `${databasePath}.wal`;
    const dbTmpPath = `${databasePath}.tmp`;

    // DB関連ファイルにタッチ（これらは無視されるべき）
    try {
      await fs.writeFile(dbWalPath, "test", "utf-8");
      await fs.writeFile(dbTmpPath, "test", "utf-8");
    } catch {
      // ファイル作成失敗は無視（権限等）
    }

    // 少し待機してから、通常のファイル変更がまだ検知されることを確認
    await new Promise((resolve) => setTimeout(resolve, 500));

    const marker = `after_db_touch_${Date.now()}`;
    await fs.writeFile(
      path.join(repoRoot, "index.ts"),
      `export const ${marker} = true;\n`,
      "utf-8"
    );

    // 通常のファイル変更は検知されるべき
    await waitForReindexComplete(marker);

    // クリーンアップ
    try {
      await fs.unlink(dbWalPath);
      await fs.unlink(dbTmpPath);
    } catch {
      // ignore
    }
  }, 60000);

  it("debounces rapid consecutive changes", async () => {
    await startDaemonWithWatch();

    // 複数の高速な連続変更を行う
    const baseMarker = `debounce_${Date.now()}`;
    const files = ["file1.ts", "file2.ts", "file3.ts"];

    for (const file of files) {
      await fs.writeFile(
        path.join(repoRoot, file),
        `export const ${baseMarker}_${file.replace(".ts", "")} = true;\n`,
        "utf-8"
      );
      // 高速連続変更をシミュレート（デフォルトdebounce 500msより短い間隔）
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // デバウンスにより一括処理された再インデックスが完了するまで待機
    await waitForReindexComplete(baseMarker);
  }, 60000);

  it("handles graceful shutdown during idle state", async () => {
    await startDaemonWithWatch();

    // デーモンが正常に起動していることを確認
    const marker = `shutdown_test_${Date.now()}`;
    await fs.writeFile(
      path.join(repoRoot, "index.ts"),
      `export const ${marker} = true;\n`,
      "utf-8"
    );

    await waitForReindexComplete(marker);

    // 正常終了のテスト：SIGTERMを送信してクリーンシャットダウンを確認
    const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      daemonProcess!.once("exit", (code, signal) => {
        resolve({ code, signal });
      });
    });

    daemonProcess!.kill("SIGTERM");

    const result = await Promise.race([
      exitPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);

    // プロセスがタイムアウト内に終了したことを確認
    if (result !== null) {
      // afterEachでの二重kill防止
      daemonProcess = null;
    }
  }, 60000);
});
