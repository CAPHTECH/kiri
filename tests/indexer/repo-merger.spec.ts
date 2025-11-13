import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { mergeRepoRecords } from "../../src/indexer/migrations/repo-merger.js";
import { DuckDBClient } from "../../src/shared/duckdb.js";

describe("mergeRepoRecords", () => {
  it("migrates all dependent rows before deleting legacy repos", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "kiri-merger-"));
    const dbPath = join(tempDir, "test.duckdb");
    const db = await DuckDBClient.connect({ databasePath: dbPath });

    try {
      // Setup: Create minimal schema
      await db.run(`CREATE TABLE repo (id INTEGER PRIMARY KEY, root TEXT)`);
      await db.run(`CREATE TABLE file (repo_id INTEGER, path TEXT PRIMARY KEY)`);
      await db.run(
        `CREATE TABLE symbol (repo_id INTEGER, path TEXT, name TEXT, PRIMARY KEY (repo_id, path, name))`
      );

      // Insert test data: 3 repos with dependent data
      await db.run(
        `INSERT INTO repo (id, root) VALUES (1, '/repo1'), (2, '/repo2'), (3, '/repo3')`
      );
      await db.run(`INSERT INTO file (repo_id, path) VALUES (1, 'a.ts'), (2, 'b.ts'), (3, 'c.ts')`);
      await db.run(
        `INSERT INTO symbol (repo_id, path, name) VALUES (1, 'a.ts', 'foo'), (2, 'b.ts', 'bar'), (3, 'c.ts', 'baz')`
      );

      // Execute: Merge repos 2 and 3 into repo 1
      await mergeRepoRecords(db, 1, [2, 3]);

      // Verify: Repos 2 and 3 are deleted
      const repos = await db.all<{ id: number }>("SELECT id FROM repo ORDER BY id");
      expect(repos).toEqual([{ id: 1 }]);

      // Verify: All file records now reference repo_id=1
      const files = await db.all<{ repo_id: number; path: string }>(
        "SELECT repo_id, path FROM file ORDER BY path"
      );
      expect(files).toEqual([
        { repo_id: 1, path: "a.ts" },
        { repo_id: 1, path: "b.ts" },
        { repo_id: 1, path: "c.ts" },
      ]);

      // Verify: All symbol records now reference repo_id=1
      const symbols = await db.all<{ repo_id: number; name: string }>(
        "SELECT repo_id, name FROM symbol ORDER BY name"
      );
      expect(symbols).toEqual([
        { repo_id: 1, name: "bar" },
        { repo_id: 1, name: "baz" },
        { repo_id: 1, name: "foo" },
      ]);
    } finally {
      await db.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("handles empty legacyRepoIds array gracefully", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "kiri-merger-"));
    const dbPath = join(tempDir, "test.duckdb");
    const db = await DuckDBClient.connect({ databasePath: dbPath });

    try {
      await db.run(`CREATE TABLE repo (id INTEGER PRIMARY KEY, root TEXT)`);
      await db.run(`INSERT INTO repo (id, root) VALUES (1, '/repo1')`);

      // Should not throw
      await mergeRepoRecords(db, 1, []);

      const repos = await db.all<{ id: number }>("SELECT id FROM repo");
      expect(repos).toEqual([{ id: 1 }]);
    } finally {
      await db.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("works with multiple dependent tables", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "kiri-merger-"));
    const dbPath = join(tempDir, "test.duckdb");
    const db = await DuckDBClient.connect({ databasePath: dbPath });

    try {
      // Create schema with many dependent tables
      await db.run(`CREATE TABLE repo (id INTEGER PRIMARY KEY, root TEXT)`);
      await db.run(`CREATE TABLE file (repo_id INTEGER, path TEXT PRIMARY KEY)`);
      await db.run(
        `CREATE TABLE tree (repo_id INTEGER, commit_hash TEXT, path TEXT, PRIMARY KEY (repo_id, commit_hash, path))`
      );
      await db.run(
        `CREATE TABLE symbol (repo_id INTEGER, path TEXT, symbol_id INTEGER, PRIMARY KEY (repo_id, path, symbol_id))`
      );
      await db.run(
        `CREATE TABLE snippet (repo_id INTEGER, path TEXT, snippet_id INTEGER, PRIMARY KEY (repo_id, path, snippet_id))`
      );
      await db.run(
        `CREATE TABLE dependency (repo_id INTEGER, src_path TEXT, dst TEXT, PRIMARY KEY (repo_id, src_path, dst))`
      );

      // Insert data across all tables
      await db.run(`INSERT INTO repo (id, root) VALUES (1, '/repo1'), (2, '/repo2')`);
      await db.run(`INSERT INTO file (repo_id, path) VALUES (1, 'a.ts'), (2, 'b.ts')`);
      await db.run(
        `INSERT INTO tree (repo_id, commit_hash, path) VALUES (1, 'abc', 'a.ts'), (2, 'def', 'b.ts')`
      );
      await db.run(
        `INSERT INTO symbol (repo_id, path, symbol_id) VALUES (1, 'a.ts', 1), (2, 'b.ts', 2)`
      );
      await db.run(
        `INSERT INTO snippet (repo_id, path, snippet_id) VALUES (1, 'a.ts', 1), (2, 'b.ts', 2)`
      );
      await db.run(
        `INSERT INTO dependency (repo_id, src_path, dst) VALUES (1, 'a.ts', 'b'), (2, 'b.ts', 'c')`
      );

      // Merge repo 2 into repo 1
      await mergeRepoRecords(db, 1, [2]);

      // Verify all tables updated
      const fileCount = await db.all<{ count: bigint }>(
        "SELECT COUNT(*) as count FROM file WHERE repo_id = 1"
      );
      expect(Number(fileCount[0]?.count)).toBe(2);

      const treeCount = await db.all<{ count: bigint }>(
        "SELECT COUNT(*) as count FROM tree WHERE repo_id = 1"
      );
      expect(Number(treeCount[0]?.count)).toBe(2);

      const symbolCount = await db.all<{ count: bigint }>(
        "SELECT COUNT(*) as count FROM symbol WHERE repo_id = 1"
      );
      expect(Number(symbolCount[0]?.count)).toBe(2);

      const snippetCount = await db.all<{ count: bigint }>(
        "SELECT COUNT(*) as count FROM snippet WHERE repo_id = 1"
      );
      expect(Number(snippetCount[0]?.count)).toBe(2);

      const depCount = await db.all<{ count: bigint }>(
        "SELECT COUNT(*) as count FROM dependency WHERE repo_id = 1"
      );
      expect(Number(depCount[0]?.count)).toBe(2);

      // Verify repo 2 deleted
      const repos = await db.all<{ id: number }>("SELECT id FROM repo");
      expect(repos).toEqual([{ id: 1 }]);
    } finally {
      await db.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rolls back on error", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "kiri-merger-"));
    const dbPath = join(tempDir, "test.duckdb");
    const db = await DuckDBClient.connect({ databasePath: dbPath });

    try {
      await db.run(`CREATE TABLE repo (id INTEGER PRIMARY KEY, root TEXT)`);
      await db.run(`INSERT INTO repo (id, root) VALUES (1, '/repo1'), (2, '/repo2')`);

      // Try to merge with non-existent canonical ID
      await expect(mergeRepoRecords(db, 999, [2])).rejects.toThrow();

      // Verify: Repo 2 still exists (transaction rolled back)
      const repos = await db.all<{ id: number }>("SELECT id FROM repo ORDER BY id");
      expect(repos).toEqual([{ id: 1 }, { id: 2 }]);
    } finally {
      await db.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("prevents orphaned records compared to naive DELETE", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "kiri-merger-"));
    const dbPath = join(tempDir, "test.duckdb");
    const db = await DuckDBClient.connect({ databasePath: dbPath });

    try {
      await db.run(`CREATE TABLE repo (id INTEGER PRIMARY KEY, root TEXT)`);
      await db.run(`CREATE TABLE file (repo_id INTEGER, path TEXT PRIMARY KEY)`);

      await db.run(`INSERT INTO repo (id, root) VALUES (1, '/repo1'), (2, '/repo2')`);
      await db.run(`INSERT INTO file (repo_id, path) VALUES (1, 'a.ts'), (2, 'b.ts')`);

      // Use mergeRepoRecords (correct approach)
      await mergeRepoRecords(db, 1, [2]);

      // Verify: No orphaned file records (all point to existing repo)
      const orphans = await db.all<{ count: bigint }>(
        `SELECT COUNT(*) as count FROM file WHERE repo_id NOT IN (SELECT id FROM repo)`
      );
      expect(Number(orphans[0]?.count)).toBe(0);

      // Verify: All files merged into repo 1
      const files = await db.all<{ repo_id: number }>("SELECT repo_id FROM file");
      expect(files.every((f) => f.repo_id === 1)).toBe(true);
    } finally {
      await db.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
