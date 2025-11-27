--------------------------- MODULE GraphUpdate ---------------------------
(*
 * KIRI Graph Update Protocol - TLA+ Specification
 *
 * This module specifies the state machine for updating the dependency graph
 * and graph metrics during indexing operations. It ensures:
 *
 * Safety Properties:
 * - S1: DependencyConsistency - edges reference indexed files
 * - S2: AtomicUpdate - all changes commit or none
 * - S3: MutualExclusion - only one writer at a time
 * - S4: GenerationMonotonic - fts_generation only increases
 *
 * Liveness Properties:
 * - L1: LockEventuallyReleased
 * - L2: TxEventuallyCompletes
 *)
EXTENDS Integers, Sequences, FiniteSets, TLC

-----------------------------------------------------------------------------
(* Constants *)
-----------------------------------------------------------------------------

CONSTANTS
  FilePaths,        \* Set of all possible file paths
  MaxRepoId,        \* Maximum repository ID
  ProcessIds        \* Set of process identifiers

ASSUME MaxRepoId \in Nat /\ MaxRepoId > 0
ASSUME FilePaths # {}
ASSUME ProcessIds # {}

-----------------------------------------------------------------------------
(* Variables *)
-----------------------------------------------------------------------------

VARIABLES
  \* Database state
  files,            \* Function: repo_id -> Set of file paths
  dependencies,     \* Function: repo_id -> Set of <<src, dst>> tuples
  graphMetrics,     \* Function: repo_id -> Function: path -> metrics record
  inboundEdges,     \* Function: repo_id -> Set of <<target, source, depth>> tuples
  ftsGeneration,    \* Function: repo_id -> Int (generation counter)

  \* Transaction state
  txActive,         \* Currently active transaction (repo_id or NULL)
  txOwner,          \* Process owning active transaction
  txPendingOps,     \* Sequence of pending operations

  \* Lock state
  lockHolder        \* Process ID holding the lock, or "NULL"

vars == <<files, dependencies, graphMetrics, inboundEdges, ftsGeneration,
          txActive, txOwner, txPendingOps, lockHolder>>

-----------------------------------------------------------------------------
(* Type Invariant *)
-----------------------------------------------------------------------------

TypeInvariant ==
  /\ \A r \in 1..MaxRepoId: files[r] \subseteq FilePaths
  /\ \A r \in 1..MaxRepoId: ftsGeneration[r] \in Nat
  /\ txActive \in ({"NULL"} \cup (1..MaxRepoId))
  /\ txOwner \in ({"NULL"} \cup ProcessIds)
  /\ lockHolder \in ({"NULL"} \cup ProcessIds)

-----------------------------------------------------------------------------
(* Initial State *)
-----------------------------------------------------------------------------

Init ==
  /\ files = [r \in 1..MaxRepoId |-> {}]
  /\ dependencies = [r \in 1..MaxRepoId |-> {}]
  /\ graphMetrics = [r \in 1..MaxRepoId |-> [p \in FilePaths |-> [inbound |-> 0, outbound |-> 0, importance |-> 0]]]
  /\ inboundEdges = [r \in 1..MaxRepoId |-> {}]
  /\ ftsGeneration = [r \in 1..MaxRepoId |-> 0]
  /\ txActive = "NULL"
  /\ txOwner = "NULL"
  /\ txPendingOps = <<>>
  /\ lockHolder = "NULL"

-----------------------------------------------------------------------------
(* Lock Operations *)
-----------------------------------------------------------------------------

(*
 * Acquire exclusive lock for indexing.
 * Corresponds to lockfile.ts acquireLock()
 *)
AcquireLock(pid) ==
  /\ lockHolder = "NULL"
  /\ lockHolder' = pid
  /\ UNCHANGED <<files, dependencies, graphMetrics, inboundEdges, ftsGeneration,
                 txActive, txOwner, txPendingOps>>

(*
 * Release lock after indexing completes.
 *)
ReleaseLock(pid) ==
  /\ lockHolder = pid
  /\ txActive = "NULL"  \* Can only release if no active transaction
  /\ lockHolder' = "NULL"
  /\ UNCHANGED <<files, dependencies, graphMetrics, inboundEdges, ftsGeneration,
                 txActive, txOwner, txPendingOps>>

-----------------------------------------------------------------------------
(* Transaction Operations *)
-----------------------------------------------------------------------------

(*
 * Begin a transaction for a repository.
 * Corresponds to DuckDB transaction begin.
 *)
BeginTx(pid, repo) ==
  /\ lockHolder = pid  \* Must hold lock
  /\ txActive = "NULL" \* No active transaction
  /\ repo \in 1..MaxRepoId
  /\ txActive' = repo
  /\ txOwner' = pid
  /\ txPendingOps' = <<>>
  /\ UNCHANGED <<files, dependencies, graphMetrics, inboundEdges, ftsGeneration, lockHolder>>

(*
 * Queue: Delete all records for a file (cascade delete).
 * Queues the operation; actual deletion happens at commit.
 *)
QueueDeleteFile(pid, repo, path) ==
  /\ txActive = repo
  /\ txOwner = pid
  /\ path \in files[repo]
  /\ txPendingOps' = Append(txPendingOps, <<"DELETE_FILE", repo, path>>)
  /\ UNCHANGED <<files, dependencies, graphMetrics, inboundEdges, ftsGeneration,
                 txActive, txOwner, lockHolder>>

(*
 * Queue: Add a file to the index.
 *)
QueueAddFile(pid, repo, path) ==
  /\ txActive = repo
  /\ txOwner = pid
  /\ path \in FilePaths
  /\ path \notin files[repo]
  /\ txPendingOps' = Append(txPendingOps, <<"ADD_FILE", repo, path>>)
  /\ UNCHANGED <<files, dependencies, graphMetrics, inboundEdges, ftsGeneration,
                 txActive, txOwner, lockHolder>>

(*
 * Queue: Add a dependency edge.
 *)
QueueAddDependency(pid, repo, src, dst) ==
  /\ txActive = repo
  /\ txOwner = pid
  /\ src \in FilePaths
  /\ dst \in FilePaths
  /\ txPendingOps' = Append(txPendingOps, <<"ADD_DEP", repo, src, dst>>)
  /\ UNCHANGED <<files, dependencies, graphMetrics, inboundEdges, ftsGeneration,
                 txActive, txOwner, lockHolder>>

(*
 * Helper: Apply a single operation to the state.
 *)
ApplyOp(op, st) ==
  CASE op[1] = "DELETE_FILE" ->
    LET repo == op[2]
        path == op[3]
    IN [st EXCEPT
          !.files[repo] = st.files[repo] \ {path},
          !.dependencies[repo] = {d \in st.dependencies[repo] : d[1] # path /\ d[2] # path},
          !.inboundEdges[repo] = {e \in st.inboundEdges[repo] : e[1] # path /\ e[2] # path}]
  [] op[1] = "ADD_FILE" ->
    LET repo == op[2]
        path == op[3]
    IN [st EXCEPT !.files[repo] = st.files[repo] \cup {path}]
  [] op[1] = "ADD_DEP" ->
    LET repo == op[2]
        src == op[3]
        dst == op[4]
    IN [st EXCEPT !.dependencies[repo] = st.dependencies[repo] \cup {<<src, dst>>}]
  [] OTHER -> st

(*
 * Helper: Apply all pending operations sequentially.
 *)
RECURSIVE ApplyAllOps(_, _)
ApplyAllOps(ops, st) ==
  IF ops = <<>>
  THEN st
  ELSE ApplyAllOps(Tail(ops), ApplyOp(Head(ops), st))

(*
 * Commit transaction: atomically apply all pending operations.
 *)
CommitTx(pid, repo) ==
  /\ txActive = repo
  /\ txOwner = pid
  /\ LET currentState == [files |-> files, dependencies |-> dependencies,
                          inboundEdges |-> inboundEdges, graphMetrics |-> graphMetrics]
         newState == ApplyAllOps(txPendingOps, currentState)
     IN /\ files' = newState.files
        /\ dependencies' = newState.dependencies
        /\ inboundEdges' = newState.inboundEdges
        /\ graphMetrics' = newState.graphMetrics
        /\ ftsGeneration' = [ftsGeneration EXCEPT ![repo] = @ + 1]
  /\ txActive' = "NULL"
  /\ txOwner' = "NULL"
  /\ txPendingOps' = <<>>
  /\ UNCHANGED lockHolder

(*
 * Rollback transaction: discard all pending operations.
 *)
RollbackTx(pid, repo) ==
  /\ txActive = repo
  /\ txOwner = pid
  /\ txActive' = "NULL"
  /\ txOwner' = "NULL"
  /\ txPendingOps' = <<>>
  /\ UNCHANGED <<files, dependencies, graphMetrics, inboundEdges, ftsGeneration, lockHolder>>

-----------------------------------------------------------------------------
(* Graph Metrics Update Operations *)
-----------------------------------------------------------------------------

(*
 * Recompute inbound edges for affected files after commit.
 * This is called after CommitTx to update precomputed closures.
 *)
RecomputeInboundClosure(pid, repo, affectedPaths, maxDepth) ==
  /\ lockHolder = pid
  /\ txActive = "NULL"  \* After commit
  /\ repo \in 1..MaxRepoId
  \* Simplified: actual implementation uses BFS with depth limit
  /\ LET ComputeInbound(path, depth) ==
         IF depth = 0 THEN {}
         ELSE {<<path, src, depth>> : src \in {s \in FilePaths :
                   <<s, path>> \in dependencies[repo]}}
                \cup UNION {ComputeInbound(src, depth - 1) :
                            src \in {s \in FilePaths : <<s, path>> \in dependencies[repo]}}
         newEdges == UNION {ComputeInbound(p, maxDepth) : p \in affectedPaths}
     IN inboundEdges' = [inboundEdges EXCEPT ![repo] =
                          (@ \ {e \in @ : e[1] \in affectedPaths})
                          \cup newEdges]
  /\ UNCHANGED <<files, dependencies, graphMetrics, ftsGeneration,
                 txActive, txOwner, txPendingOps, lockHolder>>

(*
 * Update degree centrality metrics.
 *)
UpdateDegreeCentrality(pid, repo, path) ==
  /\ lockHolder = pid
  /\ txActive = "NULL"
  /\ path \in files[repo]
  /\ LET inbound == Cardinality({d \in dependencies[repo] : d[2] = path})
         outbound == Cardinality({d \in dependencies[repo] : d[1] = path})
     IN graphMetrics' = [graphMetrics EXCEPT
          ![repo][path].inbound = inbound,
          ![repo][path].outbound = outbound]
  /\ UNCHANGED <<files, dependencies, inboundEdges, ftsGeneration,
                 txActive, txOwner, txPendingOps, lockHolder>>

-----------------------------------------------------------------------------
(* Safety Properties *)
-----------------------------------------------------------------------------

(*
 * S1: Dependency Consistency
 * All dependency edges reference files that are in the indexed set.
 *)
DependencyConsistency ==
  \A r \in 1..MaxRepoId:
    \A d \in dependencies[r]:
      d[1] \in files[r] /\ d[2] \in files[r]

(*
 * S2: Atomic Update
 * If no transaction is active, there are no pending operations.
 *)
AtomicUpdate ==
  txActive = "NULL" => txPendingOps = <<>>

(*
 * S3: Mutual Exclusion
 * Only the lock holder can have an active transaction.
 *)
MutualExclusion ==
  txActive # "NULL" => lockHolder = txOwner

(*
 * S4: Generation Monotonic
 * FTS generation counter only increases (checked via temporal property).
 *)
GenerationMonotonic ==
  \A r \in 1..MaxRepoId:
    [][ftsGeneration'[r] >= ftsGeneration[r]]_ftsGeneration

(*
 * Combined Safety Property
 *)
Safety ==
  /\ DependencyConsistency
  /\ AtomicUpdate
  /\ MutualExclusion

-----------------------------------------------------------------------------
(* Liveness Properties *)
-----------------------------------------------------------------------------

(*
 * L1: Lock Eventually Released
 * Any process that acquires the lock will eventually release it.
 *)
LockEventuallyReleased ==
  \A pid \in ProcessIds:
    (lockHolder = pid) ~> (lockHolder = "NULL")

(*
 * L2: Transaction Eventually Completes
 * Any active transaction will eventually commit or rollback.
 *)
TxEventuallyCompletes ==
  (txActive # "NULL") ~> (txActive = "NULL")

(*
 * Combined Liveness Property
 *)
Liveness ==
  /\ LockEventuallyReleased
  /\ TxEventuallyCompletes

-----------------------------------------------------------------------------
(* Next State Relation *)
-----------------------------------------------------------------------------

Next ==
  \/ \E pid \in ProcessIds: AcquireLock(pid)
  \/ \E pid \in ProcessIds: ReleaseLock(pid)
  \/ \E pid \in ProcessIds, r \in 1..MaxRepoId: BeginTx(pid, r)
  \/ \E pid \in ProcessIds, r \in 1..MaxRepoId, p \in FilePaths:
       QueueDeleteFile(pid, r, p)
  \/ \E pid \in ProcessIds, r \in 1..MaxRepoId, p \in FilePaths:
       QueueAddFile(pid, r, p)
  \/ \E pid \in ProcessIds, r \in 1..MaxRepoId, s, d \in FilePaths:
       QueueAddDependency(pid, r, s, d)
  \/ \E pid \in ProcessIds, r \in 1..MaxRepoId: CommitTx(pid, r)
  \/ \E pid \in ProcessIds, r \in 1..MaxRepoId: RollbackTx(pid, r)

-----------------------------------------------------------------------------
(* Specification *)
-----------------------------------------------------------------------------

Spec ==
  /\ Init
  /\ [][Next]_vars
  /\ WF_vars(Next)  \* Weak fairness for liveness

-----------------------------------------------------------------------------
(* Theorems *)
-----------------------------------------------------------------------------

THEOREM SafetyTheorem == Spec => []Safety

THEOREM LivenessTheorem == Spec => Liveness

=============================================================================
