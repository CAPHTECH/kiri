import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveSecurityConfigPath } from "../../../src/shared/security/config.js";

describe("resolveSecurityConfigPath", () => {
  it("falls back to repo config when the compiled path is missing", () => {
    const calls: string[] = [];
    const resolved = resolveSecurityConfigPath(undefined, (candidate) => {
      calls.push(candidate);
      if (calls.length === 1) {
        return false;
      }
      return true;
    });

    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(resolved).toBe(resolve("config/security.yml"));
  });
});
