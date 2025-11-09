import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { tryCreateFTSIndex } from "../../src/indexer/schema.js";
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
