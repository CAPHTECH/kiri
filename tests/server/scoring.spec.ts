import { describe, it, expect } from "vitest";

import {
  loadScoringProfile,
  coerceProfileName,
  type ScoringProfileName,
} from "../../src/server/scoring.js";

describe("scoring", () => {
  describe("loadScoringProfile", () => {
    it("should return default profile with all required weights", () => {
      const profile = loadScoringProfile("default");

      // Basic weights
      expect(profile.textMatch).toBeGreaterThan(0);
      expect(profile.pathMatch).toBeGreaterThan(0);
      expect(profile.editingPath).toBeGreaterThan(0);
      expect(profile.dependency).toBeGreaterThanOrEqual(0);
      expect(profile.proximity).toBeGreaterThanOrEqual(0);
      expect(profile.structural).toBeGreaterThanOrEqual(0);

      // Penalty multipliers
      expect(profile.docPenaltyMultiplier).toBeGreaterThanOrEqual(0);
      expect(profile.docPenaltyMultiplier).toBeLessThanOrEqual(1);
      expect(profile.configPenaltyMultiplier).toBeGreaterThanOrEqual(0);
      expect(profile.configPenaltyMultiplier).toBeLessThanOrEqual(1);
      expect(profile.implBoostMultiplier).toBeGreaterThanOrEqual(1);
      expect(profile.blacklistPenaltyMultiplier).toBeGreaterThanOrEqual(0);
      expect(profile.blacklistPenaltyMultiplier).toBeLessThanOrEqual(1);
      expect(profile.testPenaltyMultiplier).toBeGreaterThanOrEqual(0);
      expect(profile.testPenaltyMultiplier).toBeLessThanOrEqual(1);
      expect(profile.lockPenaltyMultiplier).toBeGreaterThanOrEqual(0);
      expect(profile.lockPenaltyMultiplier).toBeLessThanOrEqual(1);
    });

    it("should return default profile when profile name is null/undefined", () => {
      const profileNull = loadScoringProfile(null);
      const profileUndef = loadScoringProfile(undefined);
      const defaultProfile = loadScoringProfile("default");

      expect(profileNull.textMatch).toBe(defaultProfile.textMatch);
      expect(profileUndef.textMatch).toBe(defaultProfile.textMatch);
    });

    it("should return different weights for different profiles", () => {
      const bugfix = loadScoringProfile("bugfix");
      const _feature = loadScoringProfile("feature");
      const testfail = loadScoringProfile("testfail");

      // testfail should have higher testPenaltyMultiplier than others
      expect(testfail.testPenaltyMultiplier).toBeGreaterThan(bugfix.testPenaltyMultiplier);
    });
  });

  describe("coerceProfileName", () => {
    it("should return valid profile names", () => {
      expect(coerceProfileName("default")).toBe("default");
      expect(coerceProfileName("bugfix")).toBe("bugfix");
      expect(coerceProfileName("testfail")).toBe("testfail");
      expect(coerceProfileName("typeerror")).toBe("typeerror");
      expect(coerceProfileName("feature")).toBe("feature");
      expect(coerceProfileName("debug")).toBe("debug");
      expect(coerceProfileName("api")).toBe("api");
      expect(coerceProfileName("editor")).toBe("editor");
    });

    it("should return null for invalid profile names", () => {
      expect(coerceProfileName("invalid")).toBeNull();
      expect(coerceProfileName("")).toBeNull();
      expect(coerceProfileName(null)).toBeNull();
      expect(coerceProfileName(undefined)).toBeNull();
    });

    it("should normalize case", () => {
      expect(coerceProfileName("DEFAULT")).toBe("default");
      expect(coerceProfileName("BugFix")).toBe("bugfix");
    });
  });

  describe("Graph Layer parameters (Phase 3.2)", () => {
    it("should include graph layer parameters in all profiles", () => {
      const profiles: ScoringProfileName[] = [
        "default",
        "bugfix",
        "testfail",
        "typeerror",
        "feature",
        "debug",
        "api",
        "editor",
      ];

      for (const profileName of profiles) {
        const profile = loadScoringProfile(profileName);

        // Graph layer parameters should exist
        expect(typeof profile.graphInbound).toBe("number");
        expect(typeof profile.graphImportance).toBe("number");
        expect(typeof profile.graphDecay).toBe("number");
        expect(typeof profile.graphMaxDepth).toBe("number");
        expect(typeof profile.cochange).toBe("number");

        // Graph layer parameters should be non-negative
        expect(profile.graphInbound).toBeGreaterThanOrEqual(0);
        expect(profile.graphImportance).toBeGreaterThanOrEqual(0);
        expect(profile.graphDecay).toBeGreaterThanOrEqual(0);
        expect(profile.graphMaxDepth).toBeGreaterThanOrEqual(0);
        expect(profile.cochange).toBeGreaterThanOrEqual(0);
      }
    });

    it("should have reasonable default values for graph parameters", () => {
      const profile = loadScoringProfile("default");

      // Default values from scoring-profiles.yml
      expect(profile.graphInbound).toBeCloseTo(0.5, 1);
      expect(profile.graphImportance).toBeCloseTo(0.3, 1);
      expect(profile.graphDecay).toBeCloseTo(0.5, 1);
      expect(profile.graphMaxDepth).toBe(3);
      expect(profile.cochange).toBe(3); // Enabled by default (v0.15.0+)
    });

    it("should allow different graph weights per profile", () => {
      const bugfix = loadScoringProfile("bugfix");
      const editor = loadScoringProfile("editor");

      // bugfix profile should have higher graphInbound for tracing bugs through dependencies
      expect(bugfix.graphInbound).toBeGreaterThanOrEqual(editor.graphInbound);
    });

    it("should have graphMaxDepth as integer", () => {
      const profiles: ScoringProfileName[] = [
        "default",
        "bugfix",
        "testfail",
        "typeerror",
        "feature",
        "debug",
        "api",
        "editor",
      ];

      for (const profileName of profiles) {
        const profile = loadScoringProfile(profileName);
        expect(Number.isInteger(profile.graphMaxDepth)).toBe(true);
        expect(profile.graphMaxDepth).toBeGreaterThanOrEqual(1);
        expect(profile.graphMaxDepth).toBeLessThanOrEqual(10);
      }
    });
  });
});
