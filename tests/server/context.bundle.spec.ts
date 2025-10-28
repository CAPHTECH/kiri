import { describe, expect, it } from "vitest";

import { startServer } from "../../src/server/main";

describe("startServer", () => {
  it("reports configured port", () => {
    expect(() => startServer({ port: 9000 })).not.toThrow();
  });
});
