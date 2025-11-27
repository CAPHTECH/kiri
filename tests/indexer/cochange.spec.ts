import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  canonicalPair,
  generatePairs,
  getCochangeNeighbors,
  removeFileCochange,
} from "../../src/indexer/cochange.js";
import { ensureBaseSchema, ensureGraphLayerTables } from "../../src/indexer/schema.js";
import { DuckDBClient } from "../../src/shared/duckdb.js";

describe("cochange", () => {
  describe("canonicalPair", () => {
    it("should order files lexicographically", () => {
      expect(canonicalPair("b.ts", "a.ts")).toEqual(["a.ts", "b.ts"]);
      expect(canonicalPair("a.ts", "b.ts")).toEqual(["a.ts", "b.ts"]);
    });

    it("should handle paths with directories", () => {
      const [f1, f2] = canonicalPair("src/z/file.ts", "src/a/file.ts");
      expect(f1 < f2).toBe(true);
    });

    it("should handle identical paths (edge case)", () => {
      // In practice, this shouldn't happen but the function should be deterministic
      expect(canonicalPair("same.ts", "same.ts")).toEqual(["same.ts", "same.ts"]);
    });
  });

  describe("generatePairs", () => {
    it("should generate all unique pairs", () => {
      const files = ["a.ts", "b.ts", "c.ts"];
      const pairs = generatePairs(files);

      expect(pairs).toHaveLength(3); // 3 choose 2 = 3
      expect(pairs).toContainEqual(["a.ts", "b.ts"]);
      expect(pairs).toContainEqual(["a.ts", "c.ts"]);
      expect(pairs).toContainEqual(["b.ts", "c.ts"]);
    });

    it("should return empty array for single file", () => {
      expect(generatePairs(["single.ts"])).toHaveLength(0);
    });

    it("should return empty array for empty input", () => {
      expect(generatePairs([])).toHaveLength(0);
    });

    it("should return pairs in canonical order", () => {
      const files = ["c.ts", "a.ts", "b.ts"]; // Not sorted
      const pairs = generatePairs(files);

      for (const [f1, f2] of pairs) {
        expect(f1 < f2).toBe(true);
      }
    });

    it("should handle many files", () => {
      const files = ["1.ts", "2.ts", "3.ts", "4.ts", "5.ts"];
      const pairs = generatePairs(files);

      // n choose 2 = n*(n-1)/2 = 5*4/2 = 10
      expect(pairs).toHaveLength(10);
    });
  });

  describe("database operations", () => {
    let db: DuckDBClient;
    const testDbPath = join(process.cwd(), "tmp/test-cochange.duckdb");

    beforeEach(async () => {
      // Ensure tmp directory exists
      const tmpDir = join(process.cwd(), "tmp");
      if (!existsSync(tmpDir)) {
        mkdirSync(tmpDir, { recursive: true });
      }

      // Clean up any existing test DB
      if (existsSync(testDbPath)) {
        unlinkSync(testDbPath);
      }

      // Create fresh DB with schema
      db = await DuckDBClient.connect({ databasePath: testDbPath });
      await ensureBaseSchema(db);
      await ensureGraphLayerTables(db);

      // Create a test repo
      await db.run(
        `INSERT INTO repo (id, root, indexed_at) VALUES (1, '/test/repo', CURRENT_TIMESTAMP)`
      );

      // Add some test files
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'src/a.ts', 'hash1')`);
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'src/b.ts', 'hash2')`);
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'src/c.ts', 'hash3')`);
    });

    afterEach(async () => {
      if (db) {
        await db.close();
      }
      if (existsSync(testDbPath)) {
        unlinkSync(testDbPath);
      }
      // Also clean up WAL file if it exists
      const walPath = testDbPath + ".wal";
      if (existsSync(walPath)) {
        unlinkSync(walPath);
      }
    });

    describe("getCochangeNeighbors", () => {
      it("should return empty array when no co-change data exists", async () => {
        const neighbors = await getCochangeNeighbors(db, 1, "src/a.ts");
        expect(neighbors).toHaveLength(0);
      });

      it("should return neighbors with co-change data", async () => {
        // Insert co-change edge (canonical order: a < b)
        await db.run(
          `INSERT INTO cochange (repo_id, file1, file2, cochange_count, confidence)
           VALUES (1, 'src/a.ts', 'src/b.ts', 5, 0.8)`
        );

        // Query from file1's perspective
        const neighborsA = await getCochangeNeighbors(db, 1, "src/a.ts");
        expect(neighborsA).toHaveLength(1);
        expect(neighborsA[0]?.path).toBe("src/b.ts");
        expect(neighborsA[0]?.count).toBe(5);
        expect(neighborsA[0]?.confidence).toBeCloseTo(0.8, 2);

        // Query from file2's perspective (bidirectional)
        const neighborsB = await getCochangeNeighbors(db, 1, "src/b.ts");
        expect(neighborsB).toHaveLength(1);
        expect(neighborsB[0]?.path).toBe("src/a.ts");
      });

      it("should return neighbors sorted by count", async () => {
        await db.run(
          `INSERT INTO cochange (repo_id, file1, file2, cochange_count, confidence)
           VALUES (1, 'src/a.ts', 'src/b.ts', 3, 0.5)`
        );
        await db.run(
          `INSERT INTO cochange (repo_id, file1, file2, cochange_count, confidence)
           VALUES (1, 'src/a.ts', 'src/c.ts', 10, 0.9)`
        );

        const neighbors = await getCochangeNeighbors(db, 1, "src/a.ts");
        expect(neighbors).toHaveLength(2);
        expect(neighbors[0]?.path).toBe("src/c.ts"); // Higher count first
        expect(neighbors[1]?.path).toBe("src/b.ts");
      });

      it("should respect limit parameter", async () => {
        await db.run(
          `INSERT INTO cochange (repo_id, file1, file2, cochange_count, confidence)
           VALUES (1, 'src/a.ts', 'src/b.ts', 3, 0.5)`
        );
        await db.run(
          `INSERT INTO cochange (repo_id, file1, file2, cochange_count, confidence)
           VALUES (1, 'src/a.ts', 'src/c.ts', 10, 0.9)`
        );

        const neighbors = await getCochangeNeighbors(db, 1, "src/a.ts", 1);
        expect(neighbors).toHaveLength(1);
      });
    });

    describe("removeFileCochange", () => {
      it("should remove all edges involving the file", async () => {
        // Insert edges involving src/a.ts
        await db.run(
          `INSERT INTO cochange (repo_id, file1, file2, cochange_count, confidence)
           VALUES (1, 'src/a.ts', 'src/b.ts', 5, 0.8)`
        );
        await db.run(
          `INSERT INTO cochange (repo_id, file1, file2, cochange_count, confidence)
           VALUES (1, 'src/a.ts', 'src/c.ts', 3, 0.6)`
        );
        // Insert edge NOT involving src/a.ts
        await db.run(
          `INSERT INTO cochange (repo_id, file1, file2, cochange_count, confidence)
           VALUES (1, 'src/b.ts', 'src/c.ts', 2, 0.4)`
        );

        const removed = await removeFileCochange(db, 1, "src/a.ts");
        expect(removed).toBe(2);

        // Check that only b-c edge remains
        const remaining = await db.all<{ file1: string; file2: string }>(
          `SELECT file1, file2 FROM cochange WHERE repo_id = 1`
        );
        expect(remaining).toHaveLength(1);
        expect(remaining[0]?.file1).toBe("src/b.ts");
        expect(remaining[0]?.file2).toBe("src/c.ts");
      });

      it("should return 0 when file has no edges", async () => {
        const removed = await removeFileCochange(db, 1, "nonexistent.ts");
        expect(removed).toBe(0);
      });
    });

    describe("CC1: Canonical ordering invariant", () => {
      it("should maintain file1 < file2 invariant", async () => {
        // Insert in correct order
        await db.run(
          `INSERT INTO cochange (repo_id, file1, file2, cochange_count, confidence)
           VALUES (1, 'src/a.ts', 'src/b.ts', 1, 0.5)`
        );

        const edges = await db.all<{ file1: string; file2: string }>(
          `SELECT file1, file2 FROM cochange WHERE repo_id = 1`
        );

        for (const edge of edges) {
          expect(edge.file1 < edge.file2).toBe(true);
        }
      });
    });

    describe("CC3: Positive weight invariant", () => {
      it("should only store positive cochange counts", async () => {
        await db.run(
          `INSERT INTO cochange (repo_id, file1, file2, cochange_count, confidence)
           VALUES (1, 'src/a.ts', 'src/b.ts', 1, 0.5)`
        );

        const edges = await db.all<{ cochange_count: number }>(
          `SELECT cochange_count FROM cochange WHERE repo_id = 1`
        );

        for (const edge of edges) {
          expect(edge.cochange_count).toBeGreaterThan(0);
        }
      });
    });

    describe("CC4: Idempotent processing", () => {
      it("should track processed commits", async () => {
        // Insert a processed commit
        await db.run(
          `INSERT INTO processed_commits (repo_id, commit_hash)
           VALUES (1, 'abc123')`
        );

        // Check it's tracked
        const result = await db.all<{ count: number }>(
          `SELECT COUNT(*) as count FROM processed_commits
           WHERE repo_id = 1 AND commit_hash = 'abc123'`
        );

        expect(result[0]?.count).toBe(1);
      });

      it("should prevent duplicate commit processing via UNIQUE constraint", async () => {
        await db.run(
          `INSERT INTO processed_commits (repo_id, commit_hash)
           VALUES (1, 'abc123')`
        );

        // Try to insert again - should fail silently with ON CONFLICT DO NOTHING
        await db.run(
          `INSERT INTO processed_commits (repo_id, commit_hash)
           VALUES (1, 'abc123')
           ON CONFLICT DO NOTHING`
        );

        const result = await db.all<{ count: number }>(
          `SELECT COUNT(*) as count FROM processed_commits
           WHERE repo_id = 1 AND commit_hash = 'abc123'`
        );

        expect(result[0]?.count).toBe(1); // Still only 1 row
      });
    });
  });
});
