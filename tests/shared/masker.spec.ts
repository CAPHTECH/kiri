import { describe, expect, it } from "vitest";

import { maskValue } from "../../src/shared/security/masker.js";

describe("maskValue", () => {
  it("ignores prefix tokens embedded within normal words", () => {
    const input = "lambda/ask-agent/src/handler.ts";
    const result = maskValue(input, { tokens: ["sk-"] });

    expect(result.masked).toBe(input);
    expect(result.applied).toBe(0);
  });

  it("still avoids masking when the prefix is mid-word even if the suffix is long", () => {
    const input = "foomask-1234567890ABCDE";
    const result = maskValue(input, { tokens: ["sk-"] });

    expect(result.masked).toBe(input);
    expect(result.applied).toBe(0);
  });

  it("masks prefix tokens when preceded by a boundary and followed by a long suffix", () => {
    const secret = "sk-1234567890ABCDE";
    const result = maskValue(`API key: ${secret}`, { tokens: ["sk-"] });

    expect(result.masked).toBe("API key: ***");
    expect(result.applied).toBe(1);
  });

  it("respects skipKeys to keep structural fields like path untouched", () => {
    const payload = { path: "sk-1234567890ABCDE" };
    const result = maskValue(payload, { tokens: ["sk-"], skipKeys: ["path"] });

    expect(result.masked).toEqual(payload);
    expect(result.applied).toBe(0);
  });

  it("continues masking literal tokens that do not look like prefixes", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----";
    const result = maskValue(pem, { tokens: ["-----BEGIN"] });

    expect(result.masked).toBe("*** RSA PRIVATE KEY-----");
    expect(result.applied).toBe(1);
  });
});
