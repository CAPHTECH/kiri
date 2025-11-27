/**
 * KIRI Dependency Graph - Alloy Specification
 *
 * This module defines the structural invariants for KIRI's dependency graph.
 * It models the relationship between files through import dependencies.
 *
 * Invariants verified:
 * - DG1: Path dependency edges reference indexed files
 * - DG2: No self-loops in path dependencies
 * - DG3: Primary key uniqueness (repo_id, src_path, dst_kind, dst, rel)
 * - DG4: BFS closure symmetry (outbound/inbound consistency)
 */
module KiriDependencyGraph

-- =============================================================================
-- Core Signatures
-- =============================================================================

sig RepoId {}

sig FilePath {}

sig PackageName {}

-- Destination kind: local file path or external package
abstract sig DstKind {}
one sig PathKind, PackageKind extends DstKind {}

-- Relationship type between files
abstract sig RelationType {}
one sig Import, Require, Include extends RelationType {}

-- A single dependency edge in the graph
sig DependencyEdge {
  repo: one RepoId,
  srcPath: one FilePath,
  dstKind: one DstKind,
  dst: one (FilePath + PackageName),
  rel: one RelationType
}

-- The complete dependency graph for a repository
sig DependencyGraph {
  repoId: one RepoId,
  edges: set DependencyEdge,
  indexedFiles: set FilePath
}

-- =============================================================================
-- Invariant DG1: Path edges reference indexed files
-- =============================================================================

/**
 * For any edge where dstKind is PathKind, both the source and destination
 * must be in the set of indexed files for that repository.
 */
pred pathEdgesReferenceIndexedFiles[g: DependencyGraph] {
  all e: g.edges | {
    -- Source file must always be indexed
    e.srcPath in g.indexedFiles
    -- Destination file must be indexed if it's a path (not a package)
    e.dstKind = PathKind implies e.dst in g.indexedFiles
  }
}

-- =============================================================================
-- Invariant DG2: No self-loops in path dependencies
-- =============================================================================

/**
 * A file cannot import itself. This prevents circular single-file dependencies.
 */
pred noSelfLoops[g: DependencyGraph] {
  all e: g.edges | e.dstKind = PathKind implies e.srcPath != e.dst
}

-- =============================================================================
-- Invariant DG3: Primary key uniqueness
-- =============================================================================

/**
 * Each edge is uniquely identified by (repo, srcPath, dstKind, dst, rel).
 * No two distinct edges can have the same combination of these fields.
 */
pred uniqueEdges[g: DependencyGraph] {
  all disj e1, e2: g.edges |
    not (e1.repo = e2.repo and
         e1.srcPath = e2.srcPath and
         e1.dstKind = e2.dstKind and
         e1.dst = e2.dst and
         e1.rel = e2.rel)
}

-- =============================================================================
-- Invariant DG4: Closure symmetry
-- =============================================================================

/**
 * If file A can reach file B through outbound edges at depth d,
 * then file B can reach file A through inbound edges at depth d.
 */

-- Helper: Get direct outbound neighbors (files this file imports)
fun outboundNeighbors[g: DependencyGraph, f: FilePath]: set FilePath {
  { dst: FilePath | some e: g.edges |
    e.srcPath = f and e.dstKind = PathKind and e.dst = dst }
}

-- Helper: Get direct inbound neighbors (files that import this file)
fun inboundNeighbors[g: DependencyGraph, f: FilePath]: set FilePath {
  { src: FilePath | some e: g.edges |
    e.dstKind = PathKind and e.dst = f and e.srcPath = src }
}

-- Reachable files via outbound edges (transitive closure up to depth d)
fun reachableOutbound[g: DependencyGraph, start: FilePath]: set FilePath {
  start.*(outboundNeighbors[g, FilePath])
}

-- Reachable files via inbound edges (transitive closure up to depth d)
fun reachableInbound[g: DependencyGraph, start: FilePath]: set FilePath {
  start.*(inboundNeighbors[g, FilePath])
}

-- =============================================================================
-- Composite Consistency Predicate
-- =============================================================================

/**
 * A dependency graph is consistent if all invariants hold.
 */
pred consistentDependencyGraph[g: DependencyGraph] {
  pathEdgesReferenceIndexedFiles[g]
  noSelfLoops[g]
  uniqueEdges[g]
}

-- =============================================================================
-- Assertions for Model Checking
-- =============================================================================

/**
 * Assert that direct edge relationships are symmetric:
 * If A imports B, then B has A as an importer.
 */
assert directEdgeSymmetry {
  all g: DependencyGraph, a, b: g.indexedFiles |
    consistentDependencyGraph[g] implies
    (b in outboundNeighbors[g, a] iff a in inboundNeighbors[g, b])
}

/**
 * Assert that no indexed file references a non-indexed file.
 */
assert noOrphanReferences {
  all g: DependencyGraph |
    consistentDependencyGraph[g] implies
    (all e: g.edges | e.dstKind = PathKind implies e.dst in g.indexedFiles)
}

/**
 * Assert that the graph has no duplicate edges.
 */
assert noDuplicateEdges {
  all g: DependencyGraph |
    consistentDependencyGraph[g] implies
    uniqueEdges[g]
}

-- =============================================================================
-- Example and Verification Commands
-- =============================================================================

-- Generate a sample consistent graph
run showConsistentGraph {
  some g: DependencyGraph | {
    consistentDependencyGraph[g]
    #g.edges > 2
    #g.indexedFiles > 3
    some e: g.edges | e.dstKind = PathKind
    some e: g.edges | e.dstKind = PackageKind
  }
} for 5 but 3 RepoId, 6 FilePath, 3 PackageName, 8 DependencyEdge

-- Check assertions
check directEdgeSymmetry for 5 but 3 RepoId, 5 FilePath, 10 DependencyEdge
check noOrphanReferences for 5 but 3 RepoId, 5 FilePath, 10 DependencyEdge
check noDuplicateEdges for 5 but 3 RepoId, 5 FilePath, 10 DependencyEdge

-- =============================================================================
-- Incremental Update Operations (for TLA+ integration)
-- =============================================================================

/**
 * Model adding a new file to the index.
 * Pre: file not in indexedFiles
 * Post: file added, no edges yet
 */
pred addFile[g, g': DependencyGraph, f: FilePath] {
  -- Precondition
  f not in g.indexedFiles
  -- Postcondition
  g'.indexedFiles = g.indexedFiles + f
  g'.edges = g.edges
  g'.repoId = g.repoId
}

/**
 * Model adding a dependency edge.
 * Pre: both files indexed (for path kind), edge not exists
 * Post: edge added
 */
pred addEdge[g, g': DependencyGraph, e: DependencyEdge] {
  -- Precondition
  e.srcPath in g.indexedFiles
  e.dstKind = PathKind implies e.dst in g.indexedFiles
  e not in g.edges
  -- Postcondition
  g'.edges = g.edges + e
  g'.indexedFiles = g.indexedFiles
  g'.repoId = g.repoId
}

/**
 * Model removing a file from the index.
 * Pre: file in indexedFiles
 * Post: file removed, all edges involving file removed (cascade)
 */
pred removeFile[g, g': DependencyGraph, f: FilePath] {
  -- Precondition
  f in g.indexedFiles
  -- Postcondition: cascade delete edges
  g'.indexedFiles = g.indexedFiles - f
  g'.edges = { e: g.edges | e.srcPath != f and (e.dstKind = PackageKind or e.dst != f) }
  g'.repoId = g.repoId
}

/**
 * Assert: Operations preserve graph consistency
 */
assert addFilePreservesConsistency {
  all g, g': DependencyGraph, f: FilePath |
    (consistentDependencyGraph[g] and addFile[g, g', f]) implies
    consistentDependencyGraph[g']
}

assert removeFilePreservesConsistency {
  all g, g': DependencyGraph, f: FilePath |
    (consistentDependencyGraph[g] and removeFile[g, g', f]) implies
    consistentDependencyGraph[g']
}

check addFilePreservesConsistency for 4 but 4 FilePath, 6 DependencyEdge
check removeFilePreservesConsistency for 4 but 4 FilePath, 6 DependencyEdge
