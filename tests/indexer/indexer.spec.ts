import { describe, expect, it } from "vitest";

import { runIndexer } from "../../src/indexer/cli";

describe("runIndexer", () => {
  it("logs invocation parameters", async () => {
    await expect(runIndexer({ repoRoot: ".", databasePath: "var/index.duckdb", full: true })).resolves.toBeUndefined();
  });
});
