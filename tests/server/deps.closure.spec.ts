import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runIndexer } from "../../src/indexer/cli.js";
import { ServerContext } from "../../src/server/context.js";
import { depsClosure, resolveRepoId } from "../../src/server/handlers.js";
import { DuckDBClient } from "../../src/shared/duckdb.js";
import { createTempRepo } from "../helpers/test-repo.js";

interface CleanupTarget {
  dispose: () => Promise<void>;
}

describe("deps.closure", () => {
  const cleanupTargets: CleanupTarget[] = [];

  afterEach(async () => {
    for (const target of cleanupTargets.splice(0, cleanupTargets.length)) {
      await target.dispose();
    }
  });

  it("returns outbound dependency closure", async () => {
    const repo = await createTempRepo({
      "src/a.ts": [
        "import { b } from './b.js';",
        "",
        "export function a() {",
        "  return b();",
        "}",
      ].join("\n"),
      "src/b.ts": [
        "import { c } from './c.js';",
        "",
        "export function b() {",
        "  return c();",
        "}",
      ].join("\n"),
      "src/c.ts": ["export function c() {", "  return 'c';", "}"].join("\n"),
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

    const closure = await depsClosure(context, { path: "src/a.ts", max_depth: 5 });
    expect(closure.root).toBe("src/a.ts");
    expect(closure.direction).toBe("outbound");
    const nodes = closure.nodes.map((node) => `${node.kind}:${node.target}`);
    expect(nodes).toEqual(["path:src/a.ts", "path:src/b.ts", "path:src/c.ts"]);
    const edges = closure.edges.map((edge) => `${edge.from}->${edge.to}:${edge.kind}`);
    expect(edges).toEqual(["src/a.ts->src/b.ts:path", "src/b.ts->src/c.ts:path"]);
  });
});
