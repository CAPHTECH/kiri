import { dirname, basename, join, resolve, realpathSync } from "node:path";
import { mkdir } from "node:fs/promises";

/**
 * Normalizes a database path by resolving the parent directory to its canonical form.
 *
 * This prevents lock file and queue key bypass issues caused by symlinks or OS path aliases.
 * The normalization strategy is:
 * 1. Resolve to absolute path
 * 2. Normalize parent directory using realpathSync (follows symlinks)
 * 3. Append the original filename (which may not exist yet)
 *
 * Why normalize parent instead of full path?
 * - Database file may not exist yet (first indexer run)
 * - realpathSync throws ENOENT on non-existent files
 * - Parent directory is created by ensureDirectory option before DB connection
 *
 * @param input - Path to database file (may be relative or absolute)
 * @returns Normalized absolute path with canonical parent directory
 *
 * @example
 * // First run (DB doesn't exist, accessed via symlink):
 * normalizeDbPath("/link/to/db.duckdb")  // "/real/path/db.duckdb"
 *
 * // Second run (DB exists, accessed via real path):
 * normalizeDbPath("/real/path/db.duckdb")  // "/real/path/db.duckdb"
 *
 * // Result: Same normalized path → same lock file, same queue key
 */
export function normalizeDbPath(input: string): string {
  const abs = resolve(input);
  const parentDir = dirname(abs);
  const filename = basename(abs);

  try {
    // Normalize parent directory to canonical form
    const canonicalParent = realpathSync.native(parentDir);
    return join(canonicalParent, filename);
  } catch (error) {
    // Parent directory doesn't exist yet - this is OK for database paths
    // The DuckDBClient's ensureDirectory option will create it
    return abs;
  }
}

/**
 * Ensures the parent directory of a database path exists.
 * This should be called before normalizeDbPath to guarantee successful normalization.
 *
 * @param dbPath - Path to database file
 */
export async function ensureDbParentDir(dbPath: string): Promise<void> {
  const parentDir = dirname(resolve(dbPath));
  await mkdir(parentDir, { recursive: true });
}
