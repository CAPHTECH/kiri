import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runIndexer } from "../../src/indexer/cli.js";
import { ensureBaseSchema } from "../../src/indexer/schema.js";
import { clearAllQueues } from "../../src/indexer/queue.js";
import { DuckDBClient } from "../../src/shared/duckdb.js";
import { createTempRepo } from "../helpers/test-repo.js";

describe("repo path normalization", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await cleanup.pop()!();
    }
    clearAllQueues();
  });

  it("reuses legacy repo rows created with symlinked paths", async () => {
    const repo = await createTempRepo({
      "src/app.ts": "export const answer = 42;\n",
    });
    cleanup.push(repo.cleanup);

    const aliasDir = await mkdtemp(join(tmpdir(), "kiri-alias-"));
    const aliasPath = join(aliasDir, "link");
    await symlink(repo.path, aliasPath);
    cleanup.push(async () => {
      await rm(aliasDir, { recursive: true, force: true });
    });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-path-db-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanup.push(async () => {
      await rm(dbDir, { recursive: true, force: true });
    });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    await ensureBaseSchema(db);
    await db.run("INSERT INTO repo (id, root, default_branch) VALUES (1, ?, 'main')", [aliasPath]);
    await db.close();

    await runIndexer({ repoRoot: aliasPath, databasePath: dbPath, full: true });

    const verifyDb = await DuckDBClient.connect({ databasePath: dbPath });
    const repoRows = await verifyDb.all<{ id: number; root: string }>("SELECT id, root FROM repo");

    expect(repoRows).toHaveLength(1);
    expect(repoRows[0]?.id).toBe(1);
    expect(repoRows[0]?.root).toBe(repo.path);
    await verifyDb.close();
  });
});
