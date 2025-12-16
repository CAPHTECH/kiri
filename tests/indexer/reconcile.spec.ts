/**
 * reconcileDeletedFiles関数のテスト
 * Issue #157: untrackedファイルが誤って削除されないことを確認
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { runIndexer } from "../../src/indexer/cli.js";
import { DuckDBClient } from "../../src/shared/duckdb.js";
import { createTempRepo } from "../helpers/test-repo.js";

const execFileAsync = promisify(execFile);

interface CleanupTarget {
  dispose: () => Promise<void>;
}

describe("reconcileDeletedFiles", () => {
  const cleanupTargets: CleanupTarget[] = [];

  afterEach(async () => {
    for (const target of cleanupTargets.splice(0, cleanupTargets.length)) {
      await target.dispose();
    }
  });

  it("does not delete untracked files during incremental indexing", async () => {
    // Step 1: tracked ファイルでリポジトリを作成してインデックス
    const repo = await createTempRepo({
      "tracked.ts": "export const tracked = true;",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({
      dispose: async () => await rm(dbDir, { recursive: true, force: true }),
    });

    // フルインデックス
    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    // Step 2: untracked ファイルを追加
    const untrackedPath = join(repo.path, "untracked.ts");
    await writeFile(untrackedPath, "export const untracked = true;");

    // Step 3: インクリメンタルインデックスでuntracked ファイルを追加
    await runIndexer({
      repoRoot: repo.path,
      databasePath: dbPath,
      full: false,
      changedPaths: ["untracked.ts"],
    });

    // Step 4: DB を確認 - untracked ファイルがインデックスに存在
    let db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    let files = await db.all<{ path: string }>(
      "SELECT path FROM file WHERE repo_id = 1 ORDER BY path"
    );
    expect(files.map((f) => f.path)).toContain("untracked.ts");

    await db.close();

    // Step 5: 別のファイルを変更して再度インクリメンタルインデックス
    await writeFile(join(repo.path, "tracked.ts"), "export const tracked = 'modified';");
    await execFileAsync("git", ["add", "tracked.ts"], { cwd: repo.path });

    await runIndexer({
      repoRoot: repo.path,
      databasePath: dbPath,
      full: false,
      changedPaths: ["tracked.ts"],
    });

    // Step 6: untracked ファイルがまだインデックスに存在することを確認（Fix #157）
    db = await DuckDBClient.connect({ databasePath: dbPath });
    files = await db.all<{ path: string }>("SELECT path FROM file WHERE repo_id = 1 ORDER BY path");

    expect(files.map((f) => f.path)).toContain("tracked.ts");
    expect(files.map((f) => f.path)).toContain("untracked.ts");
  });

  it("excludes changedPaths from deletion", async () => {
    // Step 1: tracked ファイルでリポジトリを作成してインデックス
    const repo = await createTempRepo({
      "tracked.ts": "export const tracked = true;",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({
      dispose: async () => await rm(dbDir, { recursive: true, force: true }),
    });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    // Step 2: untracked ファイルを追加してインクリメンタルインデックス
    await writeFile(join(repo.path, "new-file.ts"), "export const newFile = true;");

    // changedPaths に含まれるファイルは excludePaths として扱われる
    await runIndexer({
      repoRoot: repo.path,
      databasePath: dbPath,
      full: false,
      changedPaths: ["new-file.ts"],
    });

    // Step 3: ファイルがインデックスに追加されていることを確認
    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const files = await db.all<{ path: string }>(
      "SELECT path FROM file WHERE repo_id = 1 ORDER BY path"
    );
    expect(files.map((f) => f.path)).toContain("new-file.ts");
  });

  it("deletes files that were git-removed", async () => {
    // Step 1: 複数の tracked ファイルでリポジトリを作成してインデックス
    const repo = await createTempRepo({
      "keep.ts": "export const keep = true;",
      "remove.ts": "export const remove = true;",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({
      dispose: async () => await rm(dbDir, { recursive: true, force: true }),
    });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    // Step 2: git rm でファイルを削除
    await execFileAsync("git", ["rm", "remove.ts"], { cwd: repo.path });
    await execFileAsync("git", ["commit", "-m", "remove file"], { cwd: repo.path });

    // Step 3: インクリメンタルインデックス（変更されたファイルなし）
    await runIndexer({
      repoRoot: repo.path,
      databasePath: dbPath,
      full: false,
      changedPaths: [],
    });

    // Step 4: remove.ts がインデックスから削除されていることを確認
    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const files = await db.all<{ path: string }>(
      "SELECT path FROM file WHERE repo_id = 1 ORDER BY path"
    );
    expect(files.map((f) => f.path)).toContain("keep.ts");
    expect(files.map((f) => f.path)).not.toContain("remove.ts");
  });
});
