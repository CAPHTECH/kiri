/**
 * FTS incremental rebuild tests for Issue #158
 *
 * 問題: インクリメンタルインデックスでblobテーブルに新しいレコードが追加された後、
 * FTSインデックスの再構築が実行されるが、新しいblobがFTS検索（match_bm25）に含まれない。
 * ILIKEでは見つかるがFTSでは見つからない。
 *
 * 原因: DuckDB FTSのWAL可視性問題
 * - PRAGMA create_fts_indexは実行時点のテーブルスナップショットを使用
 * - 直前のトランザクションでCOMMITされたデータがWALにあり、メインDBには未反映
 * - FTS PRAGMAがWALのデータを参照しないため、新しいblobを認識できない
 */

import { existsSync, unlinkSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runIndexer } from "../../src/indexer/cli.js";
import { clearAllQueues } from "../../src/indexer/queue.js";
import { checkFTSSchemaExists } from "../../src/indexer/schema.js";
import { IndexWatcher } from "../../src/indexer/watch.js";
import { DuckDBClient } from "../../src/shared/duckdb.js";
import { createTempRepo } from "../helpers/test-repo.js";

interface CleanupTarget {
  dispose: () => Promise<void>;
}

const waitForCondition = async (
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 10_000,
  intervalMs = 200
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
};

const waitForFtsResults = async (
  db: DuckDBClient,
  keyword: string,
  timeoutMs = 10_000,
  intervalMs = 200
): Promise<{ hash: string; score: number | null }[]> => {
  const deadline = Date.now() + timeoutMs;
  let results: { hash: string; score: number | null }[] = [];
  const query = `SELECT hash, fts_main_blob.match_bm25(hash, '${keyword}') AS score
       FROM blob
       WHERE score IS NOT NULL
       LIMIT 10`;
  while (Date.now() < deadline) {
    results = await db.all<{ hash: string; score: number | null }>(query);
    if (results.length > 0) {
      return results;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return results;
};

describe("FTS incremental rebuild (Issue #158)", () => {
  const cleanupTargets: CleanupTarget[] = [];

  afterEach(async () => {
    for (const target of cleanupTargets.splice(0, cleanupTargets.length)) {
      await target.dispose();
    }
    // Clear queue state to ensure test isolation
    clearAllQueues();
  });

  it("should find newly added blobs via FTS (match_bm25) after incremental indexing", async () => {
    // 1. 初期リポジトリ作成
    const repo = await createTempRepo({
      "src/initial.ts": ["export const initial = 'value';"].join("\n"),
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-fts-issue158-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({
      dispose: async () => await rm(dbDir, { recursive: true, force: true }),
    });

    // 2. 初期フルインデックス
    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    // 3. 新しいファイル追加（ユニークなキーワード "XYZUNIQUEKEYWORD158" を含む）
    await writeFile(
      join(repo.path, "src/newfile.ts"),
      "export const uniqueValue = 'XYZUNIQUEKEYWORD158';"
    );

    // Stage and commit the change
    const { execa } = await import("execa");
    await execa("git", ["add", "src/newfile.ts"], { cwd: repo.path });
    await execa("git", ["commit", "-m", "Add newfile with unique keyword"], { cwd: repo.path });

    // Get changed paths for incremental mode
    const { stdout } = await execa("git", ["diff", "--name-only", "HEAD~1", "HEAD"], {
      cwd: repo.path,
    });
    const changedPaths = stdout.trim().split("\n").filter(Boolean);

    // 4. インクリメンタルインデックス
    await runIndexer({
      repoRoot: repo.path,
      databasePath: dbPath,
      full: false,
      changedPaths,
    });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    // FTS拡張が利用可能か確認
    const ftsExists = await checkFTSSchemaExists(db);
    if (!ftsExists) {
      console.warn("FTS extension not available, skipping FTS-specific assertions");
      return;
    }

    // 5. ILIKEで見つかることを確認（これは動作するはず）
    const ilikeResults = await db.all<{ hash: string; content: string }>(
      "SELECT hash, content FROM blob WHERE content ILIKE '%XYZUNIQUEKEYWORD158%'"
    );
    expect(ilikeResults.length).toBeGreaterThan(0);

    // 6. FTS (match_bm25) で見つかることを確認（Issue #158の核心）
    await db.run("LOAD fts;");
    const ftsResults = await db.all<{ hash: string; score: number }>(
      `SELECT hash, fts_main_blob.match_bm25(hash, 'XYZUNIQUEKEYWORD158') AS score
       FROM blob
       WHERE score IS NOT NULL
       LIMIT 10`
    );

    // Issue #158: この expect が失敗する（現在の実装では FTS に新しい blob が含まれない）
    expect(ftsResults.length).toBeGreaterThan(0);
  });

  it("should find modified blob content via FTS (match_bm25) after incremental indexing", async () => {
    // 1. 初期リポジトリ作成
    const repo = await createTempRepo({
      "src/mutable.ts": ["export const version = '1.0.0';"].join("\n"),
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-fts-issue158-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({
      dispose: async () => await rm(dbDir, { recursive: true, force: true }),
    });

    // 2. 初期フルインデックス
    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    // 3. ファイル変更（新しいキーワード "ABCMODIFIEDKEYWORD158" を追加）
    await writeFile(
      join(repo.path, "src/mutable.ts"),
      "export const version = 'ABCMODIFIEDKEYWORD158';"
    );

    // Stage and commit the change
    const { execa } = await import("execa");
    await execa("git", ["add", "src/mutable.ts"], { cwd: repo.path });
    await execa("git", ["commit", "-m", "Modify file with new keyword"], { cwd: repo.path });

    // Get changed paths for incremental mode
    const { stdout } = await execa("git", ["diff", "--name-only", "HEAD~1", "HEAD"], {
      cwd: repo.path,
    });
    const changedPaths = stdout.trim().split("\n").filter(Boolean);

    // 4. インクリメンタルインデックス
    await runIndexer({
      repoRoot: repo.path,
      databasePath: dbPath,
      full: false,
      changedPaths,
    });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    // FTS拡張が利用可能か確認
    const ftsExists = await checkFTSSchemaExists(db);
    if (!ftsExists) {
      console.warn("FTS extension not available, skipping FTS-specific assertions");
      return;
    }

    // 5. ILIKEで見つかることを確認（これは動作するはず）
    const ilikeResults = await db.all<{ hash: string; content: string }>(
      "SELECT hash, content FROM blob WHERE content ILIKE '%ABCMODIFIEDKEYWORD158%'"
    );
    expect(ilikeResults.length).toBeGreaterThan(0);

    // 6. FTS (match_bm25) で見つかることを確認（Issue #158の核心）
    await db.run("LOAD fts;");
    const ftsResults = await db.all<{ hash: string; score: number }>(
      `SELECT hash, fts_main_blob.match_bm25(hash, 'ABCMODIFIEDKEYWORD158') AS score
       FROM blob
       WHERE score IS NOT NULL
       LIMIT 10`
    );

    // Issue #158: この expect が失敗する（現在の実装では FTS に変更後の blob が含まれない）
    expect(ftsResults.length).toBeGreaterThan(0);
  });
});

describe("FTS incremental rebuild via IndexWatcher (Issue #158)", () => {
  const cleanupTargets: CleanupTarget[] = [];

  afterEach(async () => {
    for (const target of cleanupTargets.splice(0, cleanupTargets.length)) {
      await target.dispose();
    }
    clearAllQueues();
  });

  it("should find newly added blobs via FTS after watch-triggered reindex", async () => {
    // 1. 初期リポジトリ作成
    const repo = await createTempRepo({
      "src/initial.ts": ["export const initial = 'value';"].join("\n"),
    });
    cleanupTargets.push({ dispose: repo.cleanup });
    const testId = Math.random().toString(36).substring(7);
    const dbDir = await mkdtemp(join(tmpdir(), `kiri-fts-watch-${testId}-`));
    const dbPath = join(dbDir, "index.duckdb");
    const lockPath = `${dbPath}.lock`;
    cleanupTargets.push({
      dispose: async () => {
        if (existsSync(lockPath)) {
          try {
            unlinkSync(lockPath);
          } catch {
            // Ignore if already removed
          }
        }
        await rm(dbDir, { recursive: true, force: true });
      },
    });

    // 2. 初期フルインデックス
    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    // 3. IndexWatcherを起動
    const abortController = new AbortController();
    const watcher = new IndexWatcher({
      repoRoot: repo.path,
      databasePath: dbPath,
      debounceMs: 100,
      signal: abortController.signal,
    });

    await watcher.start();
    cleanupTargets.push({
      dispose: async () => {
        abortController.abort();
        await watcher.stop();
      },
    });

    // 4. 新しいファイル追加（ユニークなキーワード "WATCHUNIQUE158" を含む）
    await writeFile(
      join(repo.path, "src/watched-file.ts"),
      "export const watchedValue = 'WATCHUNIQUE158';"
    );

    // 5. ファイルをgitにステージしてコミット（IndexWatcherはgit-tracked filesのみを処理）
    const { execa } = await import("execa");
    await execa("git", ["add", "src/watched-file.ts"], { cwd: repo.path });
    await execa("git", ["commit", "-m", "Add watched file"], { cwd: repo.path });

    // 6. Watcherがリインデックスを完了するまで待機
    // debounce (100ms) + reindex time + buffer
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const stats = watcher.getStatistics();
    expect(stats.reindexCount).toBeGreaterThanOrEqual(1);

    // 7. DB接続してFTS検索
    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    // FTS拡張が利用可能か確認
    const ftsExists = await checkFTSSchemaExists(db);
    if (!ftsExists) {
      console.warn("FTS extension not available, skipping FTS-specific assertions");
      return;
    }

    // 8. ILIKEで見つかることを確認
    const ilikeResults = await db.all<{ hash: string; content: string }>(
      "SELECT hash, content FROM blob WHERE content ILIKE '%WATCHUNIQUE158%'"
    );
    expect(ilikeResults.length).toBeGreaterThan(0);

    // 9. FTS (match_bm25) で見つかることを確認（Issue #158の核心）
    await db.run("LOAD fts;");
    const ftsResults = await db.all<{ hash: string; score: number }>(
      `SELECT hash, fts_main_blob.match_bm25(hash, 'WATCHUNIQUE158') AS score
       FROM blob
       WHERE score IS NOT NULL
       LIMIT 10`
    );

    // Issue #158: この expect が失敗する可能性がある
    expect(ftsResults.length).toBeGreaterThan(0);
  }, 30000); // 30秒タイムアウト

  /**
   * Issue #158の報告では、.featureファイル（Gherkin）が使用されていた。
   * 特定のファイル拡張子で問題が発生する可能性を確認するテスト。
   */
  it("should find newly added .feature files via FTS after watch-triggered reindex", async () => {
    // 1. 初期リポジトリ作成
    const repo = await createTempRepo({
      "src/initial.ts": ["export const initial = 'value';"].join("\n"),
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const { execa } = await import("execa");
    const fixturesDir = join(repo.path, "tests/fixtures");
    await mkdir(fixturesDir, { recursive: true });
    await writeFile(join(fixturesDir, ".gitkeep"), "");
    await execa("git", ["add", "tests/fixtures/.gitkeep"], { cwd: repo.path });
    await execa("git", ["commit", "-m", "Prepare fixtures directory"], { cwd: repo.path });

    const testId = Math.random().toString(36).substring(7);
    const dbDir = await mkdtemp(join(tmpdir(), `kiri-fts-gherkin-${testId}-`));
    const dbPath = join(dbDir, "index.duckdb");
    const lockPath = `${dbPath}.lock`;
    cleanupTargets.push({
      dispose: async () => {
        if (existsSync(lockPath)) {
          try {
            unlinkSync(lockPath);
          } catch {
            // Ignore if already removed
          }
        }
        await rm(dbDir, { recursive: true, force: true });
      },
    });

    // 2. 初期フルインデックス
    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    // 3. IndexWatcherを起動
    const abortController = new AbortController();
    const watcher = new IndexWatcher({
      repoRoot: repo.path,
      databasePath: dbPath,
      debounceMs: 100,
      signal: abortController.signal,
    });

    await watcher.start();
    cleanupTargets.push({
      dispose: async () => {
        abortController.abort();
        await watcher.stop();
      },
    });

    // 4. Gherkin .feature ファイル追加（Issue #158で報告された形式）
    const gherkinContent = `Feature: Test Feature GHERKINUNIQUE158
  Scenario: Test scenario
    Given a test condition
    When I perform an action
    Then I should see a result
`;
    await writeFile(join(repo.path, "tests/fixtures/test.feature"), gherkinContent);

    // 5. ファイルをgitにステージしてコミット
    await execa("git", ["add", "tests/fixtures/test.feature"], { cwd: repo.path });
    await execa("git", ["commit", "-m", "Add gherkin feature file"], { cwd: repo.path });

    // 6. Watcherがリインデックスを完了するまで待機
    await waitForCondition(() => watcher.getStatistics().reindexCount >= 1, 30_000);

    // 7. DB接続してFTS検索
    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    // FTS拡張が利用可能か確認
    const ftsExists = await checkFTSSchemaExists(db);
    if (!ftsExists) {
      console.warn("FTS extension not available, skipping FTS-specific assertions");
      return;
    }

    // 8. blobテーブルに存在することを確認
    const fetchBlobResults = async () =>
      db.all<{ hash: string; content: string }>(
        "SELECT hash, content FROM blob WHERE content LIKE '%GHERKINUNIQUE158%'"
      );
    await waitForCondition(async () => (await fetchBlobResults()).length > 0, 30_000);
    const blobResults = await fetchBlobResults();
    expect(blobResults.length).toBeGreaterThan(0);

    // 9. ILIKEで見つかることを確認
    const ilikeResults = await db.all<{ hash: string }>(
      "SELECT hash FROM blob WHERE content ILIKE '%GHERKINUNIQUE158%'"
    );
    expect(ilikeResults.length).toBeGreaterThan(0);

    // 10. FTS (match_bm25) で見つかることを確認
    await db.run("LOAD fts;");
    const ftsResults = await waitForFtsResults(db, "GHERKINUNIQUE158");

    // Issue #158: FTS検索で新規追加されたblobが見つかることを確認
    expect(ftsResults.length).toBeGreaterThan(0);
  }, 45000);
});
