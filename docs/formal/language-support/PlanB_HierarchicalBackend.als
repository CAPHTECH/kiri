-- Plan B: Hierarchical Backend + Pool Integration
-- Structural model with resource pooling for LSP clients

module PlanB_HierarchicalBackend

-- Core signatures
abstract sig Language {}
one sig TypeScript, Swift, PHP, Java, Dart, Rust extends Language {}

abstract sig BackendType {}
one sig TreeSitter, CompilerAPI, LSP extends BackendType {}

abstract sig PoolState {}
one sig Available, InUse, Initializing, Failed extends PoolState {}

sig Client {
    state: one PoolState,
    language: one Language
}

sig Pool {
    clients: set Client,
    maxSize: one Int,
    language: one Language
}

sig Backend {
    backendType: one BackendType,
    pool: lone Pool
}

sig Analyzer {
    language: one Language,
    backend: one Backend
}

sig File {
    lang: one Language,
    lockedBy: lone Client
}

-- Facts

-- Pool size constraint
fact PoolSizePositive {
    all p: Pool | p.maxSize > 0 and p.maxSize <= 5
}

-- Clients in pool match pool's language
fact PoolClientLanguage {
    all p: Pool, c: p.clients | c.language = p.language
}

-- Pool size limit
fact PoolSizeLimit {
    all p: Pool | #p.clients <= p.maxSize
}

-- LSP backends must have a pool
fact LSPHasPool {
    all b: Backend | b.backendType = LSP implies some b.pool
}

-- Non-LSP backends don't have pools
fact NonLSPNoPool {
    all b: Backend | b.backendType != LSP implies no b.pool
}

-- A file can only be locked by an InUse client
fact FileLockRequiresInUse {
    all f: File | some f.lockedBy implies f.lockedBy.state = InUse
}

-- Mutual exclusion: a file locked by at most one client
fact FileLockMutualExclusion {
    all f: File | lone f.lockedBy
}

-- Client language must match file language for locking
fact LockLanguageMatch {
    all f: File, c: Client | f.lockedBy = c implies c.language = f.lang
}

-- Every client belongs to exactly one pool
fact ClientBelongsToPool {
    all c: Client | one p: Pool | c in p.clients
}

-- Assertions

-- Pool never exceeds max size
assert PoolNeverOverflows {
    all p: Pool | #p.clients <= p.maxSize
}

-- Available clients don't hold locks
assert AvailableClientsNoLocks {
    all c: Client | c.state = Available implies (all f: File | f.lockedBy != c)
}

-- File lock consistency
assert FileLockConsistent {
    all f: File | some f.lockedBy implies
        (f.lockedBy.state = InUse and f.lockedBy.language = f.lang)
}

-- Concurrent processing: different language files can be processed concurrently
assert ConcurrentProcessing {
    all disj f1, f2: File, disj c1, c2: Client |
        (f1.lockedBy = c1 and f2.lockedBy = c2 and f1.lang != f2.lang) implies c1 != c2
}

-- Run commands
run showPooledSystem {
    some p: Pool | #p.clients >= 2
    some f: File | some f.lockedBy
} for 6

run showMultiplePools {
    #Pool > 1
    all p: Pool | #p.clients > 0
} for 8

check PoolNeverOverflows for 10
check AvailableClientsNoLocks for 10
check FileLockConsistent for 10
check ConcurrentProcessing for 8
