import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runIndexer } from "../../src/indexer/cli";
import { ServerContext } from "../../src/server/context";
import { filesSearch, resolveRepoId } from "../../src/server/handlers";
import { DuckDBClient } from "../../src/shared/duckdb";
import { createTempRepo } from "../helpers/test-repo";

interface CleanupTarget {
  dispose: () => Promise<void>;
}

describe("files.search", () => {
  const cleanupTargets: CleanupTarget[] = [];

  afterEach(async () => {
    for (const target of cleanupTargets.splice(0, cleanupTargets.length)) {
      await target.dispose();
    }
  });

  it("returns matches filtered by substring", async () => {
    const repo = await createTempRepo({
      "src/main.ts": "export function meaning() {\n  return 42;\n}\n",
      "docs/readme.md": "The meaning of life is context.\n",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = { db, repoId };

    const results = await filesSearch(context, { query: "meaning" });
    expect(results.length).toBeGreaterThan(0);
    const paths = results.map((item) => item.path);
    expect(paths).toContain("src/main.ts");
    expect(paths).toContain("docs/readme.md");
    expect(results.every((item) => item.preview.toLowerCase().includes("meaning"))).toBe(true);
  });
});
