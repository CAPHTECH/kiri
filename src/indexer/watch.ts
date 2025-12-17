import { realpathSync, mkdirSync } from "node:fs";
import { resolve, relative, sep, dirname, isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";

import watcher, { type AsyncSubscription, type Event } from "@parcel/watcher";

import { acquireLock, releaseLock, getLockOwner, LockfileError } from "../shared/utils/lockfile.js";
import { normalizeDbPath, normalizeRepoPath } from "../shared/utils/path.js";

import { runIndexer } from "./cli.js";
import { createDenylistFilter, type DenylistFilter } from "./pipeline/filters/denylist.js";

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
 * - Uses @parcel/watcher for efficient native recursive watching (FSEvents on macOS, etc.)
 * - Debouncing: Aggregates rapid consecutive changes to minimize reindex operations
 * - Denylist Integration: Respects both denylist.yml and .gitignore patterns
 * - Lock Management: Prevents concurrent indexing using lock files
 * - Graceful Shutdown: Supports AbortSignal for clean process termination
 * - Statistics: Tracks reindex count, duration, and queue depth
 *
 * Implementation Note:
 * Uses @parcel/watcher instead of chokidar for better performance and
 * to avoid EMFILE (too many open files) errors on large repositories.
 * @parcel/watcher uses native OS APIs (FSEvents, inotify, etc.) that
 * efficiently watch entire directory trees without per-file descriptors.
 */
export class IndexWatcher {
  private readonly options: {
    repoRoot: string;
    databasePath: string;
    debounceMs: number;
    configPath?: string;
    signal?: AbortSignal;
  };
  private readonly rawRepoRoot: string;
  private subscription: AsyncSubscription | null = null;
  private reindexTimer: NodeJS.Timeout | null = null;
  private isReindexing = false;
  private reindexPromise: Promise<void> | null = null;
  private pendingReindex = false;
  private pendingFiles = new Set<string>();
  private readonly stats: WatcherStatistics;
  private readonly lockfilePath: string;
  private readonly realpathCache = new Map<string, string>();
  private isStopping = false; // Flag to prevent new reindexes during shutdown
  private denylistFilter: DenylistFilter | null = null;
  private ignoredRelativePaths = new Set<string>();

  constructor(options: IndexWatcherOptions) {
    this.rawRepoRoot = resolve(options.repoRoot);
    const repoRoot = normalizeRepoPath(this.rawRepoRoot);
    let databasePath: string;

    // Ensure parent directory exists BEFORE normalization
    // This guarantees consistent path normalization on first and subsequent runs
    try {
      const parentDir = dirname(resolve(options.databasePath));
      mkdirSync(parentDir, { recursive: true });
    } catch {
      // Ignore if already exists or permission denied
    }

    // Critical: Use normalizeDbPath to ensure consistent path with cli.ts
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

  private getCachedRealPath(absPath: string): string | null {
    const cached = this.realpathCache.get(absPath);
    if (cached) {
      return cached;
    }

    try {
      const realPath = realpathSync.native(absPath);
      this.realpathCache.set(absPath, realPath);
      if (this.realpathCache.size > 2048) {
        const key = this.realpathCache.keys().next().value;
        if (key) {
          this.realpathCache.delete(key);
        }
      }
      return realPath;
    } catch {
      return null;
    }
  }

  /**
   * Normalizes absolute file path to repository-relative path.
   *
   * Strategy:
   * - Use path.relative() instead of string replacement
   * - Normalize path separator to forward slash (git-compatible)
   * - Reject paths outside repository (security check)
   * - Reject Windows cross-drive paths and UNC paths
   * - Resolve symlinks to prevent bypass via junctions/symlinks
   *
   * @param absPath - Absolute path from file watcher
   * @returns Git-compatible relative path, or null if outside repo
   */
  private normalizePathForRepo(absPath: string): string | null {
    const rel = relative(this.options.repoRoot, absPath);

    // Security - Reject paths outside repository
    if (
      rel.startsWith("..") ||
      isAbsolute(rel) ||
      /^[A-Za-z]:/.test(rel) ||
      rel.startsWith("\\\\") ||
      rel.startsWith("//")
    ) {
      return null;
    }

    // Additional safety - Resolve symlinks once and cache the result
    const realAbsPath = this.getCachedRealPath(absPath);
    if (realAbsPath) {
      const realRepoRoot = this.options.repoRoot;
      const realRel = relative(realRepoRoot, realAbsPath);

      if (realRel.startsWith("..") || isAbsolute(realRel)) {
        return null;
      }
    }

    // Normalize to forward slash for cross-platform compatibility
    return rel.split(sep).join("/");
  }

  /**
   * Checks if a path should be ignored based on denylist and internal paths.
   *
   * @param relativePath - Repository-relative path (forward slashes)
   * @returns true if the path should be ignored
   */
  private shouldIgnore(relativePath: string): boolean {
    // Always ignore git internals
    if (relativePath === ".git" || relativePath.startsWith(".git/")) {
      return true;
    }

    // Ignore database-related files to prevent loops
    if (this.ignoredRelativePaths.has(relativePath)) {
      return true;
    }

    // Check denylist (includes .gitignore patterns)
    if (this.denylistFilter && this.denylistFilter.isDenied(relativePath)) {
      return true;
    }

    return false;
  }

  /**
   * Starts the file watcher and begins monitoring for changes.
   *
   * Uses @parcel/watcher for efficient native recursive watching.
   * This avoids EMFILE errors that occur with chokidar on large repositories.
   *
   * @throws {Error} If the watcher is already running
   */
  async start(): Promise<void> {
    if (this.subscription !== null) {
      throw new Error("IndexWatcher is already running. Call stop() before starting again.");
    }

    // Load denylist patterns
    this.denylistFilter = createDenylistFilter(this.options.repoRoot, this.options.configPath);

    // Build ignore list for database files
    const relativeDbPath = this.normalizePathForRepo(this.options.databasePath);
    this.ignoredRelativePaths.clear();
    if (relativeDbPath) {
      this.ignoredRelativePaths.add(relativeDbPath);
      this.ignoredRelativePaths.add(`${relativeDbPath}.wal`);
      this.ignoredRelativePaths.add(`${relativeDbPath}.tmp`);
      this.ignoredRelativePaths.add(`${relativeDbPath}.lock`);
      this.ignoredRelativePaths.add(`${relativeDbPath}.sock`);
      this.ignoredRelativePaths.add(`${relativeDbPath}.daemon.log`);
      this.ignoredRelativePaths.add(`${relativeDbPath}.daemon.pid`);
      this.ignoredRelativePaths.add(`${relativeDbPath}.daemon.starting`);
    }

    // Build ignore patterns for @parcel/watcher
    // Note: @parcel/watcher's ignore option uses micromatch globs
    const ignorePatterns: string[] = [
      "**/.git/**",
      "**/.git",
      "**/node_modules/**", // Common pattern to reduce noise
    ];

    // Add database path patterns
    if (relativeDbPath) {
      const dbDir = dirname(relativeDbPath);
      if (dbDir && dbDir !== ".") {
        // Ignore the entire .kiri directory if db is in .kiri/
        ignorePatterns.push(`**/${dbDir}/**`);
      }
    }

    try {
      // Subscribe to file changes using @parcel/watcher
      // @parcel/watcher uses native OS APIs (FSEvents on macOS, inotify on Linux)
      // which efficiently watch entire directory trees without per-file descriptors
      this.subscription = await watcher.subscribe(
        this.options.repoRoot,
        (err: Error | null, events: Event[]) => {
          if (err) {
            process.stderr.write(`❌ File watcher error: ${err.message}\n`);
            return;
          }

          // Process each event
          for (const event of events) {
            this.handleEvent(event);
          }
        },
        {
          ignore: ignorePatterns,
        }
      );

      process.stderr.write(
        `👁️  Watch mode started (native). Monitoring ${this.options.repoRoot} for changes...\n`
      );
      process.stderr.write(`   Debounce: ${this.options.debounceMs}ms\n`);
      process.stderr.write(`   Backend: @parcel/watcher (FSEvents/inotify)\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to start watch mode: ${message}`);
    }
  }

  /**
   * Handles a single file system event from @parcel/watcher.
   *
   * @param event - The file system event containing type and path
   */
  private handleEvent(event: Event): void {
    // Don't process events if stopping
    if (this.isStopping) {
      return;
    }

    const relativePath = this.normalizePathForRepo(event.path);

    // Ignore paths outside repository or invalid
    if (relativePath === null) {
      return;
    }

    // Check if path should be ignored (denylist, .git, db files)
    if (this.shouldIgnore(relativePath)) {
      return;
    }

    // Schedule reindex for this file
    this.scheduleReindex(event.type, event.path);
  }

  /**
   * Schedules a reindex operation with debouncing.
   *
   * Multiple rapid changes are aggregated into a single reindex operation.
   *
   * @param event - Type of file event (create/update/delete)
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

      // Capture snapshot BEFORE clearing to prevent data loss
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
   * @param changedPaths - Array of file paths that changed
   */
  private async executeReindex(changedPaths: string[]): Promise<void> {
    // Don't start reindex if watcher is stopping
    if (this.isStopping) {
      process.stderr.write(`🛑 Watcher stopping. Skipping reindex.\n`);
      return;
    }

    // Check if already reindexing
    if (this.isReindexing) {
      // Restore changedPaths back to pendingFiles to prevent data loss
      for (const path of changedPaths) {
        this.pendingFiles.add(path);
      }

      process.stderr.write(
        `⏳ Reindex already in progress. Will reindex again after completion.\n`
      );
      this.pendingReindex = true;
      return;
    }

    this.isReindexing = true;
    this.pendingReindex = false;
    this.stats.lastReindexStart = performance.now();

    // Create and store the reindex promise for proper shutdown handling
    this.reindexPromise = (async () => {
      // Track lock ownership to prevent releasing locks we don't own
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
          lockAcquired = true;
        } catch (error) {
          if (error instanceof LockfileError) {
            // Restore changedPaths to pendingFiles to prevent data loss
            for (const path of changedPaths) {
              this.pendingFiles.add(path);
            }
            this.pendingReindex = true;

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
          repoRoot: this.rawRepoRoot,
          databasePath: this.options.databasePath,
          full: false,
          changedPaths,
          skipLocking: true, // Watcher already holds the lock
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
        // Restore changedPaths for ALL errors to prevent data loss
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

        // Only release lock if we acquired it
        if (lockAcquired) {
          releaseLock(this.lockfilePath);
        }

        this.reindexPromise = null;

        // Clear timer to prevent resource leak
        if (this.reindexTimer !== null) {
          clearTimeout(this.reindexTimer);
          this.reindexTimer = null;
        }

        // If more changes occurred during reindex, trigger direct retry
        if (this.pendingReindex && this.pendingFiles.size > 0) {
          process.stderr.write(
            `🔁 New changes detected during reindex. Scheduling another reindex...\n`
          );

          this.reindexTimer = setTimeout(() => {
            this.reindexTimer = null;
            const changedPaths = Array.from(this.pendingFiles);
            this.pendingFiles.clear();
            void this.executeReindex(changedPaths);
          }, this.options.debounceMs);
        }
      }
    })();

    await this.reindexPromise;
  }

  /**
   * Stops the file watcher and cleans up resources.
   *
   * Waits for any ongoing reindex to complete before stopping.
   */
  async stop(): Promise<void> {
    if (this.subscription === null) {
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

    // Wait for ongoing reindex to complete
    if (this.reindexPromise !== null) {
      await this.reindexPromise;
    }

    // Unsubscribe from @parcel/watcher
    await this.subscription.unsubscribe();
    this.subscription = null;

    // Print final statistics
    const uptime = Math.round((performance.now() - this.stats.watcherStartTime) / 1000);
    process.stderr.write(
      `📊 Final stats: ${this.stats.reindexCount} reindexes, ${uptime}s uptime\n`
    );
    process.stderr.write(`✅ Watch mode stopped.\n`);
  }

  /**
   * Returns current watcher statistics.
   */
  getStatistics(): Readonly<WatcherStatistics> {
    return { ...this.stats };
  }

  /**
   * Checks if the watcher is currently running.
   */
  isRunning(): boolean {
    return this.subscription !== null;
  }
}
