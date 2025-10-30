import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * Lockfile management for preventing concurrent indexing operations.
 *
 * Uses atomic file creation (wx flag) to ensure only one process acquires the lock.
 * Lock files contain the PID of the owning process for debugging.
 *
 * Features stale lock detection: If a lock file exists but the owning process
 * is no longer running, the lock is automatically removed and reacquired.
 */

export class LockfileError extends Error {
  constructor(
    message: string,
    public readonly lockfilePath: string,
    public readonly ownerPid?: number
  ) {
    super(message);
    this.name = "LockfileError";
  }
}

/**
 * Checks if a process with the given PID is currently running.
 *
 * @param pid - Process ID to check
 * @returns true if process exists, false otherwise
 */
function isProcessRunning(pid: number): boolean {
  try {
    // Signal 0 doesn't kill the process, just checks if it exists
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH means process doesn't exist
    return false;
  }
}

/**
 * Attempts to acquire a lock file atomically.
 *
 * If lock exists but owning process is dead, removes stale lock and retries.
 *
 * @param lockfilePath - Path to the lock file (e.g., "/path/to/db.duckdb.lock")
 * @throws {LockfileError} If the lock is already held by another running process
 */
export function acquireLock(lockfilePath: string): void {
  try {
    writeFileSync(lockfilePath, String(process.pid), { flag: "wx" });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "EEXIST") {
      // Check if lock is stale (owning process is dead)
      try {
        const existingPidStr = readFileSync(lockfilePath, "utf8");
        const existingPid = parseInt(existingPidStr, 10);

        if (!isNaN(existingPid) && !isProcessRunning(existingPid)) {
          // Stale lock detected - double-check before removing to prevent PID reuse race
          process.stderr.write(`⚠️  Removing stale lock file (PID ${existingPid} not running)\n`);

          // Re-verify PID hasn't been reused (TOCTOU mitigation)
          if (existsSync(lockfilePath)) {
            const recheckPidStr = readFileSync(lockfilePath, "utf8");
            const recheckPid = parseInt(recheckPidStr, 10);

            // Only remove if PID still matches and process still dead
            if (!isNaN(recheckPid) && recheckPid === existingPid && !isProcessRunning(recheckPid)) {
              unlinkSync(lockfilePath);

              // Retry acquisition (should succeed now)
              writeFileSync(lockfilePath, String(process.pid), { flag: "wx" });
              return;
            }
          }

          // Lock file changed or PID was reused - throw error
          throw new LockfileError(
            `Lock file changed during stale check. Another process may be active.`,
            lockfilePath,
            existingPid
          );
        }

        // Lock is held by a running process
        throw new LockfileError(
          `Lock file already exists. Another process is indexing.`,
          lockfilePath,
          existingPid
        );
      } catch (lockError) {
        // If it's already a LockfileError, rethrow it
        if (lockError instanceof LockfileError) {
          throw lockError;
        }
        // If we can't read the PID, treat as active lock for safety
        throw new LockfileError(
          `Lock file already exists. Another process may be indexing.`,
          lockfilePath
        );
      }
    }
    throw err;
  }
}

/**
 * Releases a previously acquired lock file.
 *
 * Silently succeeds if the lock file doesn't exist (idempotent).
 *
 * @param lockfilePath - Path to the lock file to release
 */
export function releaseLock(lockfilePath: string): void {
  try {
    if (existsSync(lockfilePath)) {
      unlinkSync(lockfilePath);
    }
  } catch {
    // Ignore errors during cleanup - lock may have been manually removed
    // or process killed before lock was created
  }
}

/**
 * Checks if a lock file currently exists.
 *
 * @param lockfilePath - Path to the lock file to check
 * @returns true if lock file exists, false otherwise
 */
export function isLocked(lockfilePath: string): boolean {
  return existsSync(lockfilePath);
}

/**
 * Gets the PID of the process that owns the lock file.
 *
 * @param lockfilePath - Path to the lock file to check
 * @returns PID of the owning process, or null if file doesn't exist or can't be read
 */
export function getLockOwner(lockfilePath: string): number | null {
  try {
    if (existsSync(lockfilePath)) {
      const pidStr = readFileSync(lockfilePath, "utf8");
      const pid = parseInt(pidStr, 10);
      return isNaN(pid) ? null : pid;
    }
  } catch {
    return null;
  }
  return null;
}
