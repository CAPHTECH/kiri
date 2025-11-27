--------------------------- MODULE CochangeUpdate ---------------------------
(*
 * KIRI Co-change Update Protocol - TLA+ Specification
 *
 * This module specifies the state machine for updating the co-change graph
 * by processing git commit history. It ensures:
 *
 * Safety Properties:
 * - CC_S1: Canonical ordering preserved (file1 < file2)
 * - CC_S2: Both files exist in index
 * - CC_S3: Positive weight
 * - CC_S4: Idempotent commit processing
 *
 * Liveness Properties:
 * - CC_L1: Pending commits eventually processed
 *)
EXTENDS Integers, Sequences, FiniteSets, TLC

-----------------------------------------------------------------------------
(* Constants *)
-----------------------------------------------------------------------------

CONSTANTS
  FilePaths,          \* Set of all possible file paths
  CommitHashes,       \* Set of all possible commit hashes
  MaxRepoId           \* Maximum repository ID

ASSUME MaxRepoId \in Nat /\ MaxRepoId > 0
ASSUME FilePaths # {}
ASSUME CommitHashes # {}

(*
 * Total order on FilePaths for canonical ordering.
 * In practice, this is lexicographic ordering of path strings.
 *)
CONSTANT LessThan(_,_)
ASSUME \A f1, f2 \in FilePaths:
  /\ ~LessThan(f1, f1)                                    \* Irreflexive
  /\ LessThan(f1, f2) => ~LessThan(f2, f1)               \* Antisymmetric
  /\ f1 # f2 => LessThan(f1, f2) \/ LessThan(f2, f1)    \* Total

-----------------------------------------------------------------------------
(* Helper Operators *)
-----------------------------------------------------------------------------

(*
 * Canonical pair: ensure file1 < file2
 *)
CanonicalPair(f1, f2) ==
  IF LessThan(f1, f2)
  THEN <<f1, f2>>
  ELSE <<f2, f1>>

(*
 * Generate all pairs from a set of files (with canonical ordering)
 *)
AllPairs(files) ==
  {CanonicalPair(f1, f2) : f1, f2 \in files, f1 # f2}

-----------------------------------------------------------------------------
(* Variables *)
-----------------------------------------------------------------------------

VARIABLES
  \* Database state
  indexedFiles,       \* Function: repo_id -> Set of file paths
  cochangeEdges,      \* Function: repo_id -> Function: <<file1, file2>> -> count
  processedCommits,   \* Function: repo_id -> Set of processed commit hashes

  \* Processing state
  currentRepo,        \* Repository currently being processed (or NULL)
  currentCommit,      \* Commit currently being processed (or NULL)
  changedFiles,       \* Files changed in current commit
  pendingPairs        \* Pairs remaining to update in current commit

vars == <<indexedFiles, cochangeEdges, processedCommits,
          currentRepo, currentCommit, changedFiles, pendingPairs>>

-----------------------------------------------------------------------------
(* Type Invariant *)
-----------------------------------------------------------------------------

TypeInvariant ==
  /\ \A r \in 1..MaxRepoId: indexedFiles[r] \subseteq FilePaths
  /\ \A r \in 1..MaxRepoId: processedCommits[r] \subseteq CommitHashes
  /\ currentRepo \in ({"NULL"} \cup (1..MaxRepoId))
  /\ currentCommit \in ({"NULL"} \cup CommitHashes)
  /\ changedFiles \subseteq FilePaths

-----------------------------------------------------------------------------
(* Initial State *)
-----------------------------------------------------------------------------

Init ==
  /\ indexedFiles = [r \in 1..MaxRepoId |-> {}]
  /\ cochangeEdges = [r \in 1..MaxRepoId |-> [p \in (FilePaths \X FilePaths) |-> 0]]
  /\ processedCommits = [r \in 1..MaxRepoId |-> {}]
  /\ currentRepo = "NULL"
  /\ currentCommit = "NULL"
  /\ changedFiles = {}
  /\ pendingPairs = {}

-----------------------------------------------------------------------------
(* Co-change Update Operations *)
-----------------------------------------------------------------------------

(*
 * Start processing a commit.
 * Pre: No commit currently being processed
 * Pre: Commit not already processed
 * Pre: All changed files are indexed
 *)
StartCommit(repo, commit, files) ==
  /\ currentCommit = "NULL"
  /\ repo \in 1..MaxRepoId
  /\ commit \in CommitHashes
  /\ commit \notin processedCommits[repo]
  /\ files \subseteq indexedFiles[repo]
  /\ files # {}
  /\ currentRepo' = repo
  /\ currentCommit' = commit
  /\ changedFiles' = files
  /\ pendingPairs' = AllPairs(files)
  /\ UNCHANGED <<indexedFiles, cochangeEdges, processedCommits>>

(*
 * Process one pair from the current commit.
 * Increments co-change count for the pair.
 *)
ProcessPair ==
  /\ currentCommit # "NULL"
  /\ pendingPairs # {}
  /\ LET pair == CHOOSE p \in pendingPairs : TRUE
         file1 == pair[1]
         file2 == pair[2]
         repo == currentRepo
     IN /\ cochangeEdges' = [cochangeEdges EXCEPT
              ![repo][pair] = @ + 1]
        /\ pendingPairs' = pendingPairs \ {pair}
  /\ UNCHANGED <<indexedFiles, processedCommits, currentRepo, currentCommit, changedFiles>>

(*
 * Complete processing of current commit.
 * Mark commit as processed to ensure idempotency.
 *)
CompleteCommit ==
  /\ currentCommit # "NULL"
  /\ pendingPairs = {}  \* All pairs processed
  /\ processedCommits' = [processedCommits EXCEPT
       ![currentRepo] = @ \cup {currentCommit}]
  /\ currentRepo' = "NULL"
  /\ currentCommit' = "NULL"
  /\ changedFiles' = {}
  /\ UNCHANGED <<indexedFiles, cochangeEdges, pendingPairs>>

(*
 * Abort processing of current commit (e.g., on error).
 * Does not mark as processed, allowing retry.
 *)
AbortCommit ==
  /\ currentCommit # "NULL"
  /\ currentRepo' = "NULL"
  /\ currentCommit' = "NULL"
  /\ changedFiles' = {}
  /\ pendingPairs' = {}
  /\ UNCHANGED <<indexedFiles, cochangeEdges, processedCommits>>

-----------------------------------------------------------------------------
(* File Management Operations *)
-----------------------------------------------------------------------------

(*
 * Add a file to the index.
 * Pre: Not currently processing a commit
 *)
AddFile(repo, path) ==
  /\ currentCommit = "NULL"
  /\ repo \in 1..MaxRepoId
  /\ path \in FilePaths
  /\ path \notin indexedFiles[repo]
  /\ indexedFiles' = [indexedFiles EXCEPT ![repo] = @ \cup {path}]
  /\ UNCHANGED <<cochangeEdges, processedCommits, currentRepo, currentCommit,
                 changedFiles, pendingPairs>>

(*
 * Remove a file from the index.
 * Cascade deletes all co-change edges involving the file.
 * Pre: Not currently processing a commit
 *)
RemoveFile(repo, path) ==
  /\ currentCommit = "NULL"
  /\ repo \in 1..MaxRepoId
  /\ path \in indexedFiles[repo]
  /\ indexedFiles' = [indexedFiles EXCEPT ![repo] = @ \ {path}]
  \* Reset edges involving this file to 0
  /\ cochangeEdges' = [cochangeEdges EXCEPT
       ![repo] = [p \in FilePaths \X FilePaths |->
                    IF p[1] = path \/ p[2] = path
                    THEN 0
                    ELSE cochangeEdges[repo][p]]]
  /\ UNCHANGED <<processedCommits, currentRepo, currentCommit,
                 changedFiles, pendingPairs>>

-----------------------------------------------------------------------------
(* Safety Properties *)
-----------------------------------------------------------------------------

(*
 * CC_S1: Canonical Ordering
 * All non-zero edges have file1 < file2.
 *)
CanonicalOrdering ==
  \A r \in 1..MaxRepoId:
    \A f1, f2 \in FilePaths:
      cochangeEdges[r][<<f1, f2>>] > 0 => LessThan(f1, f2)

(*
 * CC_S2: Files Exist
 * Both files in any non-zero edge must be indexed.
 *)
FilesExist ==
  \A r \in 1..MaxRepoId:
    \A f1, f2 \in FilePaths:
      cochangeEdges[r][<<f1, f2>>] > 0 =>
        (f1 \in indexedFiles[r] /\ f2 \in indexedFiles[r])

(*
 * CC_S3: Positive Weight
 * All stored counts are non-negative (0 means no edge).
 *)
NonNegativeWeight ==
  \A r \in 1..MaxRepoId:
    \A p \in FilePaths \X FilePaths:
      cochangeEdges[r][p] >= 0

(*
 * CC_S4: Idempotent Processing
 * Once a commit is processed, processing it again has no effect.
 * (This is enforced by the precondition check in StartCommit)
 *)
IdempotentProcessing ==
  \A r \in 1..MaxRepoId:
    \A c \in processedCommits[r]:
      \* Cannot start processing an already-processed commit
      ~(currentRepo = r /\ currentCommit = c)

(*
 * Combined Safety Property
 *)
Safety ==
  /\ CanonicalOrdering
  /\ FilesExist
  /\ NonNegativeWeight
  /\ IdempotentProcessing

-----------------------------------------------------------------------------
(* Liveness Properties *)
-----------------------------------------------------------------------------

(*
 * CC_L1: Started commits eventually complete
 *)
CommitEventuallyCompletes ==
  (currentCommit # "NULL") ~> (currentCommit = "NULL")

(*
 * Combined Liveness Property
 *)
Liveness == CommitEventuallyCompletes

-----------------------------------------------------------------------------
(* Next State Relation *)
-----------------------------------------------------------------------------

Next ==
  \/ \E r \in 1..MaxRepoId, c \in CommitHashes, fs \in SUBSET FilePaths:
       StartCommit(r, c, fs)
  \/ ProcessPair
  \/ CompleteCommit
  \/ AbortCommit
  \/ \E r \in 1..MaxRepoId, p \in FilePaths: AddFile(r, p)
  \/ \E r \in 1..MaxRepoId, p \in FilePaths: RemoveFile(r, p)

-----------------------------------------------------------------------------
(* Specification *)
-----------------------------------------------------------------------------

Spec ==
  /\ Init
  /\ [][Next]_vars
  /\ WF_vars(ProcessPair)     \* Weak fairness: pairs get processed
  /\ WF_vars(CompleteCommit)  \* Weak fairness: commits complete

-----------------------------------------------------------------------------
(* Theorems *)
-----------------------------------------------------------------------------

THEOREM SafetyTheorem == Spec => []Safety

THEOREM LivenessTheorem == Spec => Liveness

-----------------------------------------------------------------------------
(* Invariant: Consistency with Dependency Graph *)
-----------------------------------------------------------------------------

(*
 * The co-change graph should only contain files that are
 * also in the dependency graph's indexed set.
 * (Assumes shared indexedFiles with GraphUpdate module)
 *)
ConsistentWithDependencyGraph(depIndexedFiles) ==
  \A r \in 1..MaxRepoId:
    indexedFiles[r] \subseteq depIndexedFiles[r]

=============================================================================
