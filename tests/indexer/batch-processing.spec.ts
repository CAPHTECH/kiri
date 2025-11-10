/**
 * Test suite for batch processing logic in large dataset scenarios.
 * Ensures that indexer can handle thousands of files without stack overflow.
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { runIndexer } from "../../src/indexer/cli.js";
import { DuckDBClient } from "../../src/shared/duckdb.js";

describe("Batch Processing for Large Datasets", () => {
  const LONG_TIMEOUT = process.env.CI ? 120_000 : 60_000;
  let repoDir: string;
  let dbPath: string;
  let db: DuckDBClient;

  beforeEach(() => {
    // Create temporary repository directory
    const timestamp = Date.now();
    repoDir = join(tmpdir(), `kiri-batch-test-${timestamp}`);
    dbPath = join(tmpdir(), `kiri-batch-test-${timestamp}.duckdb`);

    mkdirSync(repoDir, { recursive: true });

    // Initialize git repository
    execSync("git init", { cwd: repoDir });
    execSync('git config user.name "Test User"', { cwd: repoDir });
    execSync('git config user.email "test@example.com"', { cwd: repoDir });
  });

  afterEach(async () => {
    // Cleanup - each operation is independent to ensure all resources are freed
    try {
      if (db) {
        await db.close();
      }
    } catch (error) {
      console.error("Failed to close database:", error);
    }

    try {
      rmSync(repoDir, { recursive: true, force: true });
    } catch (error) {
      console.error("Failed to remove repository directory:", error);
    }

    try {
      rmSync(dbPath, { force: true });
    } catch (error) {
      console.error("Failed to remove database file:", error);
    }
  });

  it(
    "handles exactly batch boundary (7500 files for 4-column table)",
    async () => {
      // Create exactly 7500 files (30000 / 4 columns = 7500 batch size for blobs)
      const fileCount = 7500;

      for (let i = 0; i < fileCount; i++) {
        const filePath = join(repoDir, `file_${i}.txt`);
        writeFileSync(filePath, `Content of file ${i}\n`);
      }

      // Commit files
      execSync("git add .", { cwd: repoDir });
      execSync('git commit -m "Add test files"', { cwd: repoDir });

      // Run indexer - should not throw stack overflow
      await expect(
        runIndexer({
          repoRoot: repoDir,
          databasePath: dbPath,
          full: true,
        })
      ).resolves.not.toThrow();

      // Verify all files were indexed
      db = await DuckDBClient.connect({ databasePath: dbPath });
      const rows = await db.all<{ count: bigint }>("SELECT COUNT(*) as count FROM file");
      expect(Number(rows[0]?.count)).toBe(fileCount);
    },
    LONG_TIMEOUT
  );

  it(
    "handles 10000+ files without stack overflow",
    async () => {
      // Create 10000 files to test large dataset
      const fileCount = 10000;

      for (let i = 0; i < fileCount; i++) {
        const filePath = join(repoDir, `file_${i}.txt`);
        // All files have identical content to test blob deduplication
        writeFileSync(filePath, `Identical content\nLine 2\nLine 3\n`);
      }

      // Commit files
      execSync("git add .", { cwd: repoDir });
      execSync('git commit -m "Add many test files"', { cwd: repoDir });

      // Run indexer - should not throw stack overflow
      await expect(
        runIndexer({
          repoRoot: repoDir,
          databasePath: dbPath,
          full: true,
        })
      ).resolves.not.toThrow();

      // Verify all files were indexed
      db = await DuckDBClient.connect({ databasePath: dbPath });
      const fileRows = await db.all<{ count: bigint }>("SELECT COUNT(*) as count FROM file");
      expect(Number(fileRows[0]?.count)).toBe(fileCount);

      // Verify blobs were deduplicated correctly (all files have same content)
      const blobRows = await db.all<{ count: bigint }>("SELECT COUNT(*) as count FROM blob");
      expect(Number(blobRows[0]?.count)).toBe(1); // All files have identical content
    },
    LONG_TIMEOUT
  );

  it(
    "handles batch boundary +1 (7501 files)",
    async () => {
      // Test edge case: one file over the batch boundary
      const fileCount = 7501;

      for (let i = 0; i < fileCount; i++) {
        const filePath = join(repoDir, `file_${i}.txt`);
        writeFileSync(filePath, `Content ${i}`); // Different content to avoid deduplication
      }

      // Commit files
      execSync("git add .", { cwd: repoDir });
      execSync('git commit -m "Add files at boundary"', { cwd: repoDir });

      // Run indexer
      await expect(
        runIndexer({
          repoRoot: repoDir,
          databasePath: dbPath,
          full: true,
        })
      ).resolves.not.toThrow();

      // Verify counts
      db = await DuckDBClient.connect({ databasePath: dbPath });
      const fileRows = await db.all<{ count: bigint }>("SELECT COUNT(*) as count FROM file");
      expect(Number(fileRows[0]?.count)).toBe(fileCount);

      const blobRows = await db.all<{ count: bigint }>("SELECT COUNT(*) as count FROM blob");
      expect(Number(blobRows[0]?.count)).toBe(fileCount); // Each file has unique content
    },
    LONG_TIMEOUT
  );

  it(
    "maintains data integrity across batches",
    async () => {
      // Create files with specific patterns to verify data integrity
      const fileCount = 5000;

      for (let i = 0; i < fileCount; i++) {
        const filePath = join(repoDir, `batch_test_${i}.txt`);
        writeFileSync(filePath, `Batch test file number ${i}\n`);
      }

      // Commit files
      execSync("git add .", { cwd: repoDir });
      execSync('git commit -m "Batch integrity test"', { cwd: repoDir });

      // Run indexer
      await runIndexer({
        repoRoot: repoDir,
        databasePath: dbPath,
        full: true,
      });

      // Verify specific files
      db = await DuckDBClient.connect({ databasePath: dbPath });

      // Check first file
      const firstFile = await db.all<{ path: string; content: string }>(
        `SELECT f.path, b.content
       FROM file f
       JOIN blob b ON f.blob_hash = b.hash
       WHERE f.path = 'batch_test_0.txt'`
      );
      expect(firstFile[0]?.content).toContain("number 0");

      // Check middle file (across batch boundary)
      const middleFile = await db.all<{ path: string; content: string }>(
        `SELECT f.path, b.content
       FROM file f
       JOIN blob b ON f.blob_hash = b.hash
       WHERE f.path = 'batch_test_4999.txt'`
      );
      expect(middleFile[0]?.content).toContain("number 4999");

      // Verify total count
      const totalRows = await db.all<{ count: bigint }>("SELECT COUNT(*) as count FROM file");
      expect(Number(totalRows[0]?.count)).toBe(fileCount);
    },
    LONG_TIMEOUT
  );
});
