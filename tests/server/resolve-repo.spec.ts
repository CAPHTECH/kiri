import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ensureBaseSchema } from "../../src/indexer/schema.js";
import { resolveRepoId } from "../../src/server/handlers.js";
import { DuckDBClient } from "../../src/shared/duckdb.js";
import { createTempRepo } from "../helpers/test-repo.js";

describe("resolveRepoId legacy compatibility", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const dispose = cleanup.pop();
      if (dispose) {
        await dispose();
      }
    }
  });

  async function setupLegacyRepo() {
    const repo = await createTempRepo({
      "src/lib.ts": "export const version = '1.0.0';\n",
    });
    cleanup.push(repo.cleanup);

    const aliasDir = await mkdtemp(join(tmpdir(), "kiri-resolve-alias-"));
    const aliasPath = join(aliasDir, "worktree");
    await symlink(repo.path, aliasPath);
    cleanup.push(async () => {
      await rm(aliasDir, { recursive: true, force: true });
    });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-resolve-db-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanup.push(async () => {
      await rm(dbDir, { recursive: true, force: true });
    });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    await ensureBaseSchema(db);
    await db.run("INSERT INTO repo (id, root, default_branch) VALUES (7, ?, 'main')", [aliasPath]);
    await db.close();

    return { repo, aliasPath, dbPath };
  }

  it("updates repo rows when called with alias path", async () => {
    const { repo, aliasPath, dbPath } = await setupLegacyRepo();
    const db = await DuckDBClient.connect({ databasePath: dbPath });

    const repoId = await resolveRepoId(db, aliasPath);
    expect(repoId).toBe(7);

    const rows = await db.all<{ root: string }>("SELECT root FROM repo WHERE id = 7");
    expect(rows[0]?.root).toBe(repo.path);

    await db.close();
  });

  it("recovers legacy rows when only the normalized path is provided", async () => {
    const { repo, dbPath } = await setupLegacyRepo();
    const db = await DuckDBClient.connect({ databasePath: dbPath });

    const repoId = await resolveRepoId(db, repo.path);
    expect(repoId).toBe(7);

    const rows = await db.all<{ root: string }>("SELECT root FROM repo WHERE id = 7");
    expect(rows[0]?.root).toBe(repo.path);

    await db.close();
  });
});
