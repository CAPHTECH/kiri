# ADR 003: Abbreviation Expansion for Path Matching

**Status**: Accepted
**Date**: 2025-11-12
**Deciders**: Issue #68 investigation team
**Related**: ADR 002 (Graduated Penalty System)

## Context

After implementing the graduated penalty system (ADR 002), telemetry analysis revealed:

- **90.1% of candidates have zero path matches** (pathMatchHits === 0)
- P@10 improvement was only +4.2% (0.189 → 0.197)
- Root cause: Vocabulary gap between natural language queries and technical path abbreviations

**Examples of mismatches**:
| Query Term | Path Component | Match? |
|------------|----------------|--------|
| "database" | "duckdb" | ❌ No |
| "database" | "db" | ❌ No |
| "configuration" | "config" | ❌ No |
| "error" | "err" | ❌ No |

Current `applyPathBasedScoring()` uses literal substring matching:

```typescript
if (lowerPath.includes(keyword)) {
  candidate.score += weights.pathMatch * 0.5;
}
```

This fails when query terms and path components are semantically equivalent but lexically different.

## Decision

Implement **abbreviation expansion** to bridge the vocabulary gap between natural language queries and technical path names.

**Approach**: Static dictionary mapping canonical terms to common abbreviations.

### Why Static Dictionary?

Considered three options during design phase:

1. **Static dictionary** ✅ SELECTED
   - Simple, fast, deterministic
   - Easy to maintain and extend
   - No performance overhead
   - Predictable behavior

2. **Fuzzy matching** (Levenshtein distance)
   - Flexible but computationally expensive
   - Risk of exceeding 10ms performance budget
   - May produce false positives

3. **N-gram similarity**
   - Middle ground complexity
   - Still has performance concerns
   - Less intuitive for maintenance

**Rationale**: YAGNI principle - start simple, measure impact, add complexity only if needed.

## Implementation

### Type Definitions (LDE-compliant)

```typescript
/**
 * Abbreviation mapping (LDE: readonly, immutable)
 */
interface AbbreviationMap {
  readonly canonical: string;
  readonly variants: readonly string[];
}
```

### Pure Function

```typescript
/**
 * Expand term with common abbreviations (LDE: pure function)
 *
 * @param term - Query term to expand
 * @param abbreviations - Abbreviation dictionary
 * @returns Array of expanded terms including canonical and variants
 *
 * Examples:
 *   expandAbbreviations("db", dictionary) → ["database", "db"]
 *   expandAbbreviations("config", dictionary) → ["configuration", "config", "cfg", "conf"]
 *   expandAbbreviations("unknown", dictionary) → ["unknown"]
 */
function expandAbbreviations(
  term: string,
  abbreviations: readonly AbbreviationMap[]
): readonly string[] {
  const normalized = term.toLowerCase().trim();

  const map = abbreviations.find(
    (m) => m.canonical === normalized || m.variants.includes(normalized)
  );

  if (map) {
    return [map.canonical, ...map.variants];
  }

  return [term];
}
```

### Default Dictionary

Initial set of 20 common software abbreviations:

```typescript
const DEFAULT_ABBREVIATIONS: readonly AbbreviationMap[] = [
  { canonical: "database", variants: ["db", "data"] },
  { canonical: "configuration", variants: ["config", "cfg", "conf"] },
  { canonical: "error", variants: ["err", "errors"] },
  { canonical: "utilities", variants: ["util", "utils"] },
  { canonical: "controller", variants: ["ctrl"] },
  { canonical: "manager", variants: ["mgr"] },
  { canonical: "implementation", variants: ["impl"] },
  { canonical: "specification", variants: ["spec", "specs"] },
  { canonical: "source", variants: ["src"] },
  { canonical: "directory", variants: ["dir"] },
  { canonical: "repository", variants: ["repo"] },
  { canonical: "application", variants: ["app"] },
  { canonical: "service", variants: ["svc", "srv"] },
  { canonical: "authentication", variants: ["auth"] },
  { canonical: "authorization", variants: ["authz"] },
  { canonical: "document", variants: ["doc", "docs"] },
  { canonical: "temporary", variants: ["tmp", "temp"] },
  { canonical: "administrator", variants: ["admin"] },
  { canonical: "development", variants: ["dev"] },
  { canonical: "production", variants: ["prod"] },
];
```

### Integration

Modify `applyPathBasedScoring()` to expand terms before matching:

```typescript
function applyPathBasedScoring(
  candidate: CandidateInfo,
  lowerPath: string,
  weights: ScoringWeights,
  extractedTerms?: ExtractedTerms
): void {
  if (!extractedTerms || weights.pathMatch <= 0) {
    return;
  }

  // Existing exact matching (phrases, pathSegments, keywords)
  // ...

  // NEW: Abbreviation-expanded matching for keywords only
  for (const keyword of extractedTerms.keywords) {
    const expandedTerms = expandAbbreviations(keyword, DEFAULT_ABBREVIATIONS);

    for (const term of expandedTerms) {
      // Skip if already matched exactly
      if (term === keyword) continue;

      if (lowerPath.includes(term)) {
        candidate.score += weights.pathMatch * 0.4; // Lower weight than exact
        candidate.reasons.add(`abbr-path:${keyword}→${term}`);
        candidate.pathMatchHits++; // Count for penalty calculation
      }
    }
  }
}
```

**Key design decisions**:

1. Only expand keywords (not phrases or pathSegments) to avoid over-matching
2. Lower weight (0.4x vs 0.5x) for expanded matches vs exact matches
3. Skip the original keyword to avoid double-counting
4. Track expansions in reasons for debugging

## Consequences

### Positive

✅ **Improved match rate**: Expected 40-50% (from 10%)

- "database" will now match "db", "duckdb"
- "config" will match "configuration", "cfg"

✅ **Simple and maintainable**:

- Pure function, no side effects
- Easy to test with property-based tests
- Clear dictionary updates

✅ **Performance guaranteed**:

- O(n) dictionary lookup per term
- No expensive distance calculations
- Well within <10ms budget

✅ **LDE-compliant**:

- Readonly types
- Pure functions
- Property-based tests

✅ **Staged rollout**:

- Can measure impact independently
- Add fuzzy matching later if needed (YAGNI)

### Negative

⚠️ **Dictionary maintenance**:

- Requires manual updates for new abbreviations
- No automatic discovery

⚠️ **Domain-specific abbreviations**:

- Current dictionary is general-purpose
- May miss project-specific abbreviations (e.g., "FTS" → "full-text search")

⚠️ **Ambiguous abbreviations**:

- "db" could mean "database" or "debug"
- Resolution: Use most common meaning, accept some false positives

### Mitigation

1. **Dictionary maintenance**: Document contribution process in README
2. **Domain abbreviations**: Add project-specific entries as needed
3. **Ambiguity**: Monitor telemetry for false positives, refine as needed

## Testing Strategy

### Unit Tests

```typescript
describe("expandAbbreviations", () => {
  it("expands known abbreviation", () => {
    const result = expandAbbreviations("db", DEFAULT_ABBREVIATIONS);
    expect(result).toContain("database");
    expect(result).toContain("db");
  });

  it("returns original for unknown term", () => {
    const result = expandAbbreviations("unknown", DEFAULT_ABBREVIATIONS);
    expect(result).toEqual(["unknown"]);
  });
});
```

### Property-Based Tests (fast-check)

```typescript
it("Property: canonical always included", () => {
  fc.assert(
    fc.property(fc.constantFrom("db", "config", "err"), (abbr) => {
      const expanded = expandAbbreviations(abbr, DEFAULT_ABBREVIATIONS);
      const map = DEFAULT_ABBREVIATIONS.find((m) => m.variants.includes(abbr));
      return expanded.includes(map?.canonical ?? abbr);
    })
  );
});

it("Property: expansion is symmetric", () => {
  fc.assert(
    fc.property(fc.constantFrom("database", "db"), (term) => {
      const expanded = expandAbbreviations(term, DEFAULT_ABBREVIATIONS);
      return expanded.includes("database") && expanded.includes("db");
    })
  );
});
```

### Integration Test

Verify pathMatchHits distribution improves after abbreviation expansion.

## Metrics

**Before** (Graduated Penalty only):

- P@10: 0.197
- Zero matches: 90.1%
- TFFU: 2ms

**Actual Result** (with Abbreviation Expansion):

- P@10: 0.197 (**NO CHANGE** ❌)
- Zero matches: 89.1% (1.0% improvement)
- TFFU: 2ms (maintained)

**Analysis**: Abbreviation expansion provided minimal benefit (1% reduction in zero matches) with no impact on P@10. Root cause: Static dictionary cannot bridge the semantic gap between natural language queries and technical path components.

## Evaluation Results (2025-11-12)

Implemented and evaluated per ADR 003 recommendations. Results showed:

1. ✅ **Implementation quality**: LDE-compliant, 19/19 property tests passing
2. ✅ **Performance**: <1ms overhead, well within budget
3. ❌ **Effectiveness**: Only 1% improvement in match rate, P@10 unchanged

**pathMatchHits distribution** (892 candidates, 18 queries):

- Tier 0 (0 hits): 795 (89.1%) - was 804 (90.1%)
- Tier 1 (1 hit): 44 (4.9%) - was 35 (3.9%)
- Tier 2 (2 hits): 45 (5.0%) - unchanged
- Tier 3+ (3+ hits): 8 (0.9%) - unchanged

**Root causes of limited effectiveness**:

1. Domain-specific abbreviations missing (e.g., "fts", "vss", "rpc")
2. Compound names in paths (e.g., "duckdb" not "db")
3. Semantic gap persists (e.g., "timeout", "connection" not abbreviatable)

## Decision: Accept Current State

After evaluation, **Option D (Accept Current State)** was selected because:

1. ✅ P@10 = 0.197 is +4.2% improvement over baseline (0.189)
2. ✅ TFFU = 2ms is excellent (well under 1s target)
3. ✅ Graduated penalty system works correctly
4. ❌ Further path-based optimization shows diminishing returns
5. 💡 Better to focus on other ranking signals (semantic similarity, content matching)

## Future Work

Path-based matching has reached practical limits with current approach. For significant P@10 improvement beyond 0.2, consider:

1. **Semantic embeddings** (recommended): Use VSS for path-query similarity
   - Expected P@10 impact: +0.3 to +0.5
   - Complexity: High (architectural change)

2. **Fuzzy matching**: Add Levenshtein distance + n-gram
   - Expected P@10 impact: +0.05 to +0.10
   - Complexity: Medium (performance risk)

3. **Extended dictionary**: Add domain-specific abbreviations
   - Expected P@10 impact: +0.02 to +0.05
   - Complexity: Low (maintenance burden)

**Recommended**: Pursue semantic embeddings or accept P@10 = 0.2 as sufficient for path-based penalties.

## References

- Issue #68: Path and Large File Penalty System
- ADR 002: Graduated Penalty System
- Telemetry analysis: `/var/eval/issue-68-investigation-final.md`
- Critical review: `/tmp/fuzzy-path-critical-review.md`
