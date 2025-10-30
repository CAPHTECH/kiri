import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { watch, type FSWatcher } from "chokidar";

import { acquireLock, releaseLock, getLockOwner, LockfileError } from "../shared/utils/lockfile.js";

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
 * Uses full reindex (not incremental) for simplicity and consistency.
 * This approach ensures no stale data or broken dependencies.
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
    this.options = {
      repoRoot: resolve(options.repoRoot),
      databasePath: resolve(options.databasePath),
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
        const relativePath = path.replace(this.options.repoRoot + "/", "");
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

    const relativePath = path.replace(this.options.repoRoot + "/", "");
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

      // Clear pending files and trigger reindex
      this.pendingFiles.clear();
      void this.executeReindex();
    }, this.options.debounceMs);

    // Mark pending flag (used if reindex is already running)
    this.pendingReindex = true;
  }

  /**
   * Executes a full reindex operation.
   *
   * If a reindex is already in progress, marks a pending flag to trigger
   * another reindex after the current one completes.
   */
  private async executeReindex(): Promise<void> {
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

    // Create and store the reindex promise for proper shutdown handling
    this.reindexPromise = (async () => {
      try {
        // Double-check stopping flag before acquiring lock
        if (this.isStopping) {
          process.stderr.write(`🛑 Watcher stopping. Skipping reindex.\n`);
          return;
        }

        // Acquire lock to prevent concurrent indexing
        try {
          acquireLock(this.lockfilePath);
        } catch (error) {
          if (error instanceof LockfileError) {
            const ownerPid = error.ownerPid ?? getLockOwner(this.lockfilePath);
            const ownerInfo = ownerPid ? ` (PID: ${ownerPid})` : "";
            process.stderr.write(
              `⚠️  Another indexing process${ownerInfo} holds the lock. Skipping this reindex.\n`
            );
            return;
          }
          throw error;
        }

        // Run full reindex
        const start = performance.now();
        process.stderr.write(`🔄 Reindexing ${this.options.repoRoot}...\n`);

        await runIndexer({
          repoRoot: this.options.repoRoot,
          databasePath: this.options.databasePath,
          full: true,
        });

        const duration = performance.now() - start;
        this.stats.reindexCount++;
        this.stats.lastReindexDuration = duration;
        this.stats.queueDepth = 0;

        process.stderr.write(`✅ Reindex complete in ${Math.round(duration)}ms\n`);

        // Periodic statistics (every 10 reindexes)
        if (this.stats.reindexCount % 10 === 0) {
          const uptime = Math.round((performance.now() - this.stats.watcherStartTime) / 1000);
          process.stderr.write(
            `📊 Watcher stats: ${this.stats.reindexCount} reindexes, ${uptime}s uptime\n`
          );
        }
      } catch (error) {
        process.stderr.write(
          `❌ Reindex failed: ${error instanceof Error ? error.message : String(error)}\n`
        );
        process.stderr.write(`   Watch mode continues. Next change will trigger reindex.\n`);
      } finally {
        this.isReindexing = false;
        releaseLock(this.lockfilePath);
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
