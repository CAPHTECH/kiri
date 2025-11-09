import { existsSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, basename, join, resolve } from "node:path";

/**
 * Normalizes a database path by resolving to its canonical form.
 *
 * This prevents lock file and queue key bypass issues caused by symlinks or OS path aliases.
 * The normalization strategy is:
 * 1. Resolve to absolute path
 * 2. If file exists, normalize the full path using realpathSync (follows symlinks)
 * 3. If file doesn't exist, normalize parent directory and append filename
 *
 * Why this two-stage approach?
 * - Database file may not exist yet (first indexer run)
 * - realpathSync throws ENOENT on non-existent files
 * - Must call ensureDbParentDir BEFORE this function to ensure parent exists
 * - Once file exists, we normalize the full path to prevent symlink bypass
 *
 * @param input - Path to database file (may be relative or absolute)
 * @returns Normalized absolute path (full path if exists, parent+filename if not)
 *
 * @example
 * // First run (DB doesn't exist, symlink parent):
 * ensureDbParentDir("/link/to/db.duckdb");  // Creates /real/path/
 * normalizeDbPath("/link/to/db.duckdb")     // "/real/path/db.duckdb"
 *
 * // Second run (DB exists, accessed via symlink):
 * normalizeDbPath("/link/db.duckdb")        // "/real/path/db.duckdb"
 *
 * // Result: Same normalized path → same lock file, same queue key
 */
export function normalizeDbPath(input: string): string {
  const abs = resolve(input);

  // Fix #1: If file exists, normalize the full path including the file itself
  // This prevents symlink bypass: /tmp/db.duckdb -> /var/index.duckdb
  if (existsSync(abs)) {
    try {
      return realpathSync.native(abs);
    } catch {
      // Fallback to parent normalization if full path fails
      // (e.g., permissions issue)
    }
  }

  // File doesn't exist yet - normalize parent and append filename
  const parentDir = dirname(abs);
  const filename = basename(abs);

  try {
    // Normalize parent directory to canonical form
    const canonicalParent = realpathSync.native(parentDir);
    return join(canonicalParent, filename);
  } catch {
    // Parent directory doesn't exist yet - caller should have called ensureDbParentDir
    // Return unnormalized path as fallback (will cause issues!)
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

/**
 * リポジトリパスを正規化して返す。realpath に失敗した場合は resolve 結果を使用する。
 */
export function normalizeRepoPath(input: string): string {
  const abs = resolve(input);
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
}

/**
 * 旧バージョンのパス表現（resolve ベース）との互換性を保つための候補一覧を返す。
 * 配列の先頭は正規化済みパス。
 */
export function getRepoPathCandidates(input: string): string[] {
  const normalized = normalizeRepoPath(input);
  const legacy = resolve(input);
  const candidates = [normalized];
  if (legacy !== normalized) {
    candidates.push(legacy);
  }
  return candidates;
}
