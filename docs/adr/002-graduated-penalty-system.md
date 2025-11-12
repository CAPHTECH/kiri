# ADR 002: Graduated Penalty System for Path-Based Scoring

**Status**: Accepted
**Date**: 2025-11-12 (Proposed), 2025-11-12 (Accepted)
**Context**: Issue #68 investigation revealed that binary path miss penalty (`pathMatchHits === 0`) is never satisfied
**Outcome**: Implemented with +4.2% P@10 improvement (0.189 → 0.197)

## Context

Investigation of Issue #68 (Path/Large File Penalties) revealed that the binary penalty condition `pathMatchHits === 0` is almost never satisfied because:

1. KIRI's path-based scoring is highly effective (3 increment locations in `applyPathBasedScoring()`)
2. Almost every candidate file gets at least one path match
3. Grid search showed 0% P@10 improvement across 7 configurations
4. All 10 analyzed queries meet eligibility criteria, but zero penalties applied

**Evidence**:

- Static code analysis (src/server/handlers.ts:1161, 1172, 1182)
- Unit test verification (tests/server/telemetry.spec.ts: 9 passing tests)
- Query analysis (10/10 queries meet `wordCount >= 2 AND avgWordLength >= 4`)

## Decision

Implement a **graduated penalty system** that applies different penalty strengths based on `pathMatchHits` count:

```typescript
// Graduated Penalty Tiers
pathMatchHits === 0 → -0.8 (strong penalty: no path evidence)
pathMatchHits === 1 → -0.4 (medium penalty: weak path evidence)
pathMatchHits === 2 → -0.2 (light penalty: moderate path evidence)
pathMatchHits >= 3 → 0.0  (no penalty: strong path evidence)
```

### Design Principles (Law-Driven Engineering)

1. **Type-Driven Design**
   - Define `GraduatedPenaltyTier` type with explicit tiers
   - Use `readonly` for immutable configuration
   - Compile-time guarantees for penalty values

2. **Pure Functions**
   - Penalty calculation separated from application
   - `computeGraduatedPenalty(pathMatchHits, queryStats): number`
   - No side effects, testable in isolation

3. **Property-Based Testing**
   - Test invariants: penalty always <= 0
   - Test monotonicity: more hits → less penalty
   - Test boundary conditions: 0, 1, 2, 3+ hits

4. **Backward Compatibility**
   - Keep `KIRI_PATH_PENALTY` flag for enable/disable
   - Keep `KIRI_PATH_MISS_DELTA` for backward compatibility (deprecated)
   - New environment variables:
     - `KIRI_GRADUATED_PENALTY_MODE=1` (enable graduated mode)
     - `KIRI_PENALTY_TIER_0=-0.8` (pathMatchHits === 0)
     - `KIRI_PENALTY_TIER_1=-0.4` (pathMatchHits === 1)
     - `KIRI_PENALTY_TIER_2=-0.2` (pathMatchHits === 2)

## Implementation

### Type Design

```typescript
/**
 * 段階的ペナルティの設定（Issue #68: Graduated Penalty）
 * LDE: 型駆動設計で不変条件を保証
 */
interface GraduatedPenaltyConfig {
  readonly enabled: boolean;
  readonly minWordCount: number; // Default: 2
  readonly minAvgWordLength: number; // Default: 4.0
  readonly tier0Delta: number; // pathMatchHits === 0, default: -0.8
  readonly tier1Delta: number; // pathMatchHits === 1, default: -0.4
  readonly tier2Delta: number; // pathMatchHits === 2, default: -0.2
}

// Compile-time type guard: all deltas must be <= 0
type NegativeNumber = number & { __brand: "negative" };

interface SafeGraduatedPenaltyConfig {
  readonly enabled: boolean;
  readonly minWordCount: number;
  readonly minAvgWordLength: number;
  readonly tier0Delta: NegativeNumber;
  readonly tier1Delta: NegativeNumber;
  readonly tier2Delta: NegativeNumber;
}
```

### Pure Function Design

```typescript
/**
 * 段階的ペナルティ値を計算（Issue #68: Graduated Penalty）
 * LDE: 純粋関数（副作用なし、参照透明性）
 *
 * Invariants:
 * - Result is always <= 0
 * - More path hits → less penalty (monotonicity)
 * - Query must meet eligibility criteria
 */
function computeGraduatedPenalty(
  pathMatchHits: number,
  queryStats: QueryStats,
  config: GraduatedPenaltyConfig
): number {
  // Early return if query doesn't meet criteria
  if (
    queryStats.wordCount < config.minWordCount ||
    queryStats.avgWordLength < config.minAvgWordLength
  ) {
    return 0;
  }

  // Graduated penalty tiers
  if (pathMatchHits === 0) return config.tier0Delta;
  if (pathMatchHits === 1) return config.tier1Delta;
  if (pathMatchHits === 2) return config.tier2Delta;
  return 0; // pathMatchHits >= 3: no penalty
}
```

### Testing Strategy

1. **Unit Tests**
   - Test each tier independently
   - Test query eligibility filtering
   - Test boundary conditions (negative hits, NaN, etc.)

2. **Property-Based Tests** (fast-check)

   ```typescript
   // Property: Monotonicity
   fc.assert(
     fc.property(
       fc.nat(10), // pathMatchHits
       (hits) => {
         const penalty1 = computeGraduatedPenalty(hits, queryStats, config);
         const penalty2 = computeGraduatedPenalty(hits + 1, queryStats, config);
         return penalty2 >= penalty1; // More hits → less penalty
       }
     )
   );

   // Property: Always non-positive
   fc.assert(
     fc.property(fc.nat(10), (hits) => computeGraduatedPenalty(hits, queryStats, config) <= 0)
   );
   ```

3. **Integration Tests**
   - Golden set evaluation with graduated penalties enabled
   - Expect P@10 > 0.189 (current baseline)

## Consequences

### Positive

- **More candidates affected**: Penalties apply to pathMatchHits = 0, 1, 2 (not just 0)
- **Better differentiation**: Preserves ranking nuance between weak and strong matches
- **Measurable impact**: Expected P@10 improvement (hypothesis: > 0.20)
- **Type safety**: Compile-time guarantees for penalty values
- **Testability**: Pure functions enable property-based testing

### Negative

- **Complexity**: More tiers = more configuration parameters
- **Tuning required**: Optimal delta values may need empirical validation
- **Backward compatibility**: Need to maintain old binary penalty mode

### Risks

- **Over-penalization**: Too aggressive penalties may hurt precision
- **Under-penalization**: Too weak penalties may show no P@10 improvement
- **Mitigation**: Grid search with multiple tier configurations

## Alternatives Considered

1. **Binary penalty with lower threshold** (`pathMatchHits <= 1`)
   - Simpler but loses differentiation between 0 and 1 hits
   - Rejected: Graduated approach preserves more information

2. **Linear penalty** (`penalty = -0.1 * (3 - pathMatchHits)`)
   - More flexible but harder to tune
   - Rejected: Discrete tiers easier to reason about

3. **Disable feature entirely**
   - Simplest but loses potential P@10 improvement
   - Rejected: Worth trying graduated approach first

## Implementation Plan

1. ✅ Type design (this ADR)
2. Property-based test implementation
3. Pure function implementation
4. Integration with existing penalty logic
5. Grid search with graduated penalties
6. Analyze results and tune if needed
7. Update documentation

## References

- Issue #68: Path/Large File Penalties
- Investigation: var/eval/path-penalty-analysis.md
- Unit tests: tests/server/telemetry.spec.ts
- Related code: src/server/handlers.ts:1725-1738
