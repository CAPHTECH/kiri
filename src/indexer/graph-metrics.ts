/**
 * Graph Metrics Computation (Phase 3.2: Graph Layer)
 *
 * This module computes graph centrality metrics from the dependency table
 * and stores them in precomputed tables for fast query-time lookup.
 *
 * Invariants (from Alloy spec):
 * - DG1: All path edges reference indexed files
 * - DG2: No self-loops
 * - DG4: Closure symmetry (outbound/inbound consistency)
 *
 * Metrics computed:
 * - Degree centrality (inbound/outbound counts)
 * - Importance score (PageRank-like)
 * - Inbound closure (BFS up to depth 3)
 */

import type { DuckDBClient } from "../shared/duckdb.js";

/**
 * Configuration for graph metrics computation
 */
export interface GraphMetricsConfig {
  /** Maximum BFS depth for inbound closure (default: 3) */
  maxDepth: number;
  /** PageRank damping factor (default: 0.85) */
  dampingFactor: number;
  /** Number of PageRank iterations (default: 10) */
  iterations: number;
}

const DEFAULT_CONFIG: GraphMetricsConfig = {
  maxDepth: 3,
  dampingFactor: 0.85,
  iterations: 10,
};

/** Minimum score floor to prevent division by zero during PageRank normalization */
const MIN_PAGERANK_SCORE = 0.001;

/**
 * Compute all graph metrics for a repository.
 * Called after dependency extraction during indexing.
 *
 * @param db - DuckDB client
 * @param repoId - Repository ID
 * @param config - Optional configuration
 */
export async function computeGraphMetrics(
  db: DuckDBClient,
  repoId: number,
  config: Partial<GraphMetricsConfig> = {}
): Promise<void> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  console.info(`[GraphMetrics] Computing metrics for repo ${repoId}...`);

  // Compute in parallel where possible
  await Promise.all([
    computeDegreeCentrality(db, repoId),
    precomputeInboundClosure(db, repoId, cfg.maxDepth),
  ]);

  // PageRank depends on degree centrality, so run after
  await computeImportanceScores(db, repoId, cfg.dampingFactor, cfg.iterations);

  console.info(`[GraphMetrics] Completed for repo ${repoId}`);
}

/**
 * Compute degree centrality (inbound and outbound counts).
 *
 * Uses SQL aggregation for efficiency.
 */
export async function computeDegreeCentrality(db: DuckDBClient, repoId: number): Promise<void> {
  // Clear existing metrics for this repo
  await db.run(`DELETE FROM graph_metrics WHERE repo_id = ?`, [repoId]);

  // Compute outbound counts (files this file imports)
  await db.run(
    `
    INSERT INTO graph_metrics (repo_id, path, outbound_count, inbound_count, importance_score, computed_at)
    SELECT
      repo_id,
      src_path as path,
      COUNT(*) as outbound_count,
      0 as inbound_count,
      0.0 as importance_score,
      CURRENT_TIMESTAMP as computed_at
    FROM dependency
    WHERE repo_id = ? AND dst_kind = 'path'
    GROUP BY repo_id, src_path
  `,
    [repoId]
  );

  // Update inbound counts (files that import this file)
  await db.run(
    `
    WITH inbound_counts AS (
      SELECT dst as path, COUNT(*) as cnt
      FROM dependency
      WHERE repo_id = ? AND dst_kind = 'path'
      GROUP BY dst
    )
    UPDATE graph_metrics
    SET inbound_count = COALESCE((
      SELECT ic.cnt FROM inbound_counts ic WHERE ic.path = graph_metrics.path
    ), 0)
    WHERE repo_id = ?
  `,
    [repoId, repoId]
  );

  // Insert files that only have inbound dependencies (not already in table)
  await db.run(
    `
    INSERT INTO graph_metrics (repo_id, path, outbound_count, inbound_count, importance_score, computed_at)
    SELECT
      ? as repo_id,
      dst as path,
      0 as outbound_count,
      COUNT(*) as inbound_count,
      0.0 as importance_score,
      CURRENT_TIMESTAMP as computed_at
    FROM dependency
    WHERE repo_id = ? AND dst_kind = 'path'
      AND dst NOT IN (SELECT path FROM graph_metrics WHERE repo_id = ?)
    GROUP BY dst
  `,
    [repoId, repoId, repoId]
  );
}

/**
 * Precompute inbound closure using BFS up to maxDepth.
 *
 * Uses recursive CTE for efficient computation.
 */
export async function precomputeInboundClosure(
  db: DuckDBClient,
  repoId: number,
  maxDepth: number
): Promise<void> {
  // Clear existing closure for this repo
  await db.run(`DELETE FROM inbound_edges WHERE repo_id = ?`, [repoId]);

  // Use recursive CTE to compute transitive closure
  // This computes: for each file, which files import it (directly or transitively)
  await db.run(
    `
    INSERT INTO inbound_edges (repo_id, target_path, source_path, depth)
    WITH RECURSIVE closure(target, source, depth) AS (
      -- Base case: direct inbound edges (depth 1)
      SELECT
        dst as target,
        src_path as source,
        1 as depth
      FROM dependency
      WHERE repo_id = ? AND dst_kind = 'path'

      UNION ALL

      -- Recursive case: follow inbound edges from sources
      SELECT
        c.target,
        d.src_path as source,
        c.depth + 1 as depth
      FROM closure c
      JOIN dependency d ON d.dst = c.source AND d.repo_id = ? AND d.dst_kind = 'path'
      WHERE c.depth < ?
        -- Avoid cycles: don't add source if it would equal target
        AND d.src_path != c.target
    )
    SELECT DISTINCT
      ? as repo_id,
      target as target_path,
      source as source_path,
      MIN(depth) as depth  -- Keep shortest path
    FROM closure
    GROUP BY target, source
  `,
    [repoId, repoId, maxDepth, repoId]
  );
}

/**
 * Compute importance scores using PageRank-like algorithm.
 *
 * This is a simplified PageRank that:
 * - Uses inbound edges for importance propagation
 * - Runs for a fixed number of iterations
 * - Normalizes scores to [0, 1]
 */
export async function computeImportanceScores(
  db: DuckDBClient,
  repoId: number,
  dampingFactor: number,
  iterations: number
): Promise<void> {
  // Get all files with their dependencies
  const files = await db.all<{ path: string }>(
    `SELECT DISTINCT path FROM graph_metrics WHERE repo_id = ?`,
    [repoId]
  );

  if (files.length === 0) {
    return;
  }

  const N = files.length;
  const baseProbability = (1 - dampingFactor) / N;

  // Initialize scores uniformly
  const scores = new Map<string, number>();
  for (const f of files) {
    scores.set(f.path, 1.0 / N);
  }

  // Load dependency edges (for outbound count)
  const edges = await db.all<{ src: string; dst: string }>(
    `
    SELECT src_path as src, dst as dst
    FROM dependency
    WHERE repo_id = ? AND dst_kind = 'path'
  `,
    [repoId]
  );

  // Build adjacency structure
  const outboundCount = new Map<string, number>();
  const inbound = new Map<string, string[]>();

  for (const e of edges) {
    // Count outbound edges
    outboundCount.set(e.src, (outboundCount.get(e.src) ?? 0) + 1);

    // Track inbound edges
    if (!inbound.has(e.dst)) {
      inbound.set(e.dst, []);
    }
    inbound.get(e.dst)!.push(e.src);
  }

  // Power iteration
  for (let i = 0; i < iterations; i++) {
    const newScores = new Map<string, number>();

    for (const [path] of scores) {
      let sum = 0;
      const inboundPaths = inbound.get(path) ?? [];

      for (const src of inboundPaths) {
        const srcScore = scores.get(src) ?? 0;
        const srcOutbound = outboundCount.get(src) ?? 1;
        sum += srcScore / srcOutbound;
      }

      newScores.set(path, baseProbability + dampingFactor * sum);
    }

    // Update scores
    for (const [path, score] of newScores) {
      scores.set(path, score);
    }
  }

  // Normalize to [0, 1]
  const maxScore = Math.max(...scores.values(), MIN_PAGERANK_SCORE);

  // Update database
  for (const [path, score] of scores) {
    const normalized = score / maxScore;
    await db.run(
      `UPDATE graph_metrics SET importance_score = ?, computed_at = CURRENT_TIMESTAMP
       WHERE repo_id = ? AND path = ?`,
      [normalized, repoId, path]
    );
  }
}

/**
 * Incrementally update graph metrics for changed files.
 * Used during incremental indexing to avoid full recomputation.
 *
 * @param db - DuckDB client
 * @param repoId - Repository ID
 * @param changedPaths - Paths that were added, modified, or removed
 */
export async function incrementalGraphUpdate(
  db: DuckDBClient,
  repoId: number,
  changedPaths: string[]
): Promise<void> {
  if (changedPaths.length === 0) {
    return;
  }

  console.info(`[GraphMetrics] Incremental update for ${changedPaths.length} files...`);

  // Find all affected files (changed files + their dependents)
  const placeholders = changedPaths.map(() => "?").join(", ");

  // Get files that depend on changed files (need closure update)
  const dependents = await db.all<{ path: string }>(
    `
    SELECT DISTINCT src_path as path
    FROM dependency
    WHERE repo_id = ? AND dst IN (${placeholders}) AND dst_kind = 'path'
  `,
    [repoId, ...changedPaths]
  );

  const affectedPaths = new Set([...changedPaths, ...dependents.map((d) => d.path)]);

  // Delete metrics for affected files
  const affectedPlaceholders = Array.from(affectedPaths)
    .map(() => "?")
    .join(", ");
  await db.run(
    `DELETE FROM graph_metrics WHERE repo_id = ? AND path IN (${affectedPlaceholders})`,
    [repoId, ...affectedPaths]
  );

  // Delete inbound edges involving affected files
  await db.run(
    `DELETE FROM inbound_edges WHERE repo_id = ?
     AND (target_path IN (${affectedPlaceholders}) OR source_path IN (${affectedPlaceholders}))`,
    [repoId, ...affectedPaths, ...affectedPaths]
  );

  // Recompute metrics (full recomputation is simpler and more reliable)
  // In the future, could be optimized to only recompute affected subgraph
  await computeGraphMetrics(db, repoId);
}
