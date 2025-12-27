import { existsSync, renameSync, unlinkSync } from "node:fs";
import { access, constants, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { runIndexer } from "../indexer/cli.js";
import { isDocumentMetadataEmpty } from "../indexer/schema.js";
import { DuckDBClient } from "../shared/duckdb.js";
import { acquireLock, releaseLock, getLockOwner, LockfileError } from "../shared/utils/lockfile.js";
import { ensureDbParentDir, normalizeDbPath } from "../shared/utils/path.js";

/**
 * Check if migration requires a full reindex
 * Returns true if:
 * - file table has records (existing indexed files)
 * - document_metadata table is empty (migration just ran)
 *
 * @param databasePath - Absolute path to database
 * @returns true if reindex is needed, false if not needed or error occurred
 */
const AUTO_REINDEX_ON_CORRUPTION_ENV = "KIRI_AUTO_REINDEX_ON_CORRUPTION";

type DatabaseStateCheck = {
  migrationNeeded: boolean;
  corruptionDetected: boolean;
};

function envFlagEnabled(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  return ["1", "true", "yes", "on"].includes(normalized);
}

function isCorruptDatabaseError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message ?? "";
  const normalized = message.toLowerCase();
  const ioCorruptionHints =
    normalized.includes("deserializedeletes") ||
    (normalized.includes("deserialize") &&
      (normalized.includes("corrupted file") ||
        normalized.includes("vector_index") ||
        normalized.includes("row group size")));
  return (
    normalized.includes("serialization error") ||
    normalized.includes("failed to deserialize") ||
    normalized.includes("field id mismatch") ||
    normalized.includes("database file is not compatible") ||
    normalized.includes("file is not a database") ||
    (normalized.includes("catalog error") && normalized.includes("type")) ||
    (normalized.includes("io error") && ioCorruptionHints)
  );
}

function backupDatabaseFiles(databasePath: string): string[] {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const candidates = [databasePath, `${databasePath}.wal`, `${databasePath}.tmp`];
  const backedUp: string[] = [];

  for (const file of candidates) {
    if (!existsSync(file)) {
      continue;
    }
    const backupPath = `${file}.bak-${timestamp}`;
    try {
      renameSync(file, backupPath);
      backedUp.push(backupPath);
    } catch (error) {
      const err = error as Error;
      throw new Error(
        `Failed to backup ${file}: ${err.message}. Stop other daemon processes and retry.`
      );
    }
  }

  return backedUp;
}

async function needsMigrationReindex(databasePath: string): Promise<DatabaseStateCheck> {
  let db: DuckDBClient | null = null;
  try {
    db = await DuckDBClient.connect({ databasePath });

    // Check if file table has any records
    const filesExist = await db.all<{ count: number }>(`SELECT COUNT(*) as count FROM file`);

    // Defensive: check array element exists and has valid count
    const firstRow = filesExist[0];
    if (!firstRow || typeof firstRow.count !== "number") {
      return { migrationNeeded: false, corruptionDetected: false };
    }

    const hasFiles = firstRow.count > 0;

    // Check if document_metadata table is empty
    const metadataEmpty = await isDocumentMetadataEmpty(db);

    // Migration needed if files exist but metadata is empty
    return { migrationNeeded: hasFiles && metadataEmpty, corruptionDetected: false };
  } catch (error) {
    if (isCorruptDatabaseError(error)) {
      return { migrationNeeded: false, corruptionDetected: true };
    }
    // On any other error (missing table, etc.), assume no migration needed
    // The subsequent indexing attempt will surface the real error
    return { migrationNeeded: false, corruptionDetected: false };
  } finally {
    if (db) {
      await db.close();
    }
  }
}

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
  await ensureDbParentDir(databasePath);
  const absoluteDatabasePath = normalizeDbPath(databasePath);
  const absoluteRepoRoot = resolve(repoRoot);
  const lockfilePath = `${absoluteDatabasePath}.lock`;
  const autoReindexOnCorruption = envFlagEnabled(process.env[AUTO_REINDEX_ON_CORRUPTION_ENV], true);
  let backupAttempted = false;
  let backupSucceeded = false;

  const dbExists = existsSync(absoluteDatabasePath);

  // Check if migration or corruption requires reindex
  const { migrationNeeded, corruptionDetected } = dbExists
    ? await needsMigrationReindex(absoluteDatabasePath)
    : { migrationNeeded: false, corruptionDetected: false };

  if (corruptionDetected && !autoReindexOnCorruption) {
    const message =
      "Corrupt or incompatible database detected. " +
      `Set ${AUTO_REINDEX_ON_CORRUPTION_ENV}=1 or run a full reindex.`;
    process.stderr.write(`❌ ${message}\n`);
    throw new Error(message);
  }

  const corruptionReindex = dbExists && corruptionDetected && autoReindexOnCorruption;

  const shouldIndex = !dbExists || forceReindex || migrationNeeded || corruptionReindex;

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
      process.stderr.write(`⚠️  Another indexing process${ownerInfo} is already running.\n`);
      process.stderr.write(`   Please wait for it to complete and try again.\n`);
      process.exit(1);
    }
    throw error;
  }

  try {
    // データベースの親ディレクトリを自動作成（.kiri/ などが存在しない場合）
    const dbDir = dirname(absoluteDatabasePath);
    await mkdir(dbDir, { recursive: true });

    // Pre-flight filesystem permission checks
    try {
      await access(absoluteRepoRoot, constants.R_OK);
      await access(dbDir, constants.W_OK);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      process.stderr.write(`❌ Filesystem permission error: ${err.message}\n`);
      process.stderr.write(`   • Ensure read access to: ${absoluteRepoRoot}\n`);
      process.stderr.write(`   • Ensure write access to: ${dbDir}\n`);
      throw error;
    }

    if (corruptionReindex) {
      backupAttempted = true;
      const backups = backupDatabaseFiles(absoluteDatabasePath);
      backupSucceeded = true;
      if (backups.length > 0) {
        process.stderr.write(`ℹ️  Backed up corrupted database files:\n`);
        for (const backup of backups) {
          process.stderr.write(`   • ${backup}\n`);
        }
      }
    }

    // Run indexer
    const reason = corruptionReindex
      ? `Corrupt or incompatible database detected (${AUTO_REINDEX_ON_CORRUPTION_ENV}=1)`
      : migrationNeeded
        ? "Document metadata migration detected"
        : forceReindex
          ? "Manual reindex requested"
          : "Database not found";
    process.stderr.write(`⚠️  ${reason}. Running indexer for ${absoluteRepoRoot}...\n`);

    await runIndexer({
      repoRoot: absoluteRepoRoot,
      databasePath: absoluteDatabasePath,
      full: true,
      skipLocking: true,
    });

    process.stderr.write(`✅ Indexing complete. Database created at ${absoluteDatabasePath}\n`);
    return true;
  } catch (error) {
    // Log the error
    process.stderr.write(
      `❌ Indexing failed: ${error instanceof Error ? error.message : String(error)}\n`
    );

    const skipCleanup = corruptionReindex && backupAttempted && !backupSucceeded;
    if (skipCleanup) {
      process.stderr.write(`⚠️  Skipping cleanup because database backup did not complete.\n`);
    }

    // Clean up partial database to prevent corrupt DB usage on next startup
    // DuckDB creates multiple files (.duckdb, .duckdb.wal, .duckdb.tmp)
    if (!skipCleanup && existsSync(absoluteDatabasePath)) {
      process.stderr.write(`ℹ️  Cleaning up partially created database...\n`);

      const dbFiles = [
        absoluteDatabasePath,
        `${absoluteDatabasePath}.wal`,
        `${absoluteDatabasePath}.tmp`,
      ];

      let cleanupSuccess = true;
      for (const file of dbFiles) {
        if (existsSync(file)) {
          try {
            unlinkSync(file);
          } catch (cleanupError) {
            cleanupSuccess = false;
            process.stderr.write(
              `❌ Failed to delete ${file}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`
            );
          }
        }
      }

      if (cleanupSuccess) {
        process.stderr.write(`✅ Cleanup successful.\n`);
      }
    }

    // Handle degraded mode
    if (allowDegrade) {
      process.stderr.write(`⚠️  Continuing in degraded mode (--allow-degrade is set)\n`);
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
