------------------------------- MODULE MC -------------------------------
(*
 * Model Checking Configuration for KIRI Graph Specifications
 *
 * This module provides small-model configurations for TLC model checker.
 * Use these settings to verify safety and liveness properties.
 *)
EXTENDS Integers, Sequences, FiniteSets

-----------------------------------------------------------------------------
(* Model Configuration for GraphUpdate *)
-----------------------------------------------------------------------------

\* Small model for quick verification
MC_FilePaths == {"a.ts", "b.ts", "c.ts"}
MC_MaxRepoId == 1
MC_ProcessIds == {"p1", "p2"}

\* Medium model for more thorough verification
MC_FilePaths_Medium == {"a.ts", "b.ts", "c.ts", "d.ts", "e.ts"}
MC_MaxRepoId_Medium == 2
MC_ProcessIds_Medium == {"p1", "p2", "p3"}

-----------------------------------------------------------------------------
(* Model Configuration for CochangeUpdate *)
-----------------------------------------------------------------------------

MC_CommitHashes == {"c1", "c2", "c3"}

\* LessThan operator for FilePaths (lexicographic ordering)
MC_LessThan(f1, f2) ==
  \/ f1 = "a.ts" /\ f2 \in {"b.ts", "c.ts", "d.ts", "e.ts"}
  \/ f1 = "b.ts" /\ f2 \in {"c.ts", "d.ts", "e.ts"}
  \/ f1 = "c.ts" /\ f2 \in {"d.ts", "e.ts"}
  \/ f1 = "d.ts" /\ f2 = "e.ts"

-----------------------------------------------------------------------------
(* State Constraints (to bound state space) *)
-----------------------------------------------------------------------------

\* Limit the number of pending operations
StateConstraint_GraphUpdate ==
  Len(txPendingOps) <= 5

\* Limit the number of edges
StateConstraint_Cochange ==
  \A r \in 1..MC_MaxRepoId:
    Cardinality({p \in MC_FilePaths \X MC_FilePaths : cochangeEdges[r][p] > 0}) <= 10

-----------------------------------------------------------------------------
(* Invariants to Check *)
-----------------------------------------------------------------------------

\* GraphUpdate invariants
Inv_TypeInvariant == TypeInvariant
Inv_Safety == Safety
Inv_DependencyConsistency == DependencyConsistency
Inv_AtomicUpdate == AtomicUpdate
Inv_MutualExclusion == MutualExclusion

\* CochangeUpdate invariants
Inv_CanonicalOrdering == CanonicalOrdering
Inv_FilesExist == FilesExist
Inv_NonNegativeWeight == NonNegativeWeight
Inv_IdempotentProcessing == IdempotentProcessing

-----------------------------------------------------------------------------
(* Temporal Properties to Check *)
-----------------------------------------------------------------------------

\* GraphUpdate temporal properties
Prop_LockEventuallyReleased == LockEventuallyReleased
Prop_TxEventuallyCompletes == TxEventuallyCompletes

\* CochangeUpdate temporal properties
Prop_CommitEventuallyCompletes == CommitEventuallyCompletes

-----------------------------------------------------------------------------
(* Symmetry Sets (for state space reduction) *)
-----------------------------------------------------------------------------

\* TLC can use symmetry to reduce state space
Symmetry_ProcessIds == Permutations(MC_ProcessIds)
Symmetry_CommitHashes == Permutations(MC_CommitHashes)

-----------------------------------------------------------------------------
(* Example Behaviors (for trace exploration) *)
-----------------------------------------------------------------------------

\* Behavior: Process adds file, creates dependency, commits
ExampleBehavior_AddDependency ==
  /\ \E pid \in MC_ProcessIds, r \in 1..MC_MaxRepoId:
       /\ AcquireLock(pid)
       /\ BeginTx(pid, r)
       /\ QueueAddFile(pid, r, "a.ts")
       /\ QueueAddFile(pid, r, "b.ts")
       /\ QueueAddDependency(pid, r, "a.ts", "b.ts")
       /\ CommitTx(pid, r)
       /\ ReleaseLock(pid)

\* Behavior: Two processes contend for lock
ExampleBehavior_LockContention ==
  /\ \E p1, p2 \in MC_ProcessIds:
       p1 # p2 /\
       (AcquireLock(p1) \/ AcquireLock(p2))

-----------------------------------------------------------------------------
(* TLC Model File (.cfg) Example Content *)
(*
SPECIFICATION Spec

CONSTANTS
  FilePaths = {"a.ts", "b.ts", "c.ts"}
  MaxRepoId = 1
  ProcessIds = {"p1", "p2"}
  CommitHashes = {"c1", "c2", "c3"}
  LessThan <- MC_LessThan

INVARIANTS
  TypeInvariant
  Safety

PROPERTIES
  LockEventuallyReleased
  TxEventuallyCompletes

CONSTRAINT
  StateConstraint_GraphUpdate

SYMMETRY
  Symmetry_ProcessIds
*)
-----------------------------------------------------------------------------

=============================================================================
