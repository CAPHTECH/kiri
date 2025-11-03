import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runIndexer } from "../../src/indexer/cli.js";
import { ServerContext } from "../../src/server/context.js";
import { filesSearch, resolveRepoId } from "../../src/server/handlers.js";
import { DuckDBClient } from "../../src/shared/duckdb.js";
import { createTempRepo } from "../helpers/test-repo.js";

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
  }, 10000);

  it("returns matches for multi-word queries with OR logic", async () => {
    const repo = await createTempRepo({
      "src/rpc.ts":
        "export function createRpcHandler() {\n  return tools/call implementation;\n}\n",
      "src/handlers.ts": "export function filesSearch() {\n  const implementation = 'query';\n}\n",
      "docs/api.md": "The tools system uses call methods for implementation.\n",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-multi-word-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = { db, repoId };

    // Multi-word query: should split into "tools" OR "call" OR "implementation"
    const results = await filesSearch(context, { query: "tools/call implementation" });
    expect(results.length).toBeGreaterThan(0);

    // All three files should match (each contains at least one of the words)
    const paths = results.map((item) => item.path);
    expect(paths).toContain("src/rpc.ts"); // contains "tools", "call", "implementation"
    expect(paths).toContain("src/handlers.ts"); // contains "implementation"
    expect(paths).toContain("docs/api.md"); // contains "tools", "call", "implementation"
  });

  it("handles hyphen-separated queries", async () => {
    const repo = await createTempRepo({
      "src/server.ts": "// MCP server implementation\nconst handler = createRpcHandler();\n",
      "tests/test.ts": "// Test for MCP protocol\nconst result = await handler();\n",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-hyphen-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = { db, repoId };

    // Hyphen-separated query: should split into "MCP" OR "server" OR "handler"
    const results = await filesSearch(context, { query: "MCP-server-handler" });
    expect(results.length).toBeGreaterThan(0);

    const paths = results.map((item) => item.path);
    expect(paths).toContain("src/server.ts"); // contains "MCP", "server", "handler"
    expect(paths).toContain("tests/test.ts"); // contains "MCP", "handler"
  });
});
