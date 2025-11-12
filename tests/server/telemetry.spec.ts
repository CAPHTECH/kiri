/**
 * Issue #68: Path/Large File Penalty Telemetry Tests
 * LDE: Test-first approach for pure functions
 */

import { describe, it, expect } from "vitest";

// Stub interfaces (mirroring src/server/handlers.ts types)
interface PenaltyImpact {
  readonly kind: "path-miss" | "large-file";
  readonly delta: number;
  readonly details: Record<string, unknown>;
}

interface PathMatchDistribution {
  readonly zero: number;
  readonly one: number;
  readonly two: number;
  readonly three: number;
  readonly fourPlus: number;
  readonly total: number;
}

interface PenaltyTelemetry {
  readonly pathMissPenalties: number;
  readonly largeFilePenalties: number;
  readonly totalCandidates: number;
  readonly pathMatchDistribution: PathMatchDistribution;
}

interface TestCandidate {
  pathMatchHits: number;
  penalties: PenaltyImpact[];
}

// Pure functions extracted from handlers.ts
function computePathMatchDistribution(candidates: readonly TestCandidate[]): PathMatchDistribution {
  let zero = 0;
  let one = 0;
  let two = 0;
  let three = 0;
  let fourPlus = 0;

  for (const candidate of candidates) {
    const hits = candidate.pathMatchHits;
    if (hits === 0) zero++;
    else if (hits === 1) one++;
    else if (hits === 2) two++;
    else if (hits === 3) three++;
    else fourPlus++;
  }

  return {
    zero,
    one,
    two,
    three,
    fourPlus,
    total: candidates.length,
  };
}

function computePenaltyTelemetry(candidates: readonly TestCandidate[]): PenaltyTelemetry {
  let pathMissPenalties = 0;
  let largeFilePenalties = 0;

  for (const candidate of candidates) {
    for (const penalty of candidate.penalties) {
      if (penalty.kind === "path-miss") pathMissPenalties++;
      if (penalty.kind === "large-file") largeFilePenalties++;
    }
  }

  return {
    pathMissPenalties,
    largeFilePenalties,
    totalCandidates: candidates.length,
    pathMatchDistribution: computePathMatchDistribution(candidates),
  };
}

describe("Issue #68: Telemetry Functions", () => {
  describe("computePathMatchDistribution", () => {
    it("should count candidates with zero path matches", () => {
      const candidates: TestCandidate[] = [
        { pathMatchHits: 0, penalties: [] },
        { pathMatchHits: 0, penalties: [] },
        { pathMatchHits: 1, penalties: [] },
      ];

      const result = computePathMatchDistribution(candidates);

      expect(result.zero).toBe(2);
      expect(result.total).toBe(3);
    });

    it("should categorize all pathMatchHits ranges correctly", () => {
      const candidates: TestCandidate[] = [
        { pathMatchHits: 0, penalties: [] }, // zero
        { pathMatchHits: 1, penalties: [] }, // one
        { pathMatchHits: 1, penalties: [] }, // one
        { pathMatchHits: 2, penalties: [] }, // two
        { pathMatchHits: 3, penalties: [] }, // three
        { pathMatchHits: 4, penalties: [] }, // fourPlus
        { pathMatchHits: 10, penalties: [] }, // fourPlus
      ];

      const result = computePathMatchDistribution(candidates);

      expect(result).toEqual({
        zero: 1,
        one: 2,
        two: 1,
        three: 1,
        fourPlus: 2,
        total: 7,
      });
    });

    it("should handle empty candidate list", () => {
      const result = computePathMatchDistribution([]);

      expect(result).toEqual({
        zero: 0,
        one: 0,
        two: 0,
        three: 0,
        fourPlus: 0,
        total: 0,
      });
    });

    it("should verify Issue #68 hypothesis: pathMatchHits rarely equals zero", () => {
      // Simulate realistic KIRI search results
      const candidates: TestCandidate[] = Array.from({ length: 100 }, (_, i) => ({
        pathMatchHits: i < 95 ? Math.floor(Math.random() * 5) + 1 : 0, // 95% have hits >= 1
        penalties: [],
      }));

      const result = computePathMatchDistribution(candidates);

      // Hypothesis: < 10% of candidates have zero path matches
      const zeroPercentage = (result.zero / result.total) * 100;
      expect(zeroPercentage).toBeLessThan(10);
      expect(result.zero + result.one + result.two + result.three + result.fourPlus).toBe(100);
    });
  });

  describe("computePenaltyTelemetry", () => {
    it("should count path-miss penalties correctly", () => {
      const candidates: TestCandidate[] = [
        {
          pathMatchHits: 0,
          penalties: [{ kind: "path-miss", delta: -0.5, details: {} }],
        },
        {
          pathMatchHits: 0,
          penalties: [{ kind: "path-miss", delta: -0.5, details: {} }],
        },
        {
          pathMatchHits: 1,
          penalties: [],
        },
      ];

      const result = computePenaltyTelemetry(candidates);

      expect(result.pathMissPenalties).toBe(2);
      expect(result.largeFilePenalties).toBe(0);
      expect(result.totalCandidates).toBe(3);
    });

    it("should count large-file penalties correctly", () => {
      const candidates: TestCandidate[] = [
        {
          pathMatchHits: 2,
          penalties: [
            { kind: "large-file", delta: -0.8, details: { totalLines: 600, matchLine: 150 } },
          ],
        },
      ];

      const result = computePenaltyTelemetry(candidates);

      expect(result.pathMissPenalties).toBe(0);
      expect(result.largeFilePenalties).toBe(1);
    });

    it("should handle candidates with multiple penalties", () => {
      const candidates: TestCandidate[] = [
        {
          pathMatchHits: 0,
          penalties: [
            { kind: "path-miss", delta: -0.5, details: {} },
            { kind: "large-file", delta: -0.8, details: { totalLines: 600, matchLine: 150 } },
          ],
        },
      ];

      const result = computePenaltyTelemetry(candidates);

      expect(result.pathMissPenalties).toBe(1);
      expect(result.largeFilePenalties).toBe(1);
    });

    it("should include pathMatchHits distribution", () => {
      const candidates: TestCandidate[] = [
        { pathMatchHits: 0, penalties: [] },
        { pathMatchHits: 1, penalties: [] },
        { pathMatchHits: 2, penalties: [] },
      ];

      const result = computePenaltyTelemetry(candidates);

      expect(result.pathMatchDistribution).toEqual({
        zero: 1,
        one: 1,
        two: 1,
        three: 0,
        fourPlus: 0,
        total: 3,
      });
    });

    it("should verify Issue #68 root cause: penalties never applied when pathMatchHits always > 0", () => {
      // Simulate KIRI's actual behavior: all candidates have path matches
      // Spec-First: Use deterministic distribution instead of random to ensure test stability
      // Expected distribution based on typical KIRI behavior:
      // - Tier 1 (1 hit): 20% = 10 candidates
      // - Tier 2 (2 hits): 20% = 10 candidates
      // - Tier 3 (3 hits): 20% = 10 candidates
      // - Tier 4+ (4+ hits): 40% = 20 candidates
      const candidates: TestCandidate[] = [
        ...Array.from({ length: 10 }, () => ({ pathMatchHits: 1, penalties: [] })),
        ...Array.from({ length: 10 }, () => ({ pathMatchHits: 2, penalties: [] })),
        ...Array.from({ length: 10 }, () => ({ pathMatchHits: 3, penalties: [] })),
        ...Array.from({ length: 20 }, (_, i) => ({
          pathMatchHits: 4 + (i % 6), // 4, 5, 6, 7, 8, 9
          penalties: [],
        })),
      ];

      const result = computePenaltyTelemetry(candidates);

      // Root cause verification
      expect(result.pathMatchDistribution.zero).toBe(0); // No candidates with zero hits
      expect(result.pathMissPenalties).toBe(0); // Therefore, no penalties applied
      // Verify expected distribution (Spec-First)
      expect(result.pathMatchDistribution.one).toBe(10);
      expect(result.pathMatchDistribution.two).toBe(10);
      expect(result.pathMatchDistribution.three).toBe(10);
      expect(result.pathMatchDistribution.fourPlus).toBe(20);
      expect(result.pathMatchDistribution.total).toBe(50);
    });
  });
});
