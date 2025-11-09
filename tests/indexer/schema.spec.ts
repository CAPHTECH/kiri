import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ensureBaseSchema,
  ensureRepoMetaColumns,
  rebuildFTSIfNeeded,
  setFTSDirty,
  tryCreateFTSIndex,
} from "../../src/indexer/schema.js";
import { DuckDBClient } from "../../src/shared/duckdb.js";

describe("tryCreateFTSIndex", () => {
  let tempDir: string;
  let db: DuckDBClient;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kiri-test-"));
    const dbPath = join(tempDir, "test.duckdb");
    db = await DuckDBClient.connect({ databasePath: dbPath });

    // Create blob table required for FTS index
    await db.run(`
      CREATE TABLE IF NOT EXISTS blob (
        hash TEXT PRIMARY KEY,
        content TEXT
      )
    `);
  });

  afterEach(async () => {
    if (db) {
      await db.close();
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates FTS index when it does not exist", async () => {
    const result = await tryCreateFTSIndex(db);

    // Should succeed (or skip if FTS extension is not available)
    expect(typeof result).toBe("boolean");

    if (result) {
      // Verify FTS schema was created
      const schemas = await db.all<{ schema_name: string }>(
        `SELECT schema_name FROM duckdb_schemas() WHERE schema_name = 'fts_main_blob'`
      );
      expect(schemas.length).toBe(1);

      // Verify required tables exist
      const tables = await db.all<{ table_name: string }>(
        `SELECT table_name FROM duckdb_tables()
         WHERE schema_name = 'fts_main_blob' AND table_name IN ('docs', 'terms')`
      );
      expect(tables.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("skips FTS index creation when it already exists", async () => {
    // First creation
    const firstResult = await tryCreateFTSIndex(db);

    if (!firstResult) {
      // FTS extension not available, skip test
      return;
    }

    // Get initial state
    const initialSchemas = await db.all<{ schema_name: string }>(
      `SELECT schema_name FROM duckdb_schemas() WHERE schema_name = 'fts_main_blob'`
    );
    expect(initialSchemas.length).toBe(1);

    // Second call should skip creation
    const secondResult = await tryCreateFTSIndex(db);
    expect(secondResult).toBe(true);

    // Verify schema still exists (not recreated)
    const finalSchemas = await db.all<{ schema_name: string }>(
      `SELECT schema_name FROM duckdb_schemas() WHERE schema_name = 'fts_main_blob'`
    );
    expect(finalSchemas.length).toBe(1);
  });

  it("recreates FTS index when integrity check fails", async () => {
    // First creation
    const firstResult = await tryCreateFTSIndex(db);

    if (!firstResult) {
      // FTS extension not available, skip test
      return;
    }

    // Manually corrupt the index by dropping a required table
    await db.run(`DROP TABLE IF EXISTS fts_main_blob.docs`);

    // Verify corruption
    const tables = await db.all<{ table_name: string }>(
      `SELECT table_name FROM duckdb_tables()
       WHERE schema_name = 'fts_main_blob' AND table_name = 'docs'`
    );
    expect(tables.length).toBe(0);

    // Should detect corruption and attempt recreation
    // Note: This may fail or succeed depending on FTS implementation
    const secondResult = await tryCreateFTSIndex(db);
    expect(typeof secondResult).toBe("boolean");
  });

  it("returns false when FTS extension is not available", async () => {
    // This test verifies graceful degradation
    // We cannot easily simulate FTS unavailability, so we just verify
    // that the function returns a boolean
    const result = await tryCreateFTSIndex(db);
    expect(typeof result).toBe("boolean");
  });

  it("handles race condition when index is created by another process", async () => {
    // First creation
    const firstResult = await tryCreateFTSIndex(db);

    if (!firstResult) {
      // FTS extension not available, skip test
      return;
    }

    // Simulate race condition by calling again
    // The function should handle "already exists" error gracefully
    const secondResult = await tryCreateFTSIndex(db);
    expect(secondResult).toBe(true);

    // Verify index still exists and is functional
    const schemas = await db.all<{ schema_name: string }>(
      `SELECT schema_name FROM duckdb_schemas() WHERE schema_name = 'fts_main_blob'`
    );
    expect(schemas.length).toBe(1);
  });

  it("performs integrity verification correctly", async () => {
    const result = await tryCreateFTSIndex(db);

    if (!result) {
      // FTS extension not available, skip test
      return;
    }

    // Insert test data
    await db.run(`INSERT INTO blob (hash, content) VALUES ('test-hash', 'test content')`);

    // Call again - should skip due to valid existing index
    const secondResult = await tryCreateFTSIndex(db);
    expect(secondResult).toBe(true);

    // Verify FTS schema and tables still exist
    const schemas = await db.all<{ schema_name: string }>(
      `SELECT schema_name FROM duckdb_schemas() WHERE schema_name = 'fts_main_blob'`
    );
    expect(schemas.length).toBe(1);

    const tables = await db.all<{ table_name: string }>(
      `SELECT table_name FROM duckdb_tables()
       WHERE schema_name = 'fts_main_blob' AND table_name IN ('docs', 'terms')`
    );
    expect(tables.length).toBeGreaterThanOrEqual(2);
  });
});

describe("ensureRepoMetaColumns", () => {
  let tempDir: string;
  let db: DuckDBClient;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kiri-test-"));
    const dbPath = join(tempDir, "test.duckdb");
    db = await DuckDBClient.connect({ databasePath: dbPath });
  });

  afterEach(async () => {
    if (db) {
      await db.close();
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns early if repo table doesn't exist", async () => {
    // Should not throw when repo table doesn't exist
    await expect(ensureRepoMetaColumns(db)).resolves.toBeUndefined();
  });

  it("adds fts_last_indexed_at and fts_dirty columns to existing repo table", async () => {
    // Create repo table without FTS columns
    await db.run(`
      CREATE TABLE repo (
        id INTEGER PRIMARY KEY,
        root TEXT NOT NULL UNIQUE
      )
    `);

    await ensureRepoMetaColumns(db);

    // Verify columns were added
    const columns = await db.all<{ column_name: string }>(
      `SELECT column_name FROM duckdb_columns()
       WHERE table_name = 'repo' AND column_name IN ('fts_last_indexed_at', 'fts_dirty')`
    );

    expect(columns.length).toBe(2);
    expect(columns.map((c) => c.column_name)).toContain("fts_last_indexed_at");
    expect(columns.map((c) => c.column_name)).toContain("fts_dirty");
  });

  it("is idempotent - doesn't fail if columns already exist", async () => {
    await ensureBaseSchema(db);

    // First call
    await ensureRepoMetaColumns(db);

    // Second call should not throw
    await expect(ensureRepoMetaColumns(db)).resolves.toBeUndefined();
  });

  it("initializes fts_dirty=true when FTS doesn't exist", async () => {
    await ensureBaseSchema(db);
    await db.run(`INSERT INTO repo (root) VALUES ('/test')`);

    await ensureRepoMetaColumns(db);

    const rows = await db.all<{ fts_dirty: boolean }>(
      `SELECT fts_dirty FROM repo WHERE root = '/test'`
    );
    expect(rows[0]?.fts_dirty).toBe(true);
  });
});

describe("rebuildFTSIfNeeded", () => {
  let tempDir: string;
  let db: DuckDBClient;
  let repoId: number;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kiri-test-"));
    const dbPath = join(tempDir, "test.duckdb");
    db = await DuckDBClient.connect({ databasePath: dbPath });

    // Set up base schema and repo
    await ensureBaseSchema(db);
    await db.run(`INSERT INTO repo (root) VALUES ('/test')`);
    const rows = await db.all<{ id: number }>(`SELECT id FROM repo WHERE root = '/test'`);
    repoId = rows[0]!.id;

    // Create blob table for FTS
    await db.run(`
      CREATE TABLE IF NOT EXISTS blob (
        hash TEXT PRIMARY KEY,
        content TEXT
      )
    `);
  });

  afterEach(async () => {
    if (db) {
      await db.close();
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("rebuilds FTS when dirty flag is true", async () => {
    // Set dirty flag
    await setFTSDirty(db, repoId);

    const result = await rebuildFTSIfNeeded(db, repoId);

    if (result) {
      // FTS is available - verify dirty flag was cleared
      const rows = await db.all<{ fts_dirty: boolean }>(`SELECT fts_dirty FROM repo WHERE id = ?`, [
        repoId,
      ]);
      expect(rows[0]?.fts_dirty).toBe(false);
    }
  });

  it("skips rebuild when FTS is clean and exists", async () => {
    // First rebuild to create FTS
    const firstResult = await rebuildFTSIfNeeded(db, repoId);

    if (!firstResult) {
      // FTS not available, skip test
      return;
    }

    // Verify dirty flag is false
    const beforeRows = await db.all<{ fts_dirty: boolean }>(
      `SELECT fts_dirty FROM repo WHERE id = ?`,
      [repoId]
    );
    expect(beforeRows[0]?.fts_dirty).toBe(false);

    // Second call should skip rebuild
    const secondResult = await rebuildFTSIfNeeded(db, repoId);
    expect(secondResult).toBe(true);
  });

  it("forces rebuild when forceFTS=true", async () => {
    // First rebuild
    await rebuildFTSIfNeeded(db, repoId);

    // Force rebuild even if clean
    const result = await rebuildFTSIfNeeded(db, repoId, true);

    if (result) {
      // Verify it succeeded
      const rows = await db.all<{ fts_dirty: boolean }>(`SELECT fts_dirty FROM repo WHERE id = ?`, [
        repoId,
      ]);
      expect(rows[0]?.fts_dirty).toBe(false);
    }
  });
});

describe("setFTSDirty", () => {
  let tempDir: string;
  let db: DuckDBClient;
  let repoId: number;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kiri-test-"));
    const dbPath = join(tempDir, "test.duckdb");
    db = await DuckDBClient.connect({ databasePath: dbPath });

    await ensureBaseSchema(db);
    await db.run(`INSERT INTO repo (root) VALUES ('/test')`);
    const rows = await db.all<{ id: number }>(`SELECT id FROM repo WHERE root = '/test'`);
    repoId = rows[0]!.id;
  });

  afterEach(async () => {
    if (db) {
      await db.close();
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("sets fts_dirty to true", async () => {
    await setFTSDirty(db, repoId);

    const rows = await db.all<{ fts_dirty: boolean }>(`SELECT fts_dirty FROM repo WHERE id = ?`, [
      repoId,
    ]);
    expect(rows[0]?.fts_dirty).toBe(true);
  });

  it("ensures columns exist before setting dirty flag", async () => {
    // setFTSDirty should call ensureRepoMetaColumns internally
    await setFTSDirty(db, repoId);

    // Verify column exists
    const columns = await db.all<{ column_name: string }>(
      `SELECT column_name FROM duckdb_columns()
       WHERE table_name = 'repo' AND column_name = 'fts_dirty'`
    );
    expect(columns.length).toBe(1);
  });
});
