import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runIndexer } from "../../src/indexer/cli";
import { DuckDBClient } from "../../src/shared/duckdb";
import { createTempRepo } from "../helpers/test-repo";

interface CleanupTarget {
  dispose: () => Promise<void>;
}

describe("runIndexer", () => {
  const cleanupTargets: CleanupTarget[] = [];

  afterEach(async () => {
    for (const target of cleanupTargets.splice(0, cleanupTargets.length)) {
      await target.dispose();
    }
  });

  it("indexes tracked files into DuckDB", async () => {
    const repo = await createTempRepo({
      "src/main.ts": "export const answer = 42;\n",
      "README.md": "# Sample\n\nThis is a repo.\n",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({
      dispose: async () => await rm(dbDir, { recursive: true, force: true }),
    });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoRows = await db.all<{ id: number; root: string }>("SELECT id, root FROM repo");
    expect(repoRows).toHaveLength(1);
    const repoId = repoRows[0].id;
    expect(repoRows[0].root).toBe(repo.path);

    const fileRows = await db.all<{ path: string; is_binary: boolean }>(
      "SELECT path, is_binary FROM file WHERE repo_id = ? ORDER BY path",
      [repoId]
    );
    expect(fileRows).toHaveLength(2);
    expect(fileRows.map((row) => row.path)).toEqual(["README.md", "src/main.ts"]);
    expect(fileRows.every((row) => row.is_binary === false)).toBe(true);

    const blobRows = await db.all<{ hash: string; content: string | null }>(
      "SELECT hash, content FROM blob ORDER BY hash"
    );
    expect(blobRows.length).toBeGreaterThanOrEqual(2);
    expect(blobRows.every((row) => row.content !== null)).toBe(true);
  });
});
