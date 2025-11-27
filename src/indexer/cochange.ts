/**
 * Co-change Graph Extraction (Phase 4: Graph Layer)
 *
 * This module extracts co-change relationships from git commit history.
 * Files that frequently change together in commits have higher co-change scores.
 *
 * Invariants (from Alloy/TLA+ specs):
 * - CC1: Canonical ordering (file1 < file2 lexicographically)
 * - CC2: Both files exist in the file table
 * - CC3: Positive weight (cochange_count > 0)
 * - CC4: Idempotent commit processing
 *
 * Metrics computed:
 * - cochange_count: Number of commits where both files changed together
 * - confidence: Jaccard similarity = |A ∩ B| / |A ∪ B|
 */

import { execSync } from "node:child_process";

import type { DuckDBClient } from "../shared/duckdb.js";

/**
 * Configuration for co-change extraction
 */
export interface CochangeConfig {
  /** Maximum number of commits to analyze (default: 1000) */
  maxCommits: number;
  /** Minimum co-change count to persist (default: 2) */
  minCochangeCount: number;
  /** Maximum files per commit to avoid mega-commits (default: 50) */
  maxFilesPerCommit: number;
  /** Only consider commits within this many days (default: 365) */
  maxAgeDays: number;
}

const DEFAULT_CONFIG: CochangeConfig = {
  maxCommits: 1000,
  minCochangeCount: 2,
  maxFilesPerCommit: 50,
  maxAgeDays: 365,
};

/**
 * Parsed commit from git log
 */
interface GitCommit {
  hash: string;
  files: string[];
  timestamp: Date;
}

/**
 * Create canonical pair ensuring file1 < file2 (CC1)
 * Uses lexicographic comparison for deterministic ordering.
 */
export function canonicalPair(file1: string, file2: string): [string, string] {
  return file1 < file2 ? [file1, file2] : [file2, file1];
}

/**
 * Generate all unique pairs from a set of files.
 * Returns pairs in canonical order (file1 < file2).
 */
export function generatePairs(files: string[]): [string, string][] {
  const pairs: [string, string][] = [];
  const sorted = [...files].sort();

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const f1 = sorted[i];
      const f2 = sorted[j];
      if (f1 !== undefined && f2 !== undefined) {
        pairs.push([f1, f2]);
      }
    }
  }

  return pairs;
}

/**
 * Extract commits from git log.
 * Returns commits with their changed files.
 */
export function extractCommitsFromGit(repoPath: string, config: CochangeConfig): GitCommit[] {
  const commits: GitCommit[] = [];

  try {
    // Get commit hashes with timestamps
    // Format: hash|timestamp (ISO 8601)
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - config.maxAgeDays);
    const sinceArg = sinceDate.toISOString().split("T")[0];

    const logOutput = execSync(
      `git log --format="%H|%aI" --since="${sinceArg}" -n ${config.maxCommits}`,
      {
        cwd: repoPath,
        encoding: "utf-8",
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large repos
      }
    );

    const commitLines = logOutput.trim().split("\n").filter(Boolean);

    for (const line of commitLines) {
      const [hash, timestampStr] = line.split("|");
      if (!hash || !timestampStr) continue;

      // Get files changed in this commit
      const filesOutput = execSync(`git diff-tree --no-commit-id --name-only -r ${hash}`, {
        cwd: repoPath,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });

      const files = filesOutput
        .trim()
        .split("\n")
        .filter(Boolean)
        .filter((f) => !f.startsWith(".git/"));

      // Skip mega-commits (likely auto-generated or initial commits)
      if (files.length > config.maxFilesPerCommit) {
        continue;
      }

      // Skip single-file commits (no pairs possible)
      if (files.length < 2) {
        continue;
      }

      commits.push({
        hash,
        files,
        timestamp: new Date(timestampStr),
      });
    }
  } catch (error) {
    console.warn("[Cochange] Failed to extract git history:", error);
  }

  return commits;
}

/**
 * Check if a commit has already been processed (CC4: Idempotent)
 */
async function isCommitProcessed(
  db: DuckDBClient,
  repoId: number,
  commitHash: string
): Promise<boolean> {
  const result = await db.all<{ count: number }>(
    `SELECT COUNT(*) as count FROM processed_commits
     WHERE repo_id = ? AND commit_hash = ?`,
    [repoId, commitHash]
  );
  return (result[0]?.count ?? 0) > 0;
}

/**
 * Mark a commit as processed (CC4: Idempotent)
 */
async function markCommitProcessed(
  db: DuckDBClient,
  repoId: number,
  commitHash: string
): Promise<void> {
  await db.run(
    `INSERT INTO processed_commits (repo_id, commit_hash, processed_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT DO NOTHING`,
    [repoId, commitHash]
  );
}

/**
 * Get set of indexed files for a repo (CC2: Both files exist)
 */
async function getIndexedFiles(db: DuckDBClient, repoId: number): Promise<Set<string>> {
  const files = await db.all<{ path: string }>(`SELECT path FROM file WHERE repo_id = ?`, [repoId]);
  return new Set(files.map((f) => f.path));
}

/**
 * Update co-change counts for a single commit.
 * Creates pairs for all changed files and increments counts.
 */
async function processCommitCochange(
  db: DuckDBClient,
  repoId: number,
  commit: GitCommit,
  indexedFiles: Set<string>,
  fileChangeCounts: Map<string, number>
): Promise<void> {
  // Filter to only indexed files (CC2)
  const validFiles = commit.files.filter((f) => indexedFiles.has(f));

  if (validFiles.length < 2) {
    return; // Need at least 2 files for pairs
  }

  // Update file change counts
  for (const file of validFiles) {
    fileChangeCounts.set(file, (fileChangeCounts.get(file) ?? 0) + 1);
  }

  // Generate all pairs (CC1: canonical ordering)
  const pairs = generatePairs(validFiles);

  // Update co-change counts
  for (const [file1, file2] of pairs) {
    await db.run(
      `INSERT INTO cochange (repo_id, file1, file2, cochange_count, last_commit, last_cochange_at)
       VALUES (?, ?, ?, 1, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (repo_id, file1, file2) DO UPDATE SET
         cochange_count = cochange_count + 1,
         last_commit = excluded.last_commit,
         last_cochange_at = excluded.last_cochange_at`,
      [repoId, file1, file2, commit.hash]
    );
  }
}

/**
 * Calculate Jaccard confidence for all co-change edges.
 * confidence = cochange_count / (changes_file1 + changes_file2 - cochange_count)
 *
 * This is run after all commits are processed.
 */
async function updateJaccardConfidence(
  db: DuckDBClient,
  repoId: number,
  fileChangeCounts: Map<string, number>
): Promise<void> {
  // Get all co-change edges
  const edges = await db.all<{ file1: string; file2: string; cochange_count: number }>(
    `SELECT file1, file2, cochange_count FROM cochange WHERE repo_id = ?`,
    [repoId]
  );

  for (const edge of edges) {
    const count1 = fileChangeCounts.get(edge.file1) ?? 0;
    const count2 = fileChangeCounts.get(edge.file2) ?? 0;

    // Jaccard = intersection / union
    // intersection = cochange_count
    // union = changes_file1 + changes_file2 - cochange_count
    const union = count1 + count2 - edge.cochange_count;
    const confidence = union > 0 ? edge.cochange_count / union : 0;

    await db.run(
      `UPDATE cochange SET confidence = ?
       WHERE repo_id = ? AND file1 = ? AND file2 = ?`,
      [confidence, repoId, edge.file1, edge.file2]
    );
  }
}

/**
 * Prune co-change edges below minimum threshold (CC3: Positive weight)
 */
async function pruneWeakEdges(
  db: DuckDBClient,
  repoId: number,
  minCochangeCount: number
): Promise<number> {
  // Count rows to be deleted first
  const countResult = await db.all<{ count: number }>(
    `SELECT COUNT(*) as count FROM cochange
     WHERE repo_id = ? AND cochange_count < ?`,
    [repoId, minCochangeCount]
  );
  const toDelete = countResult[0]?.count ?? 0;

  // Delete the rows
  await db.run(
    `DELETE FROM cochange
     WHERE repo_id = ? AND cochange_count < ?`,
    [repoId, minCochangeCount]
  );
  return toDelete;
}

/**
 * Compute co-change graph from git history.
 * Main entry point for co-change extraction.
 *
 * @param db - DuckDB client
 * @param repoId - Repository ID
 * @param repoPath - Path to git repository
 * @param config - Optional configuration
 */
export async function computeCochangeGraph(
  db: DuckDBClient,
  repoId: number,
  repoPath: string,
  config: Partial<CochangeConfig> = {}
): Promise<{ processedCommits: number; edges: number; prunedEdges: number }> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  console.info(`[Cochange] Computing co-change graph for repo ${repoId}...`);

  // Get indexed files (CC2)
  const indexedFiles = await getIndexedFiles(db, repoId);
  if (indexedFiles.size === 0) {
    console.info("[Cochange] No indexed files, skipping");
    return { processedCommits: 0, edges: 0, prunedEdges: 0 };
  }

  // Extract commits from git
  const commits = extractCommitsFromGit(repoPath, cfg);
  console.info(`[Cochange] Found ${commits.length} commits to analyze`);

  // Track file change counts for Jaccard calculation
  const fileChangeCounts = new Map<string, number>();
  let processedCount = 0;

  // Process each commit
  for (const commit of commits) {
    // Check idempotency (CC4)
    const alreadyProcessed = await isCommitProcessed(db, repoId, commit.hash);
    if (alreadyProcessed) {
      continue;
    }

    // Process co-change pairs
    await processCommitCochange(db, repoId, commit, indexedFiles, fileChangeCounts);

    // Mark as processed (CC4)
    await markCommitProcessed(db, repoId, commit.hash);
    processedCount++;
  }

  console.info(`[Cochange] Processed ${processedCount} new commits`);

  // Update Jaccard confidence scores only if we processed new commits
  // Skip when processedCount is 0 to avoid zeroing existing confidence values
  if (processedCount > 0) {
    await updateJaccardConfidence(db, repoId, fileChangeCounts);
  }

  // Prune weak edges (CC3)
  const prunedCount = await pruneWeakEdges(db, repoId, cfg.minCochangeCount);

  // Get final edge count
  const edgeCount = await db.all<{ count: number }>(
    `SELECT COUNT(*) as count FROM cochange WHERE repo_id = ?`,
    [repoId]
  );

  console.info(`[Cochange] Completed: ${edgeCount[0]?.count ?? 0} edges, ${prunedCount} pruned`);

  return {
    processedCommits: processedCount,
    edges: edgeCount[0]?.count ?? 0,
    prunedEdges: prunedCount,
  };
}

/**
 * Incremental co-change update for new commits.
 * Called during watch mode or incremental indexing.
 *
 * @param db - DuckDB client
 * @param repoId - Repository ID
 * @param repoPath - Path to git repository
 * @param sinceCommit - Only process commits after this one
 */
export async function incrementalCochangeUpdate(
  db: DuckDBClient,
  repoId: number,
  repoPath: string,
  sinceCommit?: string
): Promise<{ processedCommits: number }> {
  console.info(`[Cochange] Incremental update for repo ${repoId}...`);

  const indexedFiles = await getIndexedFiles(db, repoId);
  const fileChangeCounts = new Map<string, number>();

  // Build file change counts from existing data
  const existingEdges = await db.all<{ file1: string; file2: string }>(
    `SELECT DISTINCT file1, file2 FROM cochange WHERE repo_id = ?`,
    [repoId]
  );

  // Note: This is a simplified approximation. Full recalc would be more accurate.
  for (const edge of existingEdges) {
    fileChangeCounts.set(edge.file1, (fileChangeCounts.get(edge.file1) ?? 0) + 1);
    fileChangeCounts.set(edge.file2, (fileChangeCounts.get(edge.file2) ?? 0) + 1);
  }

  // Extract recent commits
  const cfg = { ...DEFAULT_CONFIG, maxCommits: 100, maxAgeDays: 30 };
  const commits = extractCommitsFromGit(repoPath, cfg);

  let processedCount = 0;
  for (const commit of commits) {
    // Skip if already processed
    if (await isCommitProcessed(db, repoId, commit.hash)) {
      continue;
    }

    // Skip if before sinceCommit (optimization)
    if (sinceCommit && commit.hash === sinceCommit) {
      break;
    }

    await processCommitCochange(db, repoId, commit, indexedFiles, fileChangeCounts);
    await markCommitProcessed(db, repoId, commit.hash);
    processedCount++;
  }

  // Update confidence scores
  if (processedCount > 0) {
    await updateJaccardConfidence(db, repoId, fileChangeCounts);
  }

  console.info(`[Cochange] Incremental update: ${processedCount} commits`);

  return { processedCommits: processedCount };
}

/**
 * Remove co-change edges involving a deleted file.
 * Called when files are removed from the index.
 *
 * Maintains CC2 invariant (both files exist).
 */
export async function removeFileCochange(
  db: DuckDBClient,
  repoId: number,
  filePath: string
): Promise<number> {
  // Count rows to be deleted first
  const countResult = await db.all<{ count: number }>(
    `SELECT COUNT(*) as count FROM cochange
     WHERE repo_id = ? AND (file1 = ? OR file2 = ?)`,
    [repoId, filePath, filePath]
  );
  const toDelete = countResult[0]?.count ?? 0;

  // Delete the rows
  await db.run(
    `DELETE FROM cochange
     WHERE repo_id = ? AND (file1 = ? OR file2 = ?)`,
    [repoId, filePath, filePath]
  );
  return toDelete;
}

/**
 * Get co-change neighbors for a file.
 * Returns files that frequently change together with the target file.
 */
export async function getCochangeNeighbors(
  db: DuckDBClient,
  repoId: number,
  filePath: string,
  limit = 10
): Promise<{ path: string; count: number; confidence: number }[]> {
  // Query both directions (file can be in file1 or file2)
  const results = await db.all<{ path: string; count: number; confidence: number }>(
    `SELECT
       CASE WHEN file1 = ? THEN file2 ELSE file1 END as path,
       cochange_count as count,
       confidence
     FROM cochange
     WHERE repo_id = ? AND (file1 = ? OR file2 = ?)
     ORDER BY cochange_count DESC, confidence DESC
     LIMIT ?`,
    [filePath, repoId, filePath, filePath, limit]
  );

  return results;
}
