import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runIndexer } from "../../src/indexer/cli.js";
import { ServerContext } from "../../src/server/context.js";
import { checkTableAvailability, filesSearch, resolveRepoId } from "../../src/server/handlers.js";
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
    const tableAvailability = await checkTableAvailability(db);
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      tableAvailability,
      warningManager: new WarningManager(),
    };

    // v1.0.0: Use "balanced" profile to include both docs/ and src/ files equally
    const results = await filesSearch(context, { query: "meaning", boost_profile: "balanced" });
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
    const tableAvailability = await checkTableAvailability(db);
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      tableAvailability,
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
    const tableAvailability = await checkTableAvailability(db);
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      tableAvailability,
      warningManager: new WarningManager(),
    };

    // Multi-word query: should split into "tools" OR "call" OR "implementation"
    // v1.0.0: Use "balanced" profile to include both docs/ and src/ files equally
    const results = await filesSearch(context, {
      query: "tools/call implementation",
      boost_profile: "balanced",
    });
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
    const tableAvailability = await checkTableAvailability(db);
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      tableAvailability,
      warningManager: new WarningManager(),
    };

    // Hyphen-separated query: should split into "MCP" OR "server" OR "handler"
    // v1.0.0: testPenaltyMultiplier (0.02) may filter tests/test.ts, use higher boost for test files
    // Actually, let's use boost_profile="testfail" which has testPenaltyMultiplier: 0.2 (less severe)
    const results = await filesSearch(context, {
      query: "MCP-server-handler",
      boost_profile: "testfail",
    });
    expect(results.length).toBeGreaterThan(0);

    const paths = results.map((item) => item.path);
    expect(paths).toContain("src/server.ts"); // contains "MCP", "server", "handler"
    expect(paths).toContain("tests/test.ts"); // contains "MCP", "handler"
  });

  it("supports metadata-driven filtering", async () => {
    const repo = await createTempRepo({
      "docs/runbook.md":
        "---\ntitle: Observability Runbook\ntags:\n  - observability\ncategory: guides\n---\nDashboards reference.\n",
      "docs/faq.md":
        "---\ntitle: FAQ\ntags:\n  - payments\ncategory: guides\n---\nDashboards reference.\n",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-metadata-search-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const tableAvailability = await checkTableAvailability(db);
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      tableAvailability,
      warningManager: new WarningManager(),
    };

    const filtered = await filesSearch(context, {
      query: "dashboards",
      metadata_filters: { "docmeta.tags": "observability" },
    });
    expect(filtered.map((item) => item.path)).toEqual(["docs/runbook.md"]);

    const inline = await filesSearch(context, {
      query: "docmeta.tags:payments dashboards",
    });
    expect(inline.map((item) => item.path)).toEqual(["docs/faq.md"]);

    const metadataOnly = await filesSearch(context, {
      query: "",
      metadata_filters: { "docmeta.tags": "observability" },
    });
    expect(metadataOnly.map((item) => item.path)).toEqual(["docs/runbook.md"]);
  });

  it("surfaces docs and code for meta.* hints and restricts docmeta.* filters", async () => {
    const repo = await createTempRepo({
      "docs/runbook.md":
        "---\nid: runbook-002\ntitle: Deployment Runbook\n---\nFollow the steps for runbook-002.\n",
      "src/deploy/runbook.ts": `export const RUNBOOK_ID = "runbook-002";\n`,
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-files-meta-mode-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const tableAvailability = await checkTableAvailability(db);
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      tableAvailability,
      warningManager: new WarningManager(),
    };

    const hintResults = await filesSearch(context, { query: "meta.id:runbook-002" });
    const hintPaths = hintResults.map((item) => item.path);
    expect(hintPaths).toContain("docs/runbook.md");
    expect(hintPaths).toContain("src/deploy/runbook.ts");

    const strictResults = await filesSearch(context, { query: "docmeta.id:runbook-002" });
    expect(strictResults.map((item) => item.path)).toEqual(["docs/runbook.md"]);
  });

  it("returns matches when keywords exist only in metadata", async () => {
    const repo = await createTempRepo({
      "docs/runbook.md": "---\ntags: [observability]\n---\nRefer to dashboards.\n",
      "docs/infra.md": "# Infra\\nRefer to dashboards.\\n",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-metadata-keyword-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const tableAvailability = await checkTableAvailability(db);
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      tableAvailability,
      warningManager: new WarningManager(),
    };

    // v1.0.0: Use "balanced" profile to include docs/ files
    const results = await filesSearch(context, {
      query: "observability",
      boost_profile: "balanced",
    });
    expect(results.map((item) => item.path)).toContain("docs/runbook.md");
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
      const tableAvailability = await checkTableAvailability(db);
      const context: ServerContext = {
        db,
        repoId,
        services: createServerServices(db),
        tableAvailability,
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

      // v1.0.0: Implementation file should always be found
      expect(routerIndex).toBeGreaterThanOrEqual(0);

      // v1.0.0: README.md may have low score (docPenaltyMultiplier: 0.5) but should be included
      // docs/routing.md may be filtered out (blacklistPenaltyMultiplier: 0.01 = 99% reduction)
      // If README is found, it should rank lower than implementation
      if (readmeIndex >= 0) {
        expect(routerIndex).toBeLessThan(readmeIndex);
      }

      // docs/ directory files are heavily penalized and may be filtered out
      // If docs/routing.md is found, it should rank lower than implementation
      if (docsIndex >= 0) {
        expect(routerIndex).toBeLessThan(docsIndex);
      }
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
      const tableAvailability = await checkTableAvailability(db);
      const context: ServerContext = {
        db,
        repoId,
        services: createServerServices(db),
        tableAvailability,
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
      const tableAvailability = await checkTableAvailability(db);
      const context: ServerContext = {
        db,
        repoId,
        services: createServerServices(db),
        tableAvailability,
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

  describe("metadata filtering edge cases", () => {
    it("handles empty metadata_filters object gracefully", async () => {
      const repo = await createTempRepo({
        "docs/guide.md": `---
title: Guide
tags:
  - tutorial
---
# Guide content
`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-empty-filters-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);
      const tableAvailability = await checkTableAvailability(db);
      const context: ServerContext = {
        db,
        repoId,
        services: createServerServices(db),
        tableAvailability,
        warningManager: new WarningManager(),
      };

      // Empty metadata_filters should not cause errors
      const results = await filesSearch(context, {
        query: "Guide",
        metadata_filters: {},
        boost_profile: "docs",
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.path === "docs/guide.md")).toBe(true);
    });

    it("supports array values in metadata_filters", async () => {
      const repo = await createTempRepo({
        "docs/a.md": `---
tags:
  - alpha
---
# Doc A
`,
        "docs/b.md": `---
tags:
  - beta
---
# Doc B
`,
        "docs/c.md": `---
tags:
  - gamma
---
# Doc C
`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-array-filters-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);
      const tableAvailability = await checkTableAvailability(db);
      const context: ServerContext = {
        db,
        repoId,
        services: createServerServices(db),
        tableAvailability,
        warningManager: new WarningManager(),
      };

      // Filter with array of values - should match any
      const results = await filesSearch(context, {
        query: "Doc",
        metadata_filters: { "docmeta.tags": ["alpha", "beta"] },
      });

      const paths = results.map((r) => r.path);
      expect(paths).toContain("docs/a.md");
      expect(paths).toContain("docs/b.md");
      // gamma should not be included in strict filter results
    });

    it("handles numeric metadata values", async () => {
      const repo = await createTempRepo({
        "config/app.yaml": `version: 2
priority: 100
enabled: true
`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-numeric-meta-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);

      // Check that numeric values are stored
      const kvRows = await db.all<{ key: string; value: string }>(
        "SELECT key, value FROM document_metadata_kv WHERE repo_id = ?",
        [repoId]
      );

      // Numeric values should be stored as strings
      const versionEntry = kvRows.find((r) => r.key === "version");
      expect(versionEntry?.value).toBe("2");

      const priorityEntry = kvRows.find((r) => r.key === "priority");
      expect(priorityEntry?.value).toBe("100");
    });

    it("handles boolean metadata values", async () => {
      const repo = await createTempRepo({
        "config/flags.yaml": `enabled: true
debug: false
`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-bool-meta-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);

      // Check that boolean values are stored as strings
      const kvRows = await db.all<{ key: string; value: string }>(
        "SELECT key, value FROM document_metadata_kv WHERE repo_id = ?",
        [repoId]
      );

      const enabledEntry = kvRows.find((r) => r.key === "enabled");
      expect(enabledEntry?.value).toBe("true");

      const debugEntry = kvRows.find((r) => r.key === "debug");
      expect(debugEntry?.value).toBe("false");
    });

    it("combines metadata filter with path_prefix", async () => {
      const repo = await createTempRepo({
        "docs/api/guide.md": `---
category: api
---
# API Guide
`,
        "docs/user/guide.md": `---
category: user
---
# User Guide
`,
        "src/guide.md": `---
category: dev
---
# Dev Guide
`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-path-meta-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);
      const tableAvailability = await checkTableAvailability(db);
      const context: ServerContext = {
        db,
        repoId,
        services: createServerServices(db),
        tableAvailability,
        warningManager: new WarningManager(),
      };

      // Combine path_prefix with metadata filter
      const results = await filesSearch(context, {
        query: "Guide",
        path_prefix: "docs/",
        metadata_filters: { "docmeta.category": "api" },
      });

      // Should only return docs/api/guide.md (matching both path and metadata)
      expect(results.length).toBe(1);
      expect(results[0]!.path).toBe("docs/api/guide.md");
    });

    it("normalizes path_prefix with leading slashes", async () => {
      const repo = await createTempRepo({
        "src/server/handler.ts": "export function handler() {}",
        "src/client/app.ts": "const app = {};",
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-path-leading-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);
      const tableAvailability = await checkTableAvailability(db);

      const context: ServerContext = {
        db,
        repoId,
        services: createServerServices(db),
        tableAvailability,
        warningManager: new WarningManager(),
      };

      // path_prefix with leading slash should be normalized
      const results = await filesSearch(context, {
        query: "handler",
        path_prefix: "/src/server/",
      });

      expect(results.length).toBe(1);
      expect(results[0]!.path).toBe("src/server/handler.ts");
    });

    it("normalizes path_prefix with backslashes", async () => {
      const repo = await createTempRepo({
        "src/server/handler.ts": "export function handler() {}",
        "src/client/app.ts": "const app = {};",
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-path-backslash-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);
      const tableAvailability = await checkTableAvailability(db);

      const context: ServerContext = {
        db,
        repoId,
        services: createServerServices(db),
        tableAvailability,
        warningManager: new WarningManager(),
      };

      // path_prefix with backslashes should be normalized
      const results = await filesSearch(context, {
        query: "handler",
        path_prefix: "src\\server\\",
      });

      expect(results.length).toBe(1);
      expect(results[0]!.path).toBe("src/server/handler.ts");
    });

    it("normalizes path_prefix starting with ./", async () => {
      const repo = await createTempRepo({
        "src/server/handler.ts": "export function handler() {}",
        "src/client/app.ts": "const app = {};",
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-path-dotslash-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);
      const tableAvailability = await checkTableAvailability(db);

      const context: ServerContext = {
        db,
        repoId,
        services: createServerServices(db),
        tableAvailability,
        warningManager: new WarningManager(),
      };

      // path_prefix starting with ./ should be normalized
      const results = await filesSearch(context, {
        query: "handler",
        path_prefix: "./src/server/",
      });

      expect(results.length).toBe(1);
      expect(results[0]!.path).toBe("src/server/handler.ts");
    });

    it("handles path_prefix that normalizes to empty string", async () => {
      const repo = await createTempRepo({
        "src/server/handler.ts": "export function handler() {}",
        "src/client/app.ts": "const app = {};",
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-path-root-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);
      const tableAvailability = await checkTableAvailability(db);

      const context: ServerContext = {
        db,
        repoId,
        services: createServerServices(db),
        tableAvailability,
        warningManager: new WarningManager(),
      };

      // path_prefix "/" normalizes to empty, so no path filter is applied
      const results = await filesSearch(context, {
        query: "handler",
        path_prefix: "/",
      });

      // Should find handler in both files (no path filter)
      expect(results.length).toBe(1);
      expect(results[0]!.path).toBe("src/server/handler.ts");
    });
  });
});
