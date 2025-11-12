/**
 * Issue #68: Graduated Penalty System Tests
 * LDE: Property-based testing with fast-check
 */

import fc from "fast-check";
import { describe, it, expect } from "vitest";

// Stub interfaces (will be imported from handlers.ts after implementation)
interface QueryStats {
  readonly wordCount: number;
  readonly avgWordLength: number;
}

interface GraduatedPenaltyConfig {
  readonly enabled: boolean;
  readonly minWordCount: number;
  readonly minAvgWordLength: number;
  readonly tier0Delta: number; // pathMatchHits === 0
  readonly tier1Delta: number; // pathMatchHits === 1
  readonly tier2Delta: number; // pathMatchHits === 2
}

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

/**
 * 環境変数から段階的ペナルティ設定を読み込む
 * LDE: 純粋関数（I/O分離、テスト可能）
 */
function readGraduatedPenaltyConfig(
  env: Record<string, string | undefined>
): GraduatedPenaltyConfig {
  return {
    enabled: env.KIRI_GRADUATED_PENALTY === "1",
    minWordCount: parseFloat(env.KIRI_PENALTY_MIN_WORD_COUNT || "2"),
    minAvgWordLength: parseFloat(env.KIRI_PENALTY_MIN_AVG_WORD_LENGTH || "4.0"),
    tier0Delta: parseFloat(env.KIRI_PENALTY_TIER_0 || "-0.8"),
    tier1Delta: parseFloat(env.KIRI_PENALTY_TIER_1 || "-0.4"),
    tier2Delta: parseFloat(env.KIRI_PENALTY_TIER_2 || "-0.2"),
  };
}

describe("Issue #68: Graduated Penalty System", () => {
  const defaultConfig: GraduatedPenaltyConfig = {
    enabled: true,
    minWordCount: 2,
    minAvgWordLength: 4.0,
    tier0Delta: -0.8,
    tier1Delta: -0.4,
    tier2Delta: -0.2,
  };

  const eligibleQuery: QueryStats = {
    wordCount: 5,
    avgWordLength: 7.5,
  };

  describe("Unit Tests: Tier-specific behavior", () => {
    it("should apply tier 0 penalty (-0.8) for pathMatchHits === 0", () => {
      const penalty = computeGraduatedPenalty(0, eligibleQuery, defaultConfig);
      expect(penalty).toBe(-0.8);
    });

    it("should apply tier 1 penalty (-0.4) for pathMatchHits === 1", () => {
      const penalty = computeGraduatedPenalty(1, eligibleQuery, defaultConfig);
      expect(penalty).toBe(-0.4);
    });

    it("should apply tier 2 penalty (-0.2) for pathMatchHits === 2", () => {
      const penalty = computeGraduatedPenalty(2, eligibleQuery, defaultConfig);
      expect(penalty).toBe(-0.2);
    });

    it("should apply no penalty for pathMatchHits >= 3", () => {
      expect(computeGraduatedPenalty(3, eligibleQuery, defaultConfig)).toBe(0);
      expect(computeGraduatedPenalty(4, eligibleQuery, defaultConfig)).toBe(0);
      expect(computeGraduatedPenalty(10, eligibleQuery, defaultConfig)).toBe(0);
    });
  });

  describe("Unit Tests: Query eligibility filtering", () => {
    it("should return 0 when wordCount < minWordCount", () => {
      const ineligibleQuery: QueryStats = { wordCount: 1, avgWordLength: 7.5 };
      const penalty = computeGraduatedPenalty(0, ineligibleQuery, defaultConfig);
      expect(penalty).toBe(0);
    });

    it("should return 0 when avgWordLength < minAvgWordLength", () => {
      const ineligibleQuery: QueryStats = { wordCount: 5, avgWordLength: 3.0 };
      const penalty = computeGraduatedPenalty(0, ineligibleQuery, defaultConfig);
      expect(penalty).toBe(0);
    });

    it("should return 0 when both criteria are not met", () => {
      const ineligibleQuery: QueryStats = { wordCount: 1, avgWordLength: 3.0 };
      const penalty = computeGraduatedPenalty(0, ineligibleQuery, defaultConfig);
      expect(penalty).toBe(0);
    });
  });

  describe("Unit Tests: Edge cases", () => {
    it("should handle negative pathMatchHits gracefully", () => {
      const penalty = computeGraduatedPenalty(-1, eligibleQuery, defaultConfig);
      expect(penalty).toBe(0); // Should not match any tier
    });

    it("should handle very large pathMatchHits", () => {
      const penalty = computeGraduatedPenalty(1000, eligibleQuery, defaultConfig);
      expect(penalty).toBe(0);
    });

    it("should handle zero wordCount", () => {
      const query: QueryStats = { wordCount: 0, avgWordLength: 7.5 };
      const penalty = computeGraduatedPenalty(0, query, defaultConfig);
      expect(penalty).toBe(0);
    });

    it("should handle zero avgWordLength", () => {
      const query: QueryStats = { wordCount: 5, avgWordLength: 0 };
      const penalty = computeGraduatedPenalty(0, query, defaultConfig);
      expect(penalty).toBe(0);
    });
  });

  describe("Property-Based Tests: Invariants", () => {
    it("Property: penalty is always <= 0 (non-positive)", () => {
      fc.assert(
        fc.property(
          fc.nat(20), // pathMatchHits: 0-20
          fc.integer({ min: 0, max: 10 }), // wordCount
          fc.float({ min: 0, max: 20 }), // avgWordLength
          (hits, wordCount, avgWordLength) => {
            const query: QueryStats = { wordCount, avgWordLength };
            const penalty = computeGraduatedPenalty(hits, query, defaultConfig);
            return penalty <= 0;
          }
        ),
        { numRuns: 1000 }
      );
    });

    it("Property: monotonicity - more hits → less penalty (or equal)", () => {
      fc.assert(
        fc.property(
          fc.nat(10), // pathMatchHits: 0-10
          (hits) => {
            const penalty1 = computeGraduatedPenalty(hits, eligibleQuery, defaultConfig);
            const penalty2 = computeGraduatedPenalty(hits + 1, eligibleQuery, defaultConfig);
            // penalty2 should be >= penalty1 (less negative or zero)
            return penalty2 >= penalty1;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("Property: query eligibility is necessary - ineligible queries always return 0", () => {
      fc.assert(
        fc.property(
          fc.nat(20), // pathMatchHits
          fc.integer({ min: 0, max: 1 }), // wordCount < 2 (ineligible)
          fc.float({ min: 0, max: Math.fround(3.9) }), // avgWordLength < 4.0 (ineligible)
          (hits, wordCount, avgWordLength) => {
            const query: QueryStats = { wordCount, avgWordLength };
            const penalty = computeGraduatedPenalty(hits, query, defaultConfig);
            return penalty === 0;
          }
        ),
        { numRuns: 1000 }
      );
    });

    it("Property: tier ordering - tier0 < tier1 < tier2 <= 0", () => {
      // This is a configuration invariant, not a runtime property
      expect(defaultConfig.tier0Delta).toBeLessThan(defaultConfig.tier1Delta);
      expect(defaultConfig.tier1Delta).toBeLessThan(defaultConfig.tier2Delta);
      expect(defaultConfig.tier2Delta).toBeLessThanOrEqual(0);
    });
  });

  describe("Configuration Loading", () => {
    it("should load default config when no env vars set", () => {
      const config = readGraduatedPenaltyConfig({});
      expect(config).toEqual({
        enabled: false, // KIRI_GRADUATED_PENALTY not set
        minWordCount: 2,
        minAvgWordLength: 4.0,
        tier0Delta: -0.8,
        tier1Delta: -0.4,
        tier2Delta: -0.2,
      });
    });

    it("should parse custom tier values from env vars", () => {
      const env = {
        KIRI_GRADUATED_PENALTY: "1",
        KIRI_PENALTY_TIER_0: "-1.0",
        KIRI_PENALTY_TIER_1: "-0.5",
        KIRI_PENALTY_TIER_2: "-0.1",
      };
      const config = readGraduatedPenaltyConfig(env);
      expect(config.enabled).toBe(true);
      expect(config.tier0Delta).toBe(-1.0);
      expect(config.tier1Delta).toBe(-0.5);
      expect(config.tier2Delta).toBe(-0.1);
    });

    it("should parse custom eligibility thresholds", () => {
      const env = {
        KIRI_PENALTY_MIN_WORD_COUNT: "3",
        KIRI_PENALTY_MIN_AVG_WORD_LENGTH: "5.0",
      };
      const config = readGraduatedPenaltyConfig(env);
      expect(config.minWordCount).toBe(3);
      expect(config.minAvgWordLength).toBe(5.0);
    });
  });

  describe("Integration: Realistic scenarios", () => {
    it("should penalize candidates with zero path matches", () => {
      const candidates = [
        { pathMatchHits: 0, score: 10.0 }, // Should get -0.8
        { pathMatchHits: 1, score: 10.0 }, // Should get -0.4
        { pathMatchHits: 2, score: 10.0 }, // Should get -0.2
        { pathMatchHits: 3, score: 10.0 }, // Should get 0.0
      ];

      const penalizedScores = candidates.map((c) => {
        const penalty = computeGraduatedPenalty(c.pathMatchHits, eligibleQuery, defaultConfig);
        return c.score + penalty;
      });

      expect(penalizedScores).toEqual([9.2, 9.6, 9.8, 10.0]);
    });

    it("should maintain ranking order with graduated penalties", () => {
      // Scenario: Two candidates with similar base scores
      // Candidate A: pathMatchHits = 1, score = 10.0
      // Candidate B: pathMatchHits = 2, score = 9.9
      const penaltyA = computeGraduatedPenalty(1, eligibleQuery, defaultConfig);
      const penaltyB = computeGraduatedPenalty(2, eligibleQuery, defaultConfig);

      const scoreA = 10.0 + penaltyA; // 10.0 - 0.4 = 9.6
      const scoreB = 9.9 + penaltyB; // 9.9 - 0.2 = 9.7

      // B should rank higher despite lower base score (more path evidence)
      expect(scoreB).toBeGreaterThan(scoreA);
    });
  });
});
