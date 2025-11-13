import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runIndexer } from "../../src/indexer/cli.js";
import { ServerContext } from "../../src/server/context.js";
import { filesSearch, resolveRepoId } from "../../src/server/handlers.js";
import { WarningManager } from "../../src/server/rpc.js";
import { createServerServices } from "../../src/server/services/index.js";
import { DuckDBClient } from "../../src/shared/duckdb.js";
import { createTempRepo } from "../helpers/test-repo.js";

interface CleanupTarget {
  dispose: () => Promise<void>;
}

describe("files_search", () => {
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
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      warningManager: new WarningManager(),
    };

    const results = await filesSearch(context, { query: "meaning" });
    expect(results.length).toBeGreaterThan(0);
    const paths = results.map((item) => item.path);
    expect(paths).toContain("src/main.ts");
    expect(paths).toContain("docs/readme.md");
    expect(results.every((item) => item.preview !== undefined)).toBe(true);
    expect(results.every((item) => item.preview!.toLowerCase().includes("meaning"))).toBe(true);
  }, 10000);

  it("omits previews when compact mode is requested", async () => {
    const repo = await createTempRepo({
      "src/main.ts": "export const foo = 1;\nexport const bar = foo + 1;\n",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-compact-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      warningManager: new WarningManager(),
    };

    const results = await filesSearch(context, { query: "foo", compact: true });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((item) => item.preview === undefined)).toBe(true);
    expect(results.every((item) => item.matchLine >= 1)).toBe(true);
  });

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
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      warningManager: new WarningManager(),
    };

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
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      warningManager: new WarningManager(),
    };

    // Hyphen-separated query: should split into "MCP" OR "server" OR "handler"
    const results = await filesSearch(context, { query: "MCP-server-handler" });
    expect(results.length).toBeGreaterThan(0);

    const paths = results.map((item) => item.path);
    expect(paths).toContain("src/server.ts"); // contains "MCP", "server", "handler"
    expect(paths).toContain("tests/test.ts"); // contains "MCP", "handler"
  });

  // Critical: boost_profile parameter tests (v0.7.0+)
  describe("boost_profile parameter", () => {
    it("boost_profile='default' prioritizes implementation over docs", async () => {
      const repo = await createTempRepo({
        "src/app/router.ts": `export function route(path: string) {\n  // Handle routing logic\n  return { path, component: "Page" };\n}\n`,
        "README.md": `# Routing Guide\n\nThis explains the routing system and navigation patterns for routes.\n`,
        "docs/routing.md": `# URL Patterns\n\nHow to access canvas pages through routing and routes.\n`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-boost-default-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);
      const context: ServerContext = {
        db,
        repoId,
        services: createServerServices(db),
        warningManager: new WarningManager(),
      };

      const results = await filesSearch(context, {
        query: "route",
        boost_profile: "default",
      });

      expect(results.length).toBeGreaterThan(0);

      // Implementation file should rank highest with default profile
      const routerIndex = results.findIndex((r) => r.path === "src/app/router.ts");
      const readmeIndex = results.findIndex((r) => r.path === "README.md");
      const docsIndex = results.findIndex((r) => r.path === "docs/routing.md");

      // All files should be found
      expect(routerIndex).toBeGreaterThanOrEqual(0);
      expect(readmeIndex).toBeGreaterThanOrEqual(0);
      expect(docsIndex).toBeGreaterThanOrEqual(0);

      // Implementation file should rank higher than documentation files
      expect(routerIndex).toBeLessThan(readmeIndex);
      expect(routerIndex).toBeLessThan(docsIndex);
    });

    it("boost_profile='docs' prioritizes documentation over implementation", async () => {
      const repo = await createTempRepo({
        "src/app/router.ts": `export function route(path: string) {\n  return { path, component: "Page" };\n}\n`,
        "README.md": `# Routing Guide\n\nThis explains the routing system and navigation patterns.\n`,
        "docs/routing.md": `# URL Patterns\n\nHow to access canvas pages through routing.\n`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-boost-docs-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);
      const context: ServerContext = {
        db,
        repoId,
        services: createServerServices(db),
        warningManager: new WarningManager(),
      };

      const results = await filesSearch(context, {
        query: "routing",
        boost_profile: "docs",
      });

      expect(results.length).toBeGreaterThan(0);

      // Documentation files should rank higher with docs profile
      const routerIndex = results.findIndex((r) => r.path === "src/app/router.ts");
      const readmeIndex = results.findIndex((r) => r.path === "README.md");
      const docsIndex = results.findIndex((r) => r.path === "docs/routing.md");

      expect(readmeIndex).toBeGreaterThanOrEqual(0);
      expect(docsIndex).toBeGreaterThanOrEqual(0);

      // At least one doc file should rank higher than implementation
      if (routerIndex >= 0 && readmeIndex >= 0) {
        expect(readmeIndex).toBeLessThan(routerIndex);
      }
      if (routerIndex >= 0 && docsIndex >= 0) {
        expect(docsIndex).toBeLessThan(routerIndex);
      }
    });

    it("boost_profile='none' applies no file type penalties", async () => {
      const repo = await createTempRepo({
        "src/app/router.ts": `export function route(path: string) {\n  return { path, component: "Page" };\n}\n`,
        "README.md": `# Routing Guide\n\nThis explains the routing system and navigation patterns.\n`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-boost-none-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);
      const context: ServerContext = {
        db,
        repoId,
        services: createServerServices(db),
        warningManager: new WarningManager(),
      };

      const resultsNone = await filesSearch(context, {
        query: "routing",
        boost_profile: "none",
      });

      const resultsDefault = await filesSearch(context, {
        query: "routing",
        boost_profile: "default",
      });

      // With 'none', scores should be closer together (no artificial boosting)
      expect(resultsNone.length).toBeGreaterThan(0);
      expect(resultsDefault.length).toBeGreaterThan(0);

      // Both should return results, but ordering may differ
      const pathsNone = resultsNone.map((r) => r.path);
      const pathsDefault = resultsDefault.map((r) => r.path);

      expect(pathsNone.sort()).toEqual(pathsDefault.sort()); // Same files found
    });
  });
});
