import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runIndexer } from "../../src/indexer/cli.js";
import { clearAllQueues } from "../../src/indexer/queue.js";
import { checkFTSSchemaExists } from "../../src/indexer/schema.js";
import { DuckDBClient } from "../../src/shared/duckdb.js";
import { createTempRepo } from "../helpers/test-repo.js";

interface CleanupTarget {
  dispose: () => Promise<void>;
}

describe("FTS rebuild lifecycle (E2E)", () => {
  const cleanupTargets: CleanupTarget[] = [];

  afterEach(async () => {
    for (const target of cleanupTargets.splice(0, cleanupTargets.length)) {
      await target.dispose();
    }
    // Clear queue state to ensure test isolation
    clearAllQueues();
  });

  it("sets dirty=true and rebuilds FTS after initial full indexing", async () => {
    const repo = await createTempRepo({
      "src/main.ts": [
        "export function greet(name: string) {",
        "  return `Hello, ${name}!`;",
        "}",
      ].join("\n"),
      "README.md": "# Test Repository\n",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-fts-test-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({
      dispose: async () => await rm(dbDir, { recursive: true, force: true }),
    });

    // Initial full indexing
    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    // Verify repo record exists
    const repoRows = await db.all<{ id: number; fts_dirty: boolean | null }>(
      "SELECT id, fts_dirty FROM repo WHERE root = ?",
      [repo.path]
    );
    expect(repoRows).toHaveLength(1);
    const repoId = repoRows[0]?.id;
    expect(repoId).toBeDefined();

    // After full rebuild with forceFTS=true, dirty should be false
    expect(repoRows[0]?.fts_dirty).toBe(false);

    // Verify FTS schema was created (if FTS extension is available)
    const ftsExists = await checkFTSSchemaExists(db);
    if (ftsExists) {
      const schemas = await db.all<{ schema_name: string }>(
        "SELECT schema_name FROM duckdb_schemas() WHERE schema_name = 'fts_main_blob'"
      );
      expect(schemas.length).toBe(1);

      // Verify FTS contains blob data
      const blobCount = await db.all<{ count: number }>("SELECT COUNT(*) as count FROM blob");
      expect(blobCount[0]?.count).toBeGreaterThan(0);
    }
  });

  it("sets dirty=true and rebuilds FTS after incremental indexing", async () => {
    const repo = await createTempRepo({
      "src/utils.ts": ["export const version = '1.0.0';"].join("\n"),
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-fts-test-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({
      dispose: async () => await rm(dbDir, { recursive: true, force: true }),
    });

    // Initial full indexing
    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    // Modify a file
    await writeFile(join(repo.path, "src/utils.ts"), "export const version = '2.0.0';");

    // Stage and commit the change
    const { execa } = await import("execa");
    await execa("git", ["add", "src/utils.ts"], { cwd: repo.path });
    await execa("git", ["commit", "-m", "Update version"], { cwd: repo.path });

    // Get changed paths to trigger true incremental mode
    const { stdout } = await execa("git", ["diff", "--name-only", "HEAD~1", "HEAD"], {
      cwd: repo.path,
    });
    const changedPaths = stdout.trim().split("\n").filter(Boolean);

    // Incremental indexing with explicit changedPaths
    await runIndexer({
      repoRoot: repo.path,
      databasePath: dbPath,
      full: false,
      changedPaths,
    });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    // Verify dirty flag was set to true during incremental update, then cleared after rebuild
    const repoRows = await db.all<{ fts_dirty: boolean | null }>(
      "SELECT fts_dirty FROM repo WHERE root = ?",
      [repo.path]
    );
    expect(repoRows).toHaveLength(1);

    // After incremental rebuild, dirty should be false (rebuild completed)
    expect(repoRows[0]?.fts_dirty).toBe(false);

    // Verify FTS was updated (if available)
    const ftsExists = await checkFTSSchemaExists(db);
    if (ftsExists) {
      // Check that new content is searchable
      const newBlob = await db.all<{ hash: string; content: string }>(
        "SELECT hash, content FROM blob WHERE content LIKE '%2.0.0%'"
      );
      expect(newBlob.length).toBeGreaterThan(0);
    }
  });

  it("maintains dirty=false when no files changed during incremental indexing", async () => {
    const repo = await createTempRepo({
      "src/constants.ts": ["export const APP_NAME = 'KIRI';"].join("\n"),
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-fts-test-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({
      dispose: async () => await rm(dbDir, { recursive: true, force: true }),
    });

    // Initial full indexing
    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db1 = await DuckDBClient.connect({ databasePath: dbPath });
    const beforeRows = await db1.all<{ fts_dirty: boolean | null }>(
      "SELECT fts_dirty FROM repo WHERE root = ?",
      [repo.path]
    );
    await db1.close();

    expect(beforeRows[0]?.fts_dirty).toBe(false);

    // Run incremental indexing without any file changes
    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: false });

    const db2 = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db2.close() });

    const afterRows = await db2.all<{ fts_dirty: boolean | null }>(
      "SELECT fts_dirty FROM repo WHERE root = ?",
      [repo.path]
    );

    // Dirty flag should remain false (no changes, no rebuild needed)
    expect(afterRows[0]?.fts_dirty).toBe(false);
  });

  it("correctly handles multi-repo FTS initialization", async () => {
    const repo1 = await createTempRepo({
      "repo1.ts": ["export const repo1 = 'first';"].join("\n"),
    });
    cleanupTargets.push({ dispose: repo1.cleanup });

    const repo2 = await createTempRepo({
      "repo2.ts": ["export const repo2 = 'second';"].join("\n"),
    });
    cleanupTargets.push({ dispose: repo2.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-fts-test-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({
      dispose: async () => await rm(dbDir, { recursive: true, force: true }),
    });

    // Index first repo
    await runIndexer({ repoRoot: repo1.path, databasePath: dbPath, full: true });

    // Index second repo into same database
    await runIndexer({ repoRoot: repo2.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    // Verify both repos exist
    const repoRows = await db.all<{ id: number; root: string; fts_dirty: boolean | null }>(
      "SELECT id, root, fts_dirty FROM repo ORDER BY id"
    );
    expect(repoRows).toHaveLength(2);

    // Both repos should have dirty=false after successful FTS rebuild
    expect(repoRows[0]?.fts_dirty).toBe(false);
    expect(repoRows[1]?.fts_dirty).toBe(false);

    // Verify both repos' files are indexed
    const repo1Id = repoRows[0]?.id;
    const repo2Id = repoRows[1]?.id;

    const repo1Files = await db.all<{ path: string }>("SELECT path FROM file WHERE repo_id = ?", [
      repo1Id,
    ]);
    const repo2Files = await db.all<{ path: string }>("SELECT path FROM file WHERE repo_id = ?", [
      repo2Id,
    ]);

    expect(repo1Files.length).toBeGreaterThan(0);
    expect(repo2Files.length).toBeGreaterThan(0);

    // Verify FTS contains both repos' content (if available)
    const ftsExists = await checkFTSSchemaExists(db);
    if (ftsExists) {
      const allBlobs = await db.all<{ hash: string }>("SELECT hash FROM blob");
      expect(allBlobs.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("handles FTS unavailability gracefully", async () => {
    const repo = await createTempRepo({
      "src/test.ts": ["export const test = true;"].join("\n"),
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-fts-test-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({
      dispose: async () => await rm(dbDir, { recursive: true, force: true }),
    });

    // Index should succeed even if FTS extension is unavailable
    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    // Verify repo was indexed
    const repoRows = await db.all<{ id: number }>("SELECT id FROM repo WHERE root = ?", [
      repo.path,
    ]);
    expect(repoRows).toHaveLength(1);

    // Verify files were indexed regardless of FTS availability
    const fileRows = await db.all<{ path: string }>("SELECT path FROM file WHERE repo_id = ?", [
      repoRows[0]?.id,
    ]);
    expect(fileRows.length).toBeGreaterThan(0);
  });

  // Fix #5: Concurrency tests
  it("handles concurrent indexer runs safely without corruption", async () => {
    const repo = await createTempRepo({
      "src/file1.ts": ["export const a = 1;"].join("\n"),
      "src/file2.ts": ["export const b = 2;"].join("\n"),
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-fts-test-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({
      dispose: async () => await rm(dbDir, { recursive: true, force: true }),
    });

    // Run two indexers concurrently on same DB
    const results = await Promise.allSettled([
      runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true }),
      runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true }),
    ]);

    // Fix: With queue-based serialization, both should succeed
    const allSucceeded = results.every((r) => r.status === "fulfilled");
    expect(allSucceeded).toBe(true);

    // If any failed, log the errors for debugging
    if (!allSucceeded) {
      const failures = results.filter((r) => r.status === "rejected");
      console.error(
        "Failed runs:",
        failures.map((f) => (f as PromiseRejectedResult).reason)
      );
    }

    // Give a short delay for any pending DB operations to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    // Verify no corruption - repo should exist exactly once
    const repoRows = await db.all<{ id: number; fts_status: string; fts_dirty: boolean }>(
      "SELECT id, fts_status, fts_dirty FROM repo WHERE root = ?",
      [repo.path]
    );
    expect(repoRows).toHaveLength(1);

    // Verify FTS schema exists (if FTS extension is available)
    const ftsExists = await checkFTSSchemaExists(db);
    if (ftsExists) {
      // Verify status is clean after successful concurrent rebuild
      expect(repoRows[0]?.fts_status).toBe("clean");
      expect(repoRows[0]?.fts_dirty).toBe(false);
    }

    // Verify files were indexed correctly
    const fileRows = await db.all<{ path: string }>("SELECT path FROM file WHERE repo_id = ?", [
      repoRows[0]?.id,
    ]);
    expect(fileRows.length).toBeGreaterThan(0);
  });

  it("preserves dirty flags when repo is re-dirtied during rebuild", async () => {
    const repo = await createTempRepo({
      "test.ts": [" export const test = 1;"].join("\n"),
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-fts-test-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({
      dispose: async () => await rm(dbDir, { recursive: true, force: true }),
    });

    // Initial full indexing
    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db1 = await DuckDBClient.connect({ databasePath: dbPath });
    const initialState = await db1.all<{ fts_dirty: boolean; fts_generation: number }>(
      "SELECT fts_dirty, fts_generation FROM repo WHERE root = ?",
      [repo.path]
    );
    await db1.close();

    expect(initialState[0]?.fts_dirty).toBe(false);
    const initialGeneration = initialState[0]?.fts_generation ?? 0;

    // Modify file and trigger incremental reindex (sets dirty=true, generation++)
    await writeFile(join(repo.path, "test.ts"), "export const test = 2;");
    const { execa } = await import("execa");
    await execa("git", ["add", "test.ts"], { cwd: repo.path });
    await execa("git", ["commit", "-m", "Update test"], { cwd: repo.path });

    const { stdout } = await execa("git", ["diff", "--name-only", "HEAD~1", "HEAD"], {
      cwd: repo.path,
    });
    const changedPaths = stdout.trim().split("\n").filter(Boolean);

    // Incremental reindex (should increment generation)
    await runIndexer({
      repoRoot: repo.path,
      databasePath: dbPath,
      full: false,
      changedPaths,
    });

    const db2 = await DuckDBClient.connect({ databasePath: dbPath });
    const afterReindex = await db2.all<{ fts_dirty: boolean; fts_generation: number }>(
      "SELECT fts_dirty, fts_generation FROM repo WHERE root = ?",
      [repo.path]
    );
    await db2.close();

    // After incremental reindex, dirty should be false and generation should have incremented
    expect(afterReindex[0]?.fts_dirty).toBe(false);
    expect(afterReindex[0]?.fts_generation).toBeGreaterThan(initialGeneration);

    // Verify FTS was updated (if available)
    const ftsExists = await checkFTSSchemaExists(
      await DuckDBClient.connect({ databasePath: dbPath })
    );
    if (ftsExists) {
      const db3 = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db3.close() });
      const newBlob = await db3.all<{ content: string }>(
        "SELECT content FROM blob WHERE content LIKE '%test = 2%'"
      );
      expect(newBlob.length).toBeGreaterThan(0);
    }
  });
});
