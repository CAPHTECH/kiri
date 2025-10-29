import { describe, expect, it } from "vitest";

import {
  evaluateRetrieval,
  precisionAtK,
  timeToFirstUseful,
  type LatencyEvent,
} from "../../src/eval/metrics.js";

describe("evaluation metrics", () => {
  it("computes precision at K", () => {
    const retrieved = ["a", "b", "c", "d"];
    const relevant = new Set(["a", "c", "x"]);
    expect(precisionAtK(retrieved, relevant, 3)).toBeCloseTo(2 / 3);
    expect(precisionAtK(retrieved, relevant, 1)).toBe(1);
    expect(precisionAtK([], relevant, 5)).toBe(0);
  });

  it("computes time to first useful result in seconds", () => {
    const events: LatencyEvent[] = [
      { timestampMs: 40, relevant: false },
      { timestampMs: 120, relevant: true },
      { timestampMs: 200, relevant: false },
    ];
    expect(timeToFirstUseful(events)).toBeCloseTo(0.08, 2);
  });

  it("returns infinity when no useful result arrives", () => {
    const events: LatencyEvent[] = [
      { timestampMs: 10, relevant: false },
      { timestampMs: 20, relevant: false },
    ];
    expect(timeToFirstUseful(events)).toBe(Number.POSITIVE_INFINITY);
  });

  it("evaluates combined retrieval metrics", () => {
    const metrics = evaluateRetrieval({
      items: [
        { id: "x", timestampMs: 0 },
        { id: "y", timestampMs: 150 },
        { id: "z", timestampMs: 320 },
      ],
      relevant: new Set(["y", "z"]),
      k: 2,
    });
    expect(metrics.precisionAtK).toBeCloseTo(1 / 2);
    expect(metrics.timeToFirstUseful).toBeCloseTo(0.15, 2);
  });
});
