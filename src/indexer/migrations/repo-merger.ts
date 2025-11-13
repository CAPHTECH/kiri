import { DuckDBClient } from "../../shared/duckdb.js";

/**
 * Merges duplicate repository records by migrating all dependent rows to a canonical ID
 * before deleting the legacy records.
 *
 * This function ensures data integrity when consolidating multiple repo records that
 * represent the same repository. It performs the following steps in a transaction:
 *
 * 1. Dynamically discovers all tables with a repo_id column
 * 2. Updates repo_id in all dependent tables to point to the canonical record
 * 3. Deletes the legacy repo records
 *
 * **CRITICAL**: This function must be used instead of direct DELETE to prevent orphaned
 * records in dependent tables (file, symbol, snippet, dependency, etc.). The schema
 * does not define foreign key constraints with ON DELETE CASCADE, so dependent rows
 * will NOT be automatically cleaned up.
 *
 * @param db - DuckDB client instance
 * @param canonicalRepoId - The repository ID to keep (all others will merge into this)
 * @param legacyRepoIds - Array of repository IDs to merge and delete
 *
 * @throws Error if migration fails (transaction will rollback automatically)
 *
 * @example
 * ```typescript
 * // Merge repos with IDs 2 and 3 into repo 1
 * await mergeRepoRecords(db, 1, [2, 3]);
 * // After: All file/symbol/snippet records now reference repo_id=1
 * // Repos 2 and 3 are deleted
 * ```
 */
export async function mergeRepoRecords(
  db: DuckDBClient,
  canonicalRepoId: number,
  legacyRepoIds: number[]
): Promise<void> {
  if (legacyRepoIds.length === 0) {
    return;
  }

  // Validate that canonical repo exists
  const canonicalRepo = await db.all<{ id: number }>("SELECT id FROM repo WHERE id = ?", [
    canonicalRepoId,
  ]);
  if (canonicalRepo.length === 0) {
    throw new Error(`Canonical repo ID ${canonicalRepoId} does not exist`);
  }

  // Dynamically discover all tables that reference repo_id
  // This ensures we catch any new tables added in the future
  const referencingTables = await db.all<{ table_name: string }>(
    `SELECT DISTINCT c.table_name
       FROM duckdb_columns() AS c
      WHERE c.column_name = 'repo_id'
        AND c.table_name <> 'repo'`
  );

  // Filter to alphanumeric table names for SQL injection safety
  const safeTables = referencingTables
    .map((row) => row.table_name)
    .filter((name) => /^[A-Za-z0-9_]+$/.test(name));

  // Perform migration in a transaction to ensure atomicity
  await db.transaction(async () => {
    for (const legacyRepoId of legacyRepoIds) {
      // Migrate all dependent rows to the canonical repo_id
      for (const tableName of safeTables) {
        await db.run(`UPDATE ${tableName} SET repo_id = ? WHERE repo_id = ?`, [
          canonicalRepoId,
          legacyRepoId,
        ]);
      }

      // Safe to delete now that all dependent rows have been migrated
      await db.run("DELETE FROM repo WHERE id = ?", [legacyRepoId]);
    }
  });
}
