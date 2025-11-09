import { realpathSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";

import { watch, type FSWatcher } from "chokidar";

import { acquireLock, releaseLock, getLockOwner, LockfileError } from "../shared/utils/lockfile.js";
import { normalizeDbPath } from "../shared/utils/path.js";

import { runIndexer } from "./cli.js";
import { createDenylistFilter } from "./pipeline/filters/denylist.js";

/**
 * Configuration options for IndexWatcher.
 */
export interface IndexWatcherOptions {
  /** Absolute path to repository root */
  repoRoot: string;
  /** Absolute path to DuckDB database file */
  databasePath: string;
  /** Debounce time in milliseconds (default: 500ms) */
  debounceMs?: number;
  /** Optional path to denylist config */
  configPath?: string;
  /** Optional AbortSignal for graceful shutdown */
  signal?: AbortSignal;
}

/**
 * Statistics tracked by the file watcher.
 */
export interface WatcherStatistics {
  /** Total number of reindex operations completed */
  reindexCount: number;
  /** Duration of last reindex in milliseconds */
  lastReindexDuration: number;
  /** Number of file events currently queued */
  queueDepth: number;
  /** Timestamp of last reindex start */
  lastReindexStart: number | null;
  /** Timestamp of watcher start */
  watcherStartTime: number;
}

/**
 * IndexWatcher monitors filesystem changes and triggers automatic reindexing.
 *
 * Features:
 * - Debouncing: Aggregates rapid consecutive changes to minimize reindex operations
 * - Denylist Integration: Respects both denylist.yml and .gitignore patterns
 * - Lock Management: Prevents concurrent indexing using lock files
 * - Graceful Shutdown: Supports AbortSignal for clean process termination
 * - Statistics: Tracks reindex count, duration, and queue depth
 *
 * Implementation Note:
 * Uses incremental reindex (hash-based change detection) for performance.
 * Only files with changed content hashes are re-parsed and updated in the database.
 * This provides significant speedup for watch mode while maintaining consistency.
 */
export class IndexWatcher {
  private readonly options: {
    repoRoot: string;
    databasePath: string;
    debounceMs: number;
    configPath?: string;
    signal?: AbortSignal;
  };
  private watcher: FSWatcher | null = null;
  private reindexTimer: NodeJS.Timeout | null = null;
  private isReindexing = false;
  private reindexPromise: Promise<void> | null = null;
  private pendingReindex = false;
  private pendingFiles = new Set<string>();
  private readonly stats: WatcherStatistics;
  private readonly lockfilePath: string;
  private isStopping = false; // Flag to prevent new reindexes during shutdown

  constructor(options: IndexWatcherOptions) {
    // Fix #2: Normalize paths to prevent lock/queue bypass via symlinks or OS aliases
    // repoRoot: Use realpathSync for existing directories
    // databasePath: Use normalizeDbPath helper (handles non-existent DB files safely)
    let repoRoot: string;
    let databasePath: string;

    try {
      repoRoot = realpathSync.native(resolve(options.repoRoot));
    } catch {
      repoRoot = resolve(options.repoRoot);
    }

    // Critical: Use normalizeDbPath to ensure consistent path with cli.ts
    // This prevents lock file and queue key mismatch
    databasePath = normalizeDbPath(options.databasePath);

    this.options = {
      repoRoot,
      databasePath,
      debounceMs: options.debounceMs ?? 500,
    };

    if (options.configPath) {
      this.options.configPath = options.configPath;
    }

    if (options.signal) {
      this.options.signal = options.signal;
    }

    this.lockfilePath = `${this.options.databasePath}.lock`;

    this.stats = {
      reindexCount: 0,
      lastReindexDuration: 0,
      queueDepth: 0,
      lastReindexStart: null,
      watcherStartTime: performance.now(),
    };

    // Handle abort signal if provided
    if (this.options.signal) {
      this.options.signal.addEventListener("abort", () => {
        void this.stop();
      });
    }
  }

  /**
   * Normalizes absolute file path to repository-relative path.
   *
   * Fix #3: Proper cross-platform path handling to prevent denylist bypass on Windows.
   *
   * Strategy:
   * - Use path.relative() instead of string replacement
   * - Normalize path separator to forward slash (git-compatible)
   * - Reject paths outside repository (security check)
   *
   * @param absPath - Absolute path from file watcher
   * @returns Git-compatible relative path, or null if outside repo
   */
  private normalizePathForRepo(absPath: string): string | null {
    const rel = relative(this.options.repoRoot, absPath);

    // Security: Reject paths outside repository
    // ".." indicates parent directory traversal
    if (rel.startsWith("..") || rel === "") {
      return null;
    }

    // Normalize to forward slash for cross-platform compatibility
    // Windows uses backslash, but git and denylist rules expect forward slash
    return rel.split(sep).join("/");
  }

  /**
   * Starts the file watcher and begins monitoring for changes.
   *
   * @throws {Error} If the watcher is already running
   */
  async start(): Promise<void> {
    if (this.watcher !== null) {
      throw new Error("IndexWatcher is already running. Call stop() before starting again.");
    }

    // Load denylist patterns
    const denylistFilter = createDenylistFilter(this.options.repoRoot, this.options.configPath);

    // Configure chokidar with denylist and editor-specific options
    this.watcher = watch(this.options.repoRoot, {
      persistent: true,
      ignoreInitial: true, // Don't trigger on existing files
      ignored: (path: string) => {
        const relativePath = this.normalizePathForRepo(path);
        // Reject paths outside repo or invalid paths
        if (!relativePath) return true;
        return denylistFilter.isDenied(relativePath);
      },
      // Editor-specific handling
      awaitWriteFinish: {
        stabilityThreshold: 200, // Wait 200ms for file to stabilize
        pollInterval: 100,
      },
      // Performance tuning
      usePolling: false, // Use native OS events (faster)
      // depth option omitted for no depth limit
    });

    // Register event handlers
    this.watcher
      .on("add", (path) => this.scheduleReindex("add", path))
      .on("change", (path) => this.scheduleReindex("change", path))
      .on("unlink", (path) => this.scheduleReindex("unlink", path))
      .on("error", (error) => {
        process.stderr.write(
          `❌ File watcher error: ${error instanceof Error ? error.message : String(error)}\n`
        );
      })
      .on("ready", () => {
        process.stderr.write(
          `👁️  Watch mode started. Monitoring ${this.options.repoRoot} for changes...\n`
        );
        process.stderr.write(`   Debounce: ${this.options.debounceMs}ms\n`);
      });
  }

  /**
   * Schedules a reindex operation with debouncing.
   *
   * Multiple rapid changes are aggregated into a single reindex operation.
   *
   * @param event - Type of file event (add/change/unlink)
   * @param path - Absolute path to the changed file
   */
  private scheduleReindex(event: string, path: string): void {
    // Don't schedule new reindexes if watcher is stopping
    if (this.isStopping) {
      return;
    }

    const relativePath = this.normalizePathForRepo(path);
    // Ignore paths outside repository (security check)
    if (!relativePath) {
      return;
    }
    this.pendingFiles.add(relativePath);

    // Clear existing timer if present
    if (this.reindexTimer !== null) {
      clearTimeout(this.reindexTimer);
    }

    // Set new timer with debounce
    this.reindexTimer = setTimeout(() => {
      this.reindexTimer = null;
      this.stats.queueDepth = this.pendingFiles.size;

      // Log aggregated changes
      const fileList = Array.from(this.pendingFiles).slice(0, 5).join(", ");
      const moreCount = Math.max(0, this.pendingFiles.size - 5);
      const summary = moreCount > 0 ? `${fileList} (+${moreCount} more)` : fileList;

      process.stderr.write(`\n📝 File changes detected: ${summary}\n`);

      // Fix #3 & #4: Capture snapshot BEFORE clearing to prevent data loss and enable incremental indexing
      const changedPaths = Array.from(this.pendingFiles);
      this.pendingFiles.clear();

      // Pass snapshot to executeReindex
      void this.executeReindex(changedPaths);
    }, this.options.debounceMs);

    // Mark pending flag (used if reindex is already running)
    this.pendingReindex = true;
  }

  /**
   * Executes an incremental reindex operation for changed files only.
   *
   * If a reindex is already in progress, marks a pending flag to trigger
   * another reindex after the current one completes.
   *
   * @param changedPaths - Array of file paths that changed (Fix #3 & #4: snapshot from scheduleReindex)
   */
  private async executeReindex(changedPaths: string[]): Promise<void> {
    // Don't start reindex if watcher is stopping
    if (this.isStopping) {
      process.stderr.write(`🛑 Watcher stopping. Skipping reindex.\n`);
      return;
    }

    // Check if already reindexing
    if (this.isReindexing) {
      process.stderr.write(
        `⏳ Reindex already in progress. Will reindex again after completion.\n`
      );
      this.pendingReindex = true;
      return;
    }

    this.isReindexing = true;
    this.pendingReindex = false;
    this.stats.lastReindexStart = performance.now();

    // Fix #3 & #4: Use changedPaths parameter (snapshot from scheduleReindex) instead of reading pendingFiles
    // This prevents data loss on lock contention and enables true incremental indexing

    // Create and store the reindex promise for proper shutdown handling
    this.reindexPromise = (async () => {
      // Fix #1: Track lock ownership to prevent releasing locks we don't own
      let lockAcquired = false;

      try {
        // Double-check stopping flag before acquiring lock
        if (this.isStopping) {
          process.stderr.write(`🛑 Watcher stopping. Skipping reindex.\n`);
          return;
        }

        // Acquire lock to prevent concurrent indexing
        try {
          acquireLock(this.lockfilePath);
          lockAcquired = true; // Fix #1: Only set to true on successful acquisition
        } catch (error) {
          if (error instanceof LockfileError) {
            // Fix #3: Restore changedPaths to pendingFiles to prevent data loss
            for (const path of changedPaths) {
              this.pendingFiles.add(path);
            }
            this.pendingReindex = true; // Mark for retry when lock is available

            const ownerPid = error.ownerPid ?? getLockOwner(this.lockfilePath);
            const ownerInfo = ownerPid ? ` (PID: ${ownerPid})` : "";
            process.stderr.write(
              `⚠️  Another indexing process${ownerInfo} holds the lock. Changes queued for retry.\n`
            );
            return;
          }
          throw error;
        }

        // Run incremental reindex for changed files only
        const start = performance.now();
        process.stderr.write(`🔄 Incrementally reindexing ${changedPaths.length} file(s)...\n`);

        await runIndexer({
          repoRoot: this.options.repoRoot,
          databasePath: this.options.databasePath,
          full: false,
          changedPaths,
          skipLocking: true, // Fix #1: Watcher already holds the lock
        });

        const duration = performance.now() - start;
        this.stats.reindexCount++;
        this.stats.lastReindexDuration = duration;
        this.stats.queueDepth = 0;

        process.stderr.write(`✅ Incremental reindex complete in ${Math.round(duration)}ms\n`);

        // Periodic statistics (every 10 reindexes)
        if (this.stats.reindexCount % 10 === 0) {
          const uptime = Math.round((performance.now() - this.stats.watcherStartTime) / 1000);
          process.stderr.write(
            `📊 Watcher stats: ${this.stats.reindexCount} reindexes, ${uptime}s uptime\n`
          );
        }
      } catch (error) {
        // Fix #2: Restore changedPaths for ALL errors, not just LockfileError
        // This prevents permanent data loss when reindex fails due to:
        // - Database I/O errors
        // - Parsing failures
        // - Network timeouts
        // - Any other transient errors
        for (const path of changedPaths) {
          this.pendingFiles.add(path);
        }
        this.pendingReindex = true;

        process.stderr.write(
          `❌ Reindex failed: ${error instanceof Error ? error.message : String(error)}\n`
        );
        process.stderr.write(`   Changes queued for retry on next file event.\n`);
      } finally {
        this.isReindexing = false;

        // Fix #1: Only release lock if we acquired it (prevents deleting other process's locks)
        if (lockAcquired) {
          releaseLock(this.lockfilePath);
        }

        this.reindexPromise = null;

        // Clear timer to prevent resource leak
        if (this.reindexTimer !== null) {
          clearTimeout(this.reindexTimer);
          this.reindexTimer = null;
        }

        // If more changes occurred during reindex, schedule another one
        if (this.pendingReindex) {
          process.stderr.write(
            `🔁 New changes detected during reindex. Scheduling another reindex...\n`
          );
          this.scheduleReindex("batch", "(multiple files)");
        }
      }
    })();

    await this.reindexPromise;
  }

  /**
   * Stops the file watcher and cleans up resources.
   *
   * Waits for any ongoing reindex to complete before stopping.
   * Uses the reindex promise to ensure proper synchronization.
   */
  async stop(): Promise<void> {
    if (this.watcher === null) {
      return; // Already stopped
    }

    process.stderr.write(`\n🛑 Stopping watch mode...\n`);

    // Set stopping flag FIRST to prevent new reindex operations
    this.isStopping = true;

    // Clear pending timer
    if (this.reindexTimer !== null) {
      clearTimeout(this.reindexTimer);
      this.reindexTimer = null;
    }

    // Wait for ongoing reindex to complete using the promise
    // This is more reliable than polling isReindexing flag
    if (this.reindexPromise !== null) {
      await this.reindexPromise;
    }

    // Close watcher
    await this.watcher.close();
    this.watcher = null;

    // Print final statistics
    const uptime = Math.round((performance.now() - this.stats.watcherStartTime) / 1000);
    process.stderr.write(
      `📊 Final stats: ${this.stats.reindexCount} reindexes, ${uptime}s uptime\n`
    );
    process.stderr.write(`✅ Watch mode stopped.\n`);
  }

  /**
   * Returns current watcher statistics.
   *
   * Useful for monitoring and diagnostics.
   */
  getStatistics(): Readonly<WatcherStatistics> {
    return { ...this.stats };
  }

  /**
   * Checks if the watcher is currently running.
   */
  isRunning(): boolean {
    return this.watcher !== null;
  }
}
