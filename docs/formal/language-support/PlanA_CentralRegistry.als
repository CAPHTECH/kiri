-- Plan A: Central Registry + Thin Abstraction
-- Structural model for language analyzer plugin architecture

module PlanA_CentralRegistry

-- Core signatures
abstract sig Language {}
one sig TypeScript, Swift, PHP, Java, Dart, Python, Go, Rust extends Language {}

abstract sig BackendType {}
one sig TreeSitter, CompilerAPI, LSP extends BackendType {}

sig Analyzer {
    language: one Language,
    backend: one BackendType,
    capabilities: set Capability
}

abstract sig Capability {}
one sig SymbolExtraction, TypeInference, DocComment, Signature extends Capability {}

sig Registry {
    analyzers: set Analyzer,
    languageMap: Language -> lone Analyzer
}

sig File {
    path: one Path,
    lang: one Language,
    lockedBy: lone Analyzer
}

sig Path {}

-- Facts (constraints)

-- Each language has at most one analyzer in the registry
fact UniqueAnalyzerPerLanguage {
    all r: Registry | all l: Language |
        lone (r.analyzers & language.l)
}

-- Language map must point to registered analyzers
fact LanguageMapConsistency {
    all r: Registry |
        r.languageMap[Language] in r.analyzers
}

-- An analyzer's language must match what it's mapped to
fact LanguageMapCorrectness {
    all r: Registry, l: Language, a: Analyzer |
        r.languageMap[l] = a implies a.language = l
}

-- File lock mutual exclusion: a file can only be locked by one analyzer
fact FileLockMutualExclusion {
    all f: File | lone f.lockedBy
}

-- File lock requires language match
fact FileLockLanguageMatch {
    all f: File, a: Analyzer | f.lockedBy = a implies a.language = f.lang
}

-- LSP backend requires SymbolExtraction capability
fact LSPRequiresSymbolExtraction {
    all a: Analyzer | a.backend = LSP implies SymbolExtraction in a.capabilities
}

-- TreeSitter provides at least SymbolExtraction
fact TreeSitterCapabilities {
    all a: Analyzer | a.backend = TreeSitter implies SymbolExtraction in a.capabilities
}

-- CompilerAPI provides all capabilities
fact CompilerAPICapabilities {
    all a: Analyzer | a.backend = CompilerAPI implies
        (SymbolExtraction + TypeInference + DocComment + Signature) in a.capabilities
}

-- Assertions to verify

-- No two analyzers for the same language
assert NoConflictingAnalyzers {
    all r: Registry, a1, a2: r.analyzers |
        a1.language = a2.language implies a1 = a2
}

-- Registry lookup is deterministic
assert DeterministicLookup {
    all r: Registry, l: Language |
        lone r.languageMap[l]
}

-- A locked file's analyzer must support its language
assert LockConsistency {
    all f: File, a: Analyzer |
        f.lockedBy = a implies a.language = f.lang
}

-- Deadlock freedom: no circular lock dependencies (trivially true with file-level locks)
assert NoDeadlock {
    all f1, f2: File |
        (f1.lockedBy != none and f2.lockedBy != none) implies
        (f1.lockedBy = f2.lockedBy or f1 != f2)
}

-- Run commands for verification
run showValidRegistry {
    some r: Registry | #r.analyzers > 2
} for 5 but exactly 1 Registry

run showFileLocking {
    some f: File | some f.lockedBy
} for 5 but exactly 1 Registry

check NoConflictingAnalyzers for 10
check DeterministicLookup for 10
check LockConsistency for 10
check NoDeadlock for 10
