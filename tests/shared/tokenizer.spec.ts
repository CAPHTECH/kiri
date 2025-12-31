import { describe, expect, it } from "vitest";

import { tokenizeText } from "../../src/shared/tokenizer.js";

describe("tokenizeText", () => {
  it("retains hyphenated phrases while exposing split parts", () => {
    const tokens = tokenizeText("Mann-Whitney U test", "phrase-aware");
    expect(tokens).toEqual(expect.arrayContaining(["mann-whitney", "mann", "whitney", "test"]));
  });

  it("splits snake_case identifiers", () => {
    const tokens = tokenizeText("rank_biserial_effect", "phrase-aware");
    expect(tokens).toEqual(
      expect.arrayContaining(["rank_biserial_effect", "rank", "biserial", "effect"])
    );
  });

  it("splits camelCase identifiers", () => {
    const tokens = tokenizeText("workerPoolScheduler handler", "phrase-aware");
    expect(tokens).toEqual(
      expect.arrayContaining(["workerpoolscheduler", "worker", "pool", "scheduler", "handler"])
    );
  });

  it("splits alphanumeric boundaries", () => {
    const tokens = tokenizeText("ISO8601Parser", "phrase-aware");
    expect(tokens).toEqual(expect.arrayContaining(["iso8601parser", "iso", "8601", "parser"]));
  });

  it("preserves legacy behavior by excluding hyphenated phrases", () => {
    const tokens = tokenizeText("foo-bar baz", "legacy");
    expect(tokens).toEqual(expect.arrayContaining(["foo", "bar", "baz"]));
    expect(tokens).not.toContain("foo-bar");
  });

  // LAW-token-hybrid-consistency: hybrid戦略はphrase-awareと同一動作
  // @see Issue #189
  describe("hybrid strategy", () => {
    it("outputs both compound terms and split keywords (same as phrase-aware)", () => {
      const tokens = tokenizeText("page-agent handler", "hybrid");
      expect(tokens).toEqual(expect.arrayContaining(["page-agent", "page", "agent", "handler"]));
    });

    it("handles snake_case same as phrase-aware", () => {
      const tokens = tokenizeText("worker_pool", "hybrid");
      expect(tokens).toEqual(expect.arrayContaining(["worker_pool", "worker", "pool"]));
    });

    it("produces identical output to phrase-aware", () => {
      const input = "context-bundle ISO8601Parser";
      const phraseAwareTokens = tokenizeText(input, "phrase-aware");
      const hybridTokens = tokenizeText(input, "hybrid");
      expect(hybridTokens).toEqual(phraseAwareTokens);
    });
  });
});
