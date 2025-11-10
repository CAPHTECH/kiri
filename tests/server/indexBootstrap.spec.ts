import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ensureDatabaseIndexed } from "../../src/server/indexBootstrap.js";
import { createTempRepo } from "../helpers/test-repo.js";

async function createTempDbPath(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "kiri-bootstrap-db-"));
  const dbPath = join(dir, "index.duckdb");
  return {
    path: dbPath,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe("ensureDatabaseIndexed", () => {
  it("indexes a missing database and releases the lock for subsequent runs", async () => {
    const repo = await createTempRepo({
      "src/index.ts": "console.log('bootstrap test');\n",
    });
    const db = await createTempDbPath();

    try {
      const firstRun = await ensureDatabaseIndexed(repo.path, db.path, false, true);
      expect(firstRun).toBe(true);

      // Second run should detect the existing DB and skip reindex without hitting lock errors
      const secondRun = await ensureDatabaseIndexed(repo.path, db.path, false, false);
      expect(secondRun).toBe(true);
    } finally {
      await repo.cleanup();
      await db.cleanup();
    }
  });
});
