-- Plan C: Capability-based Composition
-- Structural model with explicit capability composition

module PlanC_CapabilityComposition

-- Core signatures
abstract sig Language {}
one sig TypeScript, Swift, PHP, Java, Dart, Rust extends Language {}

abstract sig Capability {}
one sig SymbolExtraction, TypeInference, DocComment, SignatureFormat extends Capability {}

sig CapabilityProvider {
    provides: set Capability,
    language: one Language
}

sig ComposedAnalyzer {
    language: one Language,
    providers: set CapabilityProvider,
    capabilities: set Capability
}

sig File {
    lang: one Language,
    lockedBy: lone ComposedAnalyzer
}

-- Facts

-- Composed analyzer's capabilities come from its providers
fact CapabilitiesFromProviders {
    all a: ComposedAnalyzer |
        a.capabilities = { c: Capability | some p: a.providers | c in p.provides }
}

-- Providers must match analyzer's language
fact ProviderLanguageMatch {
    all a: ComposedAnalyzer, p: a.providers | p.language = a.language
}

-- Every analyzer must have SymbolExtraction capability (minimum requirement)
fact MinimumCapability {
    all a: ComposedAnalyzer | SymbolExtraction in a.capabilities
}

-- File lock requires matching language
fact FileLockLanguageMatch {
    all f: File, a: ComposedAnalyzer | f.lockedBy = a implies a.language = f.lang
}

-- Mutual exclusion: a file locked by at most one analyzer
fact FileLockMutualExclusion {
    all f: File | lone f.lockedBy
}

-- No duplicate providers for same capability
fact NoDuplicateProviders {
    all a: ComposedAnalyzer, c: Capability |
        lone { p: a.providers | c in p.provides }
}

-- Assertions

-- Every analyzer has at least symbol extraction
assert MinimumCapabilityGuaranteed {
    all a: ComposedAnalyzer | SymbolExtraction in a.capabilities
}

-- Capabilities are traceable to providers
assert CapabilityTraceability {
    all a: ComposedAnalyzer, c: a.capabilities |
        some p: a.providers | c in p.provides
}

-- File lock consistency
assert FileLockConsistent {
    all f: File | some f.lockedBy implies f.lockedBy.language = f.lang
}

-- Capability completeness: if provider is included, all its caps are available
assert CapabilityCompleteness {
    all a: ComposedAnalyzer, p: a.providers, c: p.provides |
        c in a.capabilities
}

-- No orphan providers
assert NoOrphanProviders {
    all p: CapabilityProvider | some a: ComposedAnalyzer | p in a.providers
}

-- Run commands
run showComposedAnalyzer {
    some a: ComposedAnalyzer | #a.capabilities >= 3
} for 5

run showMultipleAnalyzers {
    #ComposedAnalyzer > 1
    all a: ComposedAnalyzer | #a.providers > 0
} for 6

check MinimumCapabilityGuaranteed for 10
check CapabilityTraceability for 10
check FileLockConsistent for 10
check CapabilityCompleteness for 10
check NoOrphanProviders for 8
