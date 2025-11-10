import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ensureBaseSchema, ensureRepoMetaColumns } from "../../src/indexer/schema.js";
import { DuckDBClient } from "../../src/shared/duckdb.js";
import { filesSearch } from "../../src/server/handlers.js";
import { type ServerContext } from "../../src/server/context.js";
import { WarningManager } from "../../src/server/rpc.js";

describe("FTS status cache invalidation", () => {
  it("degrades immediately when repo becomes dirty after caching", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "kiri-fts-cache-"));
    const dbPath = join(tempDir, "index.duckdb");
    const db = await DuckDBClient.connect({ databasePath: dbPath });
    try {
      await ensureBaseSchema(db);
      await ensureRepoMetaColumns(db);

      await db.run(
        `INSERT INTO repo (id, root, default_branch, fts_dirty, fts_status, fts_last_indexed_at)
         VALUES (1, ?, 'main', false, 'clean', CURRENT_TIMESTAMP)`,
        [tempDir]
      );

      await db.run(`INSERT INTO blob (hash, content) VALUES ('blob-1', 'hello world content');`);
      await db.run(
        `INSERT INTO file (repo_id, path, blob_hash, ext, lang, is_binary, mtime)
         VALUES (1, 'src/hello.ts', 'blob-1', '.ts', 'typescript', FALSE, CURRENT_TIMESTAMP)`
      );

      const warningManager = new WarningManager();
      const context: ServerContext = {
        db,
        repoId: 1,
        features: { fts: true },
        ftsStatusCache: {
          ready: true,
          schemaExists: true,
          anyDirty: false,
          lastChecked: Date.now(),
        },
        warningManager,
      };

      await db.run(`UPDATE repo SET fts_dirty = true, fts_status = 'rebuilding' WHERE id = 1`);

      const results = await filesSearch(context, { query: "hello" });

      expect(results.length).toBeGreaterThan(0);
      expect(context.features?.fts).toBe(false);
      expect(context.ftsStatusCache?.ready).toBe(false);
    } finally {
      await db.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
