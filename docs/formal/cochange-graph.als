/**
 * KIRI Co-change Graph - Alloy Specification
 *
 * This module defines the structural invariants for KIRI's co-change graph.
 * It models the relationship between files that frequently change together
 * based on git commit history analysis.
 *
 * Invariants verified:
 * - CC1: Canonical ordering (file1 < file2 lexicographically)
 * - CC2: Both files exist in the indexed set
 * - CC3: Positive weight (cochange_count > 0)
 * - CC4: No self-co-change (file1 != file2)
 */
module KiriCochangeGraph

-- =============================================================================
-- Core Signatures
-- =============================================================================

sig RepoId {}

sig FilePath {
  -- For lexicographic ordering, we define a total order on FilePath
  lessThan: set FilePath
}

sig CommitHash {}

sig Timestamp {}

-- A single co-change edge representing files that change together
sig CochangeEdge {
  repo: one RepoId,
  file1: one FilePath,
  file2: one FilePath,
  cochangeCount: one Int,
  confidence: one Int,  -- Scaled 0-100 for Jaccard similarity * 100
  lastCommit: one CommitHash
}

-- The complete co-change graph for a repository
sig CochangeGraph {
  repoId: one RepoId,
  edges: set CochangeEdge,
  indexedFiles: set FilePath,
  processedCommits: set CommitHash
}

-- =============================================================================
-- Invariant CC1: Canonical ordering
-- =============================================================================

/**
 * Fact: FilePath has a total order via lessThan relation
 */
fact filePathTotalOrder {
  -- Irreflexive
  all f: FilePath | f not in f.lessThan
  -- Antisymmetric
  all f1, f2: FilePath | f1 in f2.lessThan implies f2 not in f1.lessThan
  -- Transitive
  all f1, f2, f3: FilePath | (f1 in f2.lessThan and f2 in f3.lessThan) implies f1 in f3.lessThan
  -- Total: for any two distinct files, one is less than the other
  all disj f1, f2: FilePath | f1 in f2.lessThan or f2 in f1.lessThan
}

/**
 * CC1: In every co-change edge, file1 must be lexicographically less than file2.
 * This ensures undirected edges are stored in a canonical form.
 */
pred canonicalOrdering[g: CochangeGraph] {
  all e: g.edges | e.file1 in e.file2.lessThan
}

-- =============================================================================
-- Invariant CC2: Both files exist in index
-- =============================================================================

/**
 * Both endpoints of a co-change edge must be indexed files.
 */
pred filesExist[g: CochangeGraph] {
  all e: g.edges | {
    e.file1 in g.indexedFiles
    e.file2 in g.indexedFiles
  }
}

-- =============================================================================
-- Invariant CC3: Positive weight
-- =============================================================================

/**
 * Co-change count must be positive (at least 1 co-occurrence).
 */
pred positiveWeight[g: CochangeGraph] {
  all e: g.edges | e.cochangeCount > 0
}

-- =============================================================================
-- Invariant CC4: No self-co-change
-- =============================================================================

/**
 * A file cannot co-change with itself.
 * (This is implied by CC1 but we make it explicit)
 */
pred noSelfCochange[g: CochangeGraph] {
  all e: g.edges | e.file1 != e.file2
}

-- =============================================================================
-- Additional Invariant: Confidence range
-- =============================================================================

/**
 * Confidence (Jaccard similarity * 100) must be in range [1, 100]
 */
pred validConfidence[g: CochangeGraph] {
  all e: g.edges | e.confidence >= 1 and e.confidence <= 100
}

-- =============================================================================
-- Composite Consistency Predicate
-- =============================================================================

/**
 * A co-change graph is consistent if all invariants hold.
 */
pred consistentCochangeGraph[g: CochangeGraph] {
  canonicalOrdering[g]
  filesExist[g]
  positiveWeight[g]
  noSelfCochange[g]
  validConfidence[g]
}

-- =============================================================================
-- Uniqueness Invariant
-- =============================================================================

/**
 * Each edge is uniquely identified by (repo, file1, file2).
 * No duplicate edges for the same file pair.
 */
pred uniqueEdges[g: CochangeGraph] {
  all disj e1, e2: g.edges |
    not (e1.repo = e2.repo and e1.file1 = e2.file1 and e1.file2 = e2.file2)
}

-- =============================================================================
-- Assertions for Model Checking
-- =============================================================================

/**
 * Assert: Canonical ordering implies no self-co-change
 */
assert canonicalImpliesNoSelf {
  all g: CochangeGraph |
    canonicalOrdering[g] implies noSelfCochange[g]
}

/**
 * Assert: Each file pair appears at most once
 */
assert noDuplicatePairs {
  all g: CochangeGraph |
    consistentCochangeGraph[g] implies uniqueEdges[g]
}

/**
 * Assert: Adding an edge maintains ordering if properly constructed
 */
assert orderingPreserved {
  all g: CochangeGraph, e: CochangeEdge |
    (consistentCochangeGraph[g] and e.file1 in e.file2.lessThan) implies
    canonicalOrdering[g]
}

-- =============================================================================
-- Co-change Update Operations
-- =============================================================================

/**
 * Process a single commit: update co-change counts for all file pairs
 * that changed together in this commit.
 */
pred processCommit[g, g': CochangeGraph, commit: CommitHash, changedFiles: set FilePath] {
  -- Precondition: commit not already processed
  commit not in g.processedCommits
  -- All changed files must be indexed
  changedFiles in g.indexedFiles

  -- Postcondition: update edges for all pairs
  g'.processedCommits = g.processedCommits + commit
  g'.indexedFiles = g.indexedFiles
  g'.repoId = g.repoId

  -- Edges are updated (simplified - actual TLA+ has full logic)
  -- New pairs get count=1, existing pairs get count+1
}

/**
 * Remove a file: cascade delete all co-change edges involving the file
 */
pred removeFile[g, g': CochangeGraph, f: FilePath] {
  -- Precondition
  f in g.indexedFiles

  -- Postcondition
  g'.indexedFiles = g.indexedFiles - f
  g'.edges = { e: g.edges | e.file1 != f and e.file2 != f }
  g'.processedCommits = g.processedCommits
  g'.repoId = g.repoId
}

/**
 * Assert: Operations preserve consistency
 */
assert removeFilePreservesConsistency {
  all g, g': CochangeGraph, f: FilePath |
    (consistentCochangeGraph[g] and removeFile[g, g', f]) implies
    consistentCochangeGraph[g']
}

-- =============================================================================
-- Example and Verification Commands
-- =============================================================================

-- Generate a sample consistent co-change graph
run showConsistentCochangeGraph {
  some g: CochangeGraph | {
    consistentCochangeGraph[g]
    #g.edges > 2
    #g.indexedFiles > 4
    #g.processedCommits > 1
  }
} for 5 but 3 RepoId, 6 FilePath, 4 CommitHash, 6 CochangeEdge, 4 Int

-- Check assertions
check canonicalImpliesNoSelf for 5 but 5 FilePath, 8 CochangeEdge
check noDuplicatePairs for 5 but 5 FilePath, 8 CochangeEdge
check removeFilePreservesConsistency for 4 but 4 FilePath, 6 CochangeEdge

-- =============================================================================
-- Query Helper Functions
-- =============================================================================

/**
 * Get all files that co-change with a given file.
 */
fun cochangeNeighbors[g: CochangeGraph, f: FilePath]: set FilePath {
  { other: FilePath |
    some e: g.edges |
      (e.file1 = f and e.file2 = other) or (e.file2 = f and e.file1 = other) }
}

/**
 * Get co-change edge between two files (if exists).
 */
fun getEdge[g: CochangeGraph, f1, f2: FilePath]: lone CochangeEdge {
  { e: g.edges | (e.file1 = f1 and e.file2 = f2) or (e.file1 = f2 and e.file2 = f1) }
}

/**
 * Get high-confidence co-change neighbors (confidence > 50).
 */
fun highConfidenceNeighbors[g: CochangeGraph, f: FilePath]: set FilePath {
  { other: FilePath |
    some e: g.edges |
      e.confidence > 50 and
      ((e.file1 = f and e.file2 = other) or (e.file2 = f and e.file1 = other)) }
}
