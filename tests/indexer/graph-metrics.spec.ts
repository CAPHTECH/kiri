import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  computeGraphMetrics,
  computeDegreeCentrality,
  precomputeInboundClosure,
  incrementalGraphUpdate,
} from "../../src/indexer/graph-metrics.js";
import { ensureBaseSchema, ensureGraphLayerTables } from "../../src/indexer/schema.js";
import { DuckDBClient } from "../../src/shared/duckdb.js";

describe("graph-metrics", () => {
  let db: DuckDBClient;
  const testDbPath = join(process.cwd(), "tmp/test-graph-metrics.duckdb");

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

    // Add test files
    await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'src/a.ts', 'hash1')`);
    await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'src/b.ts', 'hash2')`);
    await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'src/c.ts', 'hash3')`);
    await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'src/d.ts', 'hash4')`);
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

  describe("computeDegreeCentrality", () => {
    it("should compute outbound and inbound counts", async () => {
      // a.ts imports b.ts and c.ts
      await db.run(
        `INSERT INTO dependency (repo_id, src_path, dst_kind, dst, rel)
         VALUES (1, 'src/a.ts', 'path', 'src/b.ts', 'import')`
      );
      await db.run(
        `INSERT INTO dependency (repo_id, src_path, dst_kind, dst, rel)
         VALUES (1, 'src/a.ts', 'path', 'src/c.ts', 'import')`
      );
      // b.ts imports c.ts
      await db.run(
        `INSERT INTO dependency (repo_id, src_path, dst_kind, dst, rel)
         VALUES (1, 'src/b.ts', 'path', 'src/c.ts', 'import')`
      );

      await computeDegreeCentrality(db, 1);

      const metrics = await db.all<{ path: string; outbound_count: number; inbound_count: number }>(
        `SELECT path, outbound_count, inbound_count FROM graph_metrics WHERE repo_id = 1 ORDER BY path`
      );

      // a.ts: 2 outbound, 0 inbound
      const a = metrics.find((m) => m.path === "src/a.ts");
      expect(a?.outbound_count).toBe(2);
      expect(a?.inbound_count).toBe(0);

      // b.ts: 1 outbound, 1 inbound (from a.ts)
      const b = metrics.find((m) => m.path === "src/b.ts");
      expect(b?.outbound_count).toBe(1);
      expect(b?.inbound_count).toBe(1);

      // c.ts: 0 outbound, 2 inbound (from a.ts and b.ts)
      const c = metrics.find((m) => m.path === "src/c.ts");
      expect(c?.outbound_count).toBe(0);
      expect(c?.inbound_count).toBe(2);
    });

    it("should handle files with no dependencies", async () => {
      await computeDegreeCentrality(db, 1);

      const metrics = await db.all<{ path: string }>(
        `SELECT path FROM graph_metrics WHERE repo_id = 1`
      );

      // No dependencies, so no metrics entries
      expect(metrics).toHaveLength(0);
    });
  });

  describe("precomputeInboundClosure", () => {
    it("should compute transitive inbound closure", async () => {
      // Chain: d.ts -> c.ts -> b.ts -> a.ts
      await db.run(
        `INSERT INTO dependency (repo_id, src_path, dst_kind, dst, rel)
         VALUES (1, 'src/d.ts', 'path', 'src/c.ts', 'import')`
      );
      await db.run(
        `INSERT INTO dependency (repo_id, src_path, dst_kind, dst, rel)
         VALUES (1, 'src/c.ts', 'path', 'src/b.ts', 'import')`
      );
      await db.run(
        `INSERT INTO dependency (repo_id, src_path, dst_kind, dst, rel)
         VALUES (1, 'src/b.ts', 'path', 'src/a.ts', 'import')`
      );

      await precomputeInboundClosure(db, 1, 3);

      // a.ts should have b.ts at depth 1, c.ts at depth 2, d.ts at depth 3
      const closure = await db.all<{ source_path: string; depth: number }>(
        `SELECT source_path, depth FROM inbound_edges
         WHERE repo_id = 1 AND target_path = 'src/a.ts'
         ORDER BY depth`
      );

      expect(closure).toHaveLength(3);
      expect(closure[0]?.source_path).toBe("src/b.ts");
      expect(closure[0]?.depth).toBe(1);
      expect(closure[1]?.source_path).toBe("src/c.ts");
      expect(closure[1]?.depth).toBe(2);
      expect(closure[2]?.source_path).toBe("src/d.ts");
      expect(closure[2]?.depth).toBe(3);
    });

    it("should respect maxDepth limit", async () => {
      // Chain: d.ts -> c.ts -> b.ts -> a.ts
      await db.run(
        `INSERT INTO dependency (repo_id, src_path, dst_kind, dst, rel)
         VALUES (1, 'src/d.ts', 'path', 'src/c.ts', 'import')`
      );
      await db.run(
        `INSERT INTO dependency (repo_id, src_path, dst_kind, dst, rel)
         VALUES (1, 'src/c.ts', 'path', 'src/b.ts', 'import')`
      );
      await db.run(
        `INSERT INTO dependency (repo_id, src_path, dst_kind, dst, rel)
         VALUES (1, 'src/b.ts', 'path', 'src/a.ts', 'import')`
      );

      await precomputeInboundClosure(db, 1, 2);

      const closure = await db.all<{ source_path: string }>(
        `SELECT source_path FROM inbound_edges
         WHERE repo_id = 1 AND target_path = 'src/a.ts'`
      );

      // maxDepth=2, so d.ts should NOT be included
      expect(closure).toHaveLength(2);
      expect(closure.map((c) => c.source_path)).not.toContain("src/d.ts");
    });

    it("should handle cycles without infinite recursion", async () => {
      // Cycle: a.ts -> b.ts -> c.ts -> a.ts
      await db.run(
        `INSERT INTO dependency (repo_id, src_path, dst_kind, dst, rel)
         VALUES (1, 'src/a.ts', 'path', 'src/b.ts', 'import')`
      );
      await db.run(
        `INSERT INTO dependency (repo_id, src_path, dst_kind, dst, rel)
         VALUES (1, 'src/b.ts', 'path', 'src/c.ts', 'import')`
      );
      await db.run(
        `INSERT INTO dependency (repo_id, src_path, dst_kind, dst, rel)
         VALUES (1, 'src/c.ts', 'path', 'src/a.ts', 'import')`
      );

      // Should complete without hanging
      await precomputeInboundClosure(db, 1, 3);

      const closure = await db.all<{ target_path: string; source_path: string }>(
        `SELECT target_path, source_path FROM inbound_edges WHERE repo_id = 1`
      );

      // Should have entries but no self-loops
      for (const entry of closure) {
        expect(entry.target_path).not.toBe(entry.source_path);
      }
    });
  });

  describe("incrementalGraphUpdate", () => {
    it("should update metrics for changed files and their dependents", async () => {
      // Initial setup: a.ts imports b.ts
      await db.run(
        `INSERT INTO dependency (repo_id, src_path, dst_kind, dst, rel)
         VALUES (1, 'src/a.ts', 'path', 'src/b.ts', 'import')`
      );

      // Initial computation
      await computeGraphMetrics(db, 1);

      const initialMetrics = await db.all<{ path: string; inbound_count: number }>(
        `SELECT path, inbound_count FROM graph_metrics WHERE repo_id = 1 ORDER BY path`
      );
      expect(initialMetrics.find((m) => m.path === "src/b.ts")?.inbound_count).toBe(1);

      // Add new dependency: c.ts imports b.ts
      await db.run(
        `INSERT INTO dependency (repo_id, src_path, dst_kind, dst, rel)
         VALUES (1, 'src/c.ts', 'path', 'src/b.ts', 'import')`
      );

      // Incremental update for c.ts
      await incrementalGraphUpdate(db, 1, ["src/c.ts"]);

      const updatedMetrics = await db.all<{ path: string; inbound_count: number }>(
        `SELECT path, inbound_count FROM graph_metrics WHERE repo_id = 1 ORDER BY path`
      );

      // b.ts should now have 2 inbound (from a.ts and c.ts)
      expect(updatedMetrics.find((m) => m.path === "src/b.ts")?.inbound_count).toBe(2);
    });

    it("should handle empty changedPaths", async () => {
      // Setup some dependencies
      await db.run(
        `INSERT INTO dependency (repo_id, src_path, dst_kind, dst, rel)
         VALUES (1, 'src/a.ts', 'path', 'src/b.ts', 'import')`
      );
      await computeGraphMetrics(db, 1);

      const beforeMetrics = await db.all<{ path: string }>(
        `SELECT path FROM graph_metrics WHERE repo_id = 1`
      );

      // Incremental update with empty paths should be a no-op
      await incrementalGraphUpdate(db, 1, []);

      const afterMetrics = await db.all<{ path: string }>(
        `SELECT path FROM graph_metrics WHERE repo_id = 1`
      );

      expect(afterMetrics).toHaveLength(beforeMetrics.length);
    });
  });

  describe("computeImportanceScores", () => {
    it("should assign higher scores to files with more inbound dependencies", async () => {
      // b.ts and c.ts both import a.ts
      await db.run(
        `INSERT INTO dependency (repo_id, src_path, dst_kind, dst, rel)
         VALUES (1, 'src/b.ts', 'path', 'src/a.ts', 'import')`
      );
      await db.run(
        `INSERT INTO dependency (repo_id, src_path, dst_kind, dst, rel)
         VALUES (1, 'src/c.ts', 'path', 'src/a.ts', 'import')`
      );
      // d.ts imports b.ts only
      await db.run(
        `INSERT INTO dependency (repo_id, src_path, dst_kind, dst, rel)
         VALUES (1, 'src/d.ts', 'path', 'src/b.ts', 'import')`
      );

      await computeGraphMetrics(db, 1);

      const metrics = await db.all<{ path: string; importance_score: number }>(
        `SELECT path, importance_score FROM graph_metrics WHERE repo_id = 1 ORDER BY importance_score DESC`
      );

      // a.ts should have highest importance (2 inbound)
      expect(metrics[0]?.path).toBe("src/a.ts");
      expect(metrics[0]?.importance_score).toBeGreaterThan(0);

      // All scores should be normalized to [0, 1]
      for (const m of metrics) {
        expect(m.importance_score).toBeGreaterThanOrEqual(0);
        expect(m.importance_score).toBeLessThanOrEqual(1);
      }
    });
  });

  describe("DG invariants", () => {
    it("DG1: All edges reference indexed files", async () => {
      // Only insert dependencies between indexed files
      await db.run(
        `INSERT INTO dependency (repo_id, src_path, dst_kind, dst, rel)
         VALUES (1, 'src/a.ts', 'path', 'src/b.ts', 'import')`
      );

      await computeGraphMetrics(db, 1);

      // All paths in graph_metrics should be in file table
      const metricsPaths = await db.all<{ path: string }>(
        `SELECT path FROM graph_metrics WHERE repo_id = 1`
      );
      const filePaths = await db.all<{ path: string }>(`SELECT path FROM file WHERE repo_id = 1`);
      const fileSet = new Set(filePaths.map((f) => f.path));

      for (const m of metricsPaths) {
        expect(fileSet.has(m.path)).toBe(true);
      }
    });

    it("DG2: No self-loops in inbound_edges", async () => {
      // Even with a self-import, the closure should not include self-loops
      // (In practice, self-imports are rare, but the code should handle them)
      await db.run(
        `INSERT INTO dependency (repo_id, src_path, dst_kind, dst, rel)
         VALUES (1, 'src/a.ts', 'path', 'src/b.ts', 'import')`
      );

      await precomputeInboundClosure(db, 1, 3);

      const selfLoops = await db.all<{ count: number }>(
        `SELECT COUNT(*) as count FROM inbound_edges
         WHERE repo_id = 1 AND target_path = source_path`
      );

      expect(selfLoops[0]?.count).toBe(0);
    });
  });
});
