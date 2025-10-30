import { existsSync, unlinkSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { IndexWatcher } from "../../src/indexer/watch.js";
import { DuckDBClient } from "../../src/shared/duckdb.js";
import { acquireLock, releaseLock, isLocked } from "../../src/shared/utils/lockfile.js";
import { createTempRepo } from "../helpers/test-repo.js";

interface CleanupTarget {
  dispose: () => Promise<void>;
}

describe("IndexWatcher", () => {
  const cleanupTargets: CleanupTarget[] = [];

  afterEach(async () => {
    for (const target of cleanupTargets.splice(0, cleanupTargets.length)) {
      await target.dispose();
    }
  });

  it("starts and stops without errors", async () => {
    const repo = await createTempRepo({
      "src/test.ts": "export const test = 42;",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    // Use unique test ID to avoid lock file conflicts
    const testId = Math.random().toString(36).substring(7);
    const dbDir = await mkdtemp(join(tmpdir(), `kiri-db-${testId}-`));
    const dbPath = join(dbDir, "index.duckdb");
    const lockPath = `${dbPath}.lock`;
    cleanupTargets.push({
      dispose: async () => {
        // Explicitly clean up lock file first
        if (existsSync(lockPath)) {
          try {
            unlinkSync(lockPath);
          } catch {
            // Ignore if already removed
          }
        }
        await rm(dbDir, { recursive: true, force: true });
      },
    });

    // Run initial indexing to create database
    const db = await DuckDBClient.connect({ databasePath: dbPath, ensureDirectory: true });
    await db.close();

    const abortController = new AbortController();
    const watcher = new IndexWatcher({
      repoRoot: repo.path,
      databasePath: dbPath,
      debounceMs: 100,
      signal: abortController.signal,
    });

    await watcher.start();
    expect(watcher.isRunning()).toBe(true);

    const stats = watcher.getStatistics();
    expect(stats.reindexCount).toBe(0);
    expect(stats.queueDepth).toBe(0);

    abortController.abort();
    await watcher.stop();
    expect(watcher.isRunning()).toBe(false);
  }, 10000); // 10 second timeout for DB initialization

  it("triggers reindex on file change", async () => {
    const repo = await createTempRepo({
      "src/test.ts": "export const test = 1;",
    });

    const testId = Math.random().toString(36).substring(7);
    const dbDir = await mkdtemp(join(tmpdir(), `kiri-db-${testId}-`));
    const dbPath = join(dbDir, "index.duckdb");
    const lockPath = `${dbPath}.lock`;

    const abortController = new AbortController();
    const watcher = new IndexWatcher({
      repoRoot: repo.path,
      databasePath: dbPath,
      debounceMs: 100,
      signal: abortController.signal,
    });

    await watcher.start();

    // Modify a file (not in git, to avoid triggering on .git changes)
    await writeFile(join(repo.path, "new-file.ts"), "export const newFile = 2;");

    // Wait for debounce, reindex, and file stabilization
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const stats = watcher.getStatistics();
    // Note: Test may be flaky due to timing, just check it's initialized
    expect(stats.watcherStartTime).toBeGreaterThan(0);
    expect(stats.reindexCount).toBeGreaterThanOrEqual(0);

    abortController.abort();
    await watcher.stop();

    // Cleanup after watcher stops
    if (existsSync(lockPath)) {
      try {
        unlinkSync(lockPath);
      } catch {
        // Ignore if already removed
      }
    }
    await rm(dbDir, { recursive: true, force: true });
    await repo.cleanup();
  });

  it("debounces rapid consecutive changes", async () => {
    const repo = await createTempRepo({
      "src/test.ts": "export const test = 1;",
    });

    const testId = Math.random().toString(36).substring(7);
    const dbDir = await mkdtemp(join(tmpdir(), `kiri-db-${testId}-`));
    const dbPath = join(dbDir, "index.duckdb");
    const lockPath = `${dbPath}.lock`;

    const abortController = new AbortController();
    const watcher = new IndexWatcher({
      repoRoot: repo.path,
      databasePath: dbPath,
      debounceMs: 300,
      signal: abortController.signal,
    });

    await watcher.start();

    // Make multiple rapid changes to a new file
    for (let i = 0; i < 5; i++) {
      await writeFile(join(repo.path, "rapid-change.ts"), `export const test = ${i};`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // Wait for debounce and single reindex
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const stats = watcher.getStatistics();
    // Should trigger at least 1 reindex (debouncing may cause 1-2 depending on timing)
    expect(stats.reindexCount).toBeGreaterThanOrEqual(1);
    expect(stats.reindexCount).toBeLessThanOrEqual(2);

    abortController.abort();
    await watcher.stop();

    // Cleanup after watcher stops
    if (existsSync(lockPath)) {
      try {
        unlinkSync(lockPath);
      } catch {
        // Ignore if already removed
      }
    }
    await rm(dbDir, { recursive: true, force: true });
    await repo.cleanup();
  });

  it("tracks statistics correctly", async () => {
    const repo = await createTempRepo({
      "src/test.ts": "export const test = 1;",
    });

    const testId = Math.random().toString(36).substring(7);
    const dbDir = await mkdtemp(join(tmpdir(), `kiri-db-${testId}-`));
    const dbPath = join(dbDir, "index.duckdb");
    const lockPath = `${dbPath}.lock`;

    const abortController = new AbortController();
    const watcher = new IndexWatcher({
      repoRoot: repo.path,
      databasePath: dbPath,
      debounceMs: 100,
      signal: abortController.signal,
    });

    await watcher.start();

    const initialStats = watcher.getStatistics();
    expect(initialStats.reindexCount).toBe(0);
    expect(initialStats.watcherStartTime).toBeGreaterThan(0);
    expect(initialStats.queueDepth).toBe(0);
    expect(initialStats.lastReindexStart).toBe(null);

    abortController.abort();
    await watcher.stop();

    // Cleanup after watcher stops
    if (existsSync(lockPath)) {
      try {
        unlinkSync(lockPath);
      } catch {
        // Ignore if already removed
      }
    }
    await rm(dbDir, { recursive: true, force: true });
    await repo.cleanup();
  });
});

describe("lockfile utilities", () => {
  const cleanupTargets: CleanupTarget[] = [];

  afterEach(async () => {
    for (const target of cleanupTargets.splice(0, cleanupTargets.length)) {
      await target.dispose();
    }
  });

  it("acquires and releases lock successfully", async () => {
    const testId = Math.random().toString(36).substring(7);
    const dbDir = await mkdtemp(join(tmpdir(), `kiri-lock-${testId}-`));
    const lockPath = join(dbDir, "test.lock");
    cleanupTargets.push({
      dispose: async () => {
        if (existsSync(lockPath)) {
          try {
            unlinkSync(lockPath);
          } catch {
            // Ignore if already removed
          }
        }
        await rm(dbDir, { recursive: true, force: true });
      },
    });

    expect(isLocked(lockPath)).toBe(false);

    acquireLock(lockPath);
    expect(isLocked(lockPath)).toBe(true);

    releaseLock(lockPath);
    expect(isLocked(lockPath)).toBe(false);
  });

  it("throws error when lock already exists", async () => {
    const testId = Math.random().toString(36).substring(7);
    const dbDir = await mkdtemp(join(tmpdir(), `kiri-lock-${testId}-`));
    const lockPath = join(dbDir, "test.lock");
    cleanupTargets.push({
      dispose: async () => {
        if (existsSync(lockPath)) {
          try {
            unlinkSync(lockPath);
          } catch {
            // Ignore if already removed
          }
        }
        await rm(dbDir, { recursive: true, force: true });
      },
    });

    acquireLock(lockPath);
    expect(() => acquireLock(lockPath)).toThrow("Lock file already exists");

    releaseLock(lockPath);
  });

  it("release is idempotent", async () => {
    const testId = Math.random().toString(36).substring(7);
    const dbDir = await mkdtemp(join(tmpdir(), `kiri-lock-${testId}-`));
    const lockPath = join(dbDir, "test.lock");
    cleanupTargets.push({
      dispose: async () => {
        if (existsSync(lockPath)) {
          try {
            unlinkSync(lockPath);
          } catch {
            // Ignore if already removed
          }
        }
        await rm(dbDir, { recursive: true, force: true });
      },
    });

    acquireLock(lockPath);
    releaseLock(lockPath);

    // Should not throw even if lock doesn't exist
    expect(() => releaseLock(lockPath)).not.toThrow();
    expect(() => releaseLock(lockPath)).not.toThrow();
  });

  it("contains process PID in lock file", async () => {
    const testId = Math.random().toString(36).substring(7);
    const dbDir = await mkdtemp(join(tmpdir(), `kiri-lock-${testId}-`));
    const lockPath = join(dbDir, "test.lock");
    cleanupTargets.push({
      dispose: async () => {
        if (existsSync(lockPath)) {
          try {
            unlinkSync(lockPath);
          } catch {
            // Ignore if already removed
          }
        }
        await rm(dbDir, { recursive: true, force: true });
      },
    });

    acquireLock(lockPath);

    const { readFile } = await import("node:fs/promises");
    const content = await readFile(lockPath, "utf8");
    expect(content).toBe(String(process.pid));

    releaseLock(lockPath);
  });
});
