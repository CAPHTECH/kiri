import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { startServer } from "../../src/server/main.js";

describe("startServer", () => {
  it("fails fast when repository index is missing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "kiri-server-"));
    const dbPath = join(tempDir, "index.duckdb");

    await expect(startServer({ port: 0, repoRoot: tempDir, databasePath: dbPath })).rejects.toThrow(
      /Target repository is missing/
    );

    await rm(tempDir, { recursive: true, force: true });
  });
});
