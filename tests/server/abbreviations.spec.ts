/**
 * Property-based tests for abbreviation expansion (ADR 003)
 *
 * Uses fast-check to verify LDE invariants:
 * - Purity: Same input → same output
 * - Symmetry: All variants expand to same set
 * - Completeness: Canonical always included
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  expandAbbreviations,
  DEFAULT_ABBREVIATIONS,
  type AbbreviationMap,
} from "../../src/server/abbreviations.js";

describe("expandAbbreviations", () => {
  // ===== Unit Tests =====

  describe("Unit: Known abbreviations", () => {
    it("expands 'db' to include 'database'", () => {
      const result = expandAbbreviations("db");
      expect(result).toContain("database");
      expect(result).toContain("db");
    });

    it("expands 'config' to include all variants", () => {
      const result = expandAbbreviations("config");
      expect(result).toContain("configuration");
      expect(result).toContain("config");
      expect(result).toContain("cfg");
      expect(result).toContain("conf");
    });

    it("expands canonical 'database' to include variants", () => {
      const result = expandAbbreviations("database");
      expect(result).toContain("database");
      expect(result).toContain("db");
      expect(result).toContain("data");
    });
  });

  describe("Unit: Unknown terms", () => {
    it("returns original term for unknown input", () => {
      const result = expandAbbreviations("unknown");
      expect(result).toEqual(["unknown"]);
    });

    it("returns original term for empty string", () => {
      const result = expandAbbreviations("");
      expect(result).toEqual([""]);
    });
  });

  describe("Unit: Case insensitivity", () => {
    it("handles uppercase input", () => {
      const result = expandAbbreviations("DB");
      expect(result).toContain("database");
    });

    it("handles mixed case input", () => {
      const result = expandAbbreviations("CoNfIg");
      expect(result).toContain("configuration");
    });
  });

  describe("Unit: Whitespace handling", () => {
    it("trims leading whitespace", () => {
      const result = expandAbbreviations("  db");
      expect(result).toContain("database");
    });

    it("trims trailing whitespace", () => {
      const result = expandAbbreviations("db  ");
      expect(result).toContain("database");
    });
  });

  // ===== Property-Based Tests =====

  describe("Property: Purity", () => {
    it("same input always produces same output", () => {
      fc.assert(
        fc.property(fc.constantFrom("db", "config", "err", "unknown"), (term) => {
          const result1 = expandAbbreviations(term);
          const result2 = expandAbbreviations(term);
          return JSON.stringify(result1) === JSON.stringify(result2);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe("Property: Canonical inclusion", () => {
    it("canonical form always included in expansion", () => {
      fc.assert(
        fc.property(fc.constantFrom("db", "config", "err", "util", "impl", "spec"), (abbr) => {
          const result = expandAbbreviations(abbr);
          const map = DEFAULT_ABBREVIATIONS.find((m) => m.variants.includes(abbr));
          return map ? result.includes(map.canonical) : true;
        }),
        { numRuns: 50 }
      );
    });
  });

  describe("Property: Symmetry", () => {
    it("all variants expand to same set", () => {
      fc.assert(
        fc.property(
          fc.constantFrom(
            ["database", "db", "data"],
            ["configuration", "config", "cfg", "conf"],
            ["error", "err", "errors"]
          ),
          (variants) => {
            const expansions = variants.map((v) => new Set(expandAbbreviations(v)));
            const first = Array.from(expansions[0]).sort();

            // All expansions should be identical
            return expansions.every((exp) => {
              const sorted = Array.from(exp).sort();
              return JSON.stringify(sorted) === JSON.stringify(first);
            });
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe("Property: Completeness", () => {
    it("expansion includes original term", () => {
      fc.assert(
        fc.property(fc.constantFrom("db", "database", "config", "unknown"), (term) => {
          const result = expandAbbreviations(term);
          // Either exact match or canonical match
          return (
            result.includes(term.toLowerCase().trim()) ||
            result.some((r) => r === term.toLowerCase().trim())
          );
        }),
        { numRuns: 100 }
      );
    });
  });

  describe("Property: No duplicates", () => {
    it("expansion contains no duplicate entries", () => {
      fc.assert(
        fc.property(fc.constantFrom("db", "config", "err", "util"), (term) => {
          const result = expandAbbreviations(term);
          const unique = [...new Set(result)];
          return result.length === unique.length;
        }),
        { numRuns: 100 }
      );
    });
  });

  describe("Property: Non-empty result", () => {
    it("expansion always returns at least one term", () => {
      fc.assert(
        fc.property(fc.string(), (term) => {
          const result = expandAbbreviations(term);
          return result.length >= 1;
        }),
        { numRuns: 100 }
      );
    });
  });

  // ===== Integration Tests with Custom Dictionary =====

  describe("Integration: Custom dictionary", () => {
    const customDict: readonly AbbreviationMap[] = [
      { canonical: "test", variants: ["tst"] },
      { canonical: "example", variants: ["ex", "exmpl"] },
    ];

    it("uses custom dictionary when provided", () => {
      const result = expandAbbreviations("tst", customDict);
      expect(result).toContain("test");
      expect(result).toContain("tst");
    });

    it("doesn't match default abbreviations with custom dict", () => {
      const result = expandAbbreviations("db", customDict);
      expect(result).toEqual(["db"]); // Not in custom dict
    });
  });

  // ===== Regression Tests =====

  describe("Regression: Edge cases from telemetry", () => {
    it("handles common query terms from golden set", () => {
      const terms = ["database", "config", "error", "handler", "server"];
      terms.forEach((term) => {
        const result = expandAbbreviations(term);
        expect(result.length).toBeGreaterThan(0);
      });
    });

    it("handles technical abbreviations", () => {
      const abbrs = ["db", "cfg", "err", "impl", "spec"];
      abbrs.forEach((abbr) => {
        const result = expandAbbreviations(abbr);
        expect(result).toContain(abbr);
      });
    });
  });
});
