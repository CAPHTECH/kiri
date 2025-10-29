import { access, constants } from "node:fs/promises";
import { existsSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { runIndexer } from "../indexer/cli.js";
import { acquireLock, releaseLock, getLockOwner, LockfileError } from "../shared/utils/lockfile.js";

/**
 * Ensures the database is indexed before server startup.
 * Implements file locking to prevent concurrent indexing and includes
 * comprehensive error handling for filesystem issues.
 *
 * @param repoRoot - Repository root path (relative or absolute)
 * @param databasePath - Database file path (relative or absolute)
 * @param allowDegrade - Whether to allow server startup even if indexing fails
 * @param forceReindex - Force reindexing even if database exists
 * @returns true if database is ready, false if running in degraded mode
 */
export async function ensureDatabaseIndexed(
  repoRoot: string,
  databasePath: string,
  allowDegrade: boolean,
  forceReindex: boolean
): Promise<boolean> {
  const absoluteDatabasePath = resolve(databasePath);
  const absoluteRepoRoot = resolve(repoRoot);
  const lockfilePath = `${absoluteDatabasePath}.lock`;
  const shouldIndex = !existsSync(absoluteDatabasePath) || forceReindex;

  if (!shouldIndex) {
    // Database exists and no reindex requested
    return true;
  }

  // Acquire lock to prevent concurrent indexing
  try {
    acquireLock(lockfilePath);
  } catch (error) {
    if (error instanceof LockfileError) {
      const ownerPid = error.ownerPid ?? getLockOwner(lockfilePath);
      const ownerInfo = ownerPid ? ` (PID: ${ownerPid})` : "";
      process.stderr.write(
        `⚠️  Another indexing process${ownerInfo} is already running.\n`
      );
      process.stderr.write(`   Please wait for it to complete and try again.\n`);
      process.exit(1);
    }
    throw error;
  }

  try {
    // Pre-flight filesystem permission checks
    try {
      await access(absoluteRepoRoot, constants.R_OK);
      await access(dirname(absoluteDatabasePath), constants.W_OK);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      process.stderr.write(`❌ Filesystem permission error: ${err.message}\n`);
      process.stderr.write(`   • Ensure read access to: ${absoluteRepoRoot}\n`);
      process.stderr.write(`   • Ensure write access to: ${dirname(absoluteDatabasePath)}\n`);
      throw error;
    }

    // Run indexer
    const reason = forceReindex ? "Manual reindex requested" : "Database not found";
    process.stderr.write(`⚠️  ${reason}. Running indexer for ${absoluteRepoRoot}...\n`);

    await runIndexer({
      repoRoot: absoluteRepoRoot,
      databasePath: absoluteDatabasePath,
      full: true,
    });

    process.stderr.write(`✅ Indexing complete. Database created at ${absoluteDatabasePath}\n`);
    return true;
  } catch (error) {
    // Log the error
    process.stderr.write(
      `❌ Indexing failed: ${error instanceof Error ? error.message : String(error)}\n`
    );

    // Clean up partial database to prevent corrupt DB usage on next startup
    if (existsSync(absoluteDatabasePath)) {
      process.stderr.write(`ℹ️  Cleaning up partially created database...\n`);
      try {
        unlinkSync(absoluteDatabasePath);
        process.stderr.write(`✅ Cleanup successful.\n`);
      } catch (cleanupError) {
        process.stderr.write(
          `❌ Failed to clean up database file: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`
        );
      }
    }

    // Handle degraded mode
    if (allowDegrade) {
      process.stderr.write(
        `⚠️  Continuing in degraded mode (--allow-degrade is set)\n`
      );
      process.stderr.write(
        `   The server will start but indexing features will not be available.\n`
      );
      return false;
    }

    process.stderr.write(`💡 Tip: Use --allow-degrade to start server despite indexing failure\n`);
    throw error;
  } finally {
    // Always release the lock
    releaseLock(lockfilePath);
  }
}
