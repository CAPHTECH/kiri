import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDatabaseIndexed } from "../../src/server/indexBootstrap.js";
import { DuckDBClient } from "../../src/shared/duckdb.js";
import { acquireLock, releaseLock } from "../../src/shared/utils/lockfile.js";
import { createTempDbPath } from "../helpers/db-setup.js";
import { createMigrationTestScenario } from "../helpers/migration-setup.js";
import { createTempRepo } from "../helpers/test-repo.js";

describe("ensureDatabaseIndexed", () => {
  it("indexes a missing database and releases the lock for subsequent runs", async () => {
    const repo = await createTempRepo({
      "src/index.ts": "console.log('bootstrap test');\n",
    });
    const db = await createTempDbPath();

    try {
      const firstRun = await ensureDatabaseIndexed(repo.path, db.path, false, true);
      expect(firstRun).toBe(true);

      // Second run should detect the existing DB and skip reindex without hitting lock errors
      const secondRun = await ensureDatabaseIndexed(repo.path, db.path, false, false);
      expect(secondRun).toBe(true);
    } finally {
      await repo.cleanup();
      await db.cleanup();
    }
  });

  it("detects migration and triggers reindex when files exist but metadata is empty", async () => {
    // Create a database with files but without document_metadata tables (simulates old version)
    const { repo, db } = await createMigrationTestScenario({ withMetadata: false });

    try {
      // Step 2: Run ensureDatabaseIndexed - should detect migration and trigger reindex
      const result = await ensureDatabaseIndexed(repo.path, db.path, false, false);
      expect(result).toBe(true);

      // Step 3: Verify document_metadata tables were created and populated
      const dbClient2 = await DuckDBClient.connect({ databasePath: db.path });
      const metadataTables = await dbClient2.all<{ table_name: string }>(
        `SELECT table_name FROM duckdb_tables() WHERE table_name = 'document_metadata'`
      );
      expect(metadataTables.length).toBe(1);

      // Verify metadata was extracted (frontmatter should be captured)
      const metadataRecords = await dbClient2.all<{ count: number }>(
        `SELECT COUNT(*) as count FROM document_metadata`
      );
      expect(metadataRecords[0]?.count).toBeGreaterThan(0);

      // Verify document_metadata_kv table was created
      const kvTables = await dbClient2.all<{ table_name: string }>(
        `SELECT table_name FROM duckdb_tables() WHERE table_name = 'document_metadata_kv'`
      );
      expect(kvTables.length).toBe(1);

      // Verify index was created
      const indexes = await dbClient2.all<{ index_name: string }>(
        `SELECT index_name FROM duckdb_indexes() WHERE index_name = 'idx_document_metadata_key'`
      );
      expect(indexes.length).toBe(1);

      // Verify kv data was extracted
      const kvRecords = await dbClient2.all<{ count: number }>(
        `SELECT COUNT(*) as count FROM document_metadata_kv`
      );
      expect(kvRecords[0]?.count).toBeGreaterThan(0);

      await dbClient2.close();
    } finally {
      await repo.cleanup();
      await db.cleanup();
    }
  });

  it("skips reindex when files exist and metadata is already populated", async () => {
    // Create a database with both files AND populated document_metadata (simulates migrated version)
    const { repo, db } = await createMigrationTestScenario({ withMetadata: true });

    try {
      // Step 2: Run ensureDatabaseIndexed - should NOT trigger reindex since metadata is populated
      const result = await ensureDatabaseIndexed(repo.path, db.path, false, false);

      expect(result).toBe(true);

      // Step 3: Verify no reindex occurred by checking the file count hasn't changed
      const dbClient2 = await DuckDBClient.connect({ databasePath: db.path });
      const fileCount = await dbClient2.all<{ count: number }>(
        `SELECT COUNT(*) as count FROM file`
      );
      expect(fileCount[0]?.count).toBe(1); // Still just 1 file, no reindexing added more

      const metadataCount = await dbClient2.all<{ count: number }>(
        `SELECT COUNT(*) as count FROM document_metadata`
      );
      expect(metadataCount[0]?.count).toBe(1); // Still just 1 record, no reindexing added more

      await dbClient2.close();
    } finally {
      await repo.cleanup();
      await db.cleanup();
    }
  });

  describe("concurrent access", () => {
    let processExitSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      // Mock process.exit to prevent test runner from terminating
      processExitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation((code?: string | number | null) => {
          throw new Error(`process.exit(${code ?? 0}) called`);
        }) as unknown as ReturnType<typeof vi.spyOn>;
    });

    afterEach(() => {
      processExitSpy.mockRestore();
    });

    it("handles concurrent migration attempts with file locking", async () => {
      // Create old schema database that needs migration
      const { repo, db } = await createMigrationTestScenario({ withMetadata: false });

      try {
        // Manually acquire lock to simulate another process already running migration
        const lockfilePath = `${db.path}.lock`;
        acquireLock(lockfilePath);

        try {
          // Should reject due to lock contention
          await expect(ensureDatabaseIndexed(repo.path, db.path, false, false)).rejects.toThrow(
            /process\.exit|lock|already running/i
          );

          // Verify process.exit(1) was called in production code
          expect(processExitSpy).toHaveBeenCalledWith(1);
        } finally {
          // Always release the lock we acquired
          releaseLock(lockfilePath);
        }
      } finally {
        await repo.cleanup();
        await db.cleanup();
      }
    });
  });
});
