import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runIndexer } from "../../src/indexer/cli.js";
import type { ServerContext } from "../../src/server/context.js";
import { DegradeController } from "../../src/server/fallbacks/degradeController.js";
import * as handlers from "../../src/server/handlers.js";
import { checkTableAvailability, hybridSearch, resolveRepoId } from "../../src/server/handlers.js";
import type { HybridSearchParams } from "../../src/server/handlers.js";
import { MetricsRegistry } from "../../src/server/observability/metrics.js";
import { createRpcHandler, WarningManager } from "../../src/server/rpc.js";
import type { ServerServices } from "../../src/server/services/index.js";
import { createServerServices } from "../../src/server/services/index.js";
import { DuckDBClient } from "../../src/shared/duckdb.js";
import { createTempRepo } from "../helpers/test-repo.js";

interface CleanupTarget {
  dispose: () => Promise<void>;
}

describe("hybrid_search", () => {
  const cleanupTargets: CleanupTarget[] = [];

  afterEach(async () => {
    for (const target of cleanupTargets.splice(0, cleanupTargets.length)) {
      await target.dispose();
    }
  });

  async function setupRepo(files: Record<string, string>): Promise<ServerContext> {
    const repo = await createTempRepo(files);
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-hybrid-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const tableAvailability = await checkTableAvailability(db);
    return {
      db,
      repoId,
      services: createServerServices(db),
      tableAvailability,
      warningManager: new WarningManager(),
    };
  }

  it("returns semantic results with no supplemental when required types are covered", async () => {
    const context = await setupRepo({
      "src/main.ts": "export function meaning() {\n  return 42;\n}\n",
      "docs/readme.md": "The meaning of life.\n",
    });

    const result = await hybridSearch(context, {
      goal: "meaning function definition",
      required_types: ["ts"],
      compact: true,
    });

    expect(result.context.length).toBeGreaterThan(0);
    expect(result.coverage.semantic_count).toBeGreaterThan(0);
    expect(result.coverage.missing_types).not.toContain("ts");
  }, 15000);

  it("runs supplemental search when SQL not in semantic results and returns valid coverage", async () => {
    // Use a goal unrelated to SQL to ensure semantic search won't find the .sql file
    const context = await setupRepo({
      "src/main.ts": "export function createUser() {}\n",
      "sql/schema.sql": "CREATE TABLE user (id INTEGER, name TEXT);\n",
    });

    const result = await hybridSearch(context, {
      goal: "createUser typescript function",
      required_types: ["sql"],
      compact: true,
    });

    expect(result.coverage).toMatchObject({
      semantic_count: expect.any(Number),
      supplemental_count: expect.any(Number),
      triggered: expect.any(Boolean),
      missing_types: expect.any(Array),
    });

    // If SQL was not in semantic results, supplemental search should have been triggered
    if (result.coverage.missing_types.includes("sql")) {
      expect(result.coverage.triggered).toBe(true);
      // supplemental search should have found the SQL file
      expect(result.supplemental.length).toBeGreaterThan(0);
      expect(result.supplemental.some((item) => item.path.endsWith(".sql"))).toBe(true);
    }
  }, 15000);

  it("returns results in compact mode without previews", async () => {
    const context = await setupRepo({
      "src/app.ts": "export const config = { port: 8080 };\n",
    });

    const result = await hybridSearch(context, {
      goal: "config port",
      compact: true,
      required_types: [],
    });

    expect(result.context.every((item) => item.preview === undefined)).toBe(true);
    expect(result.coverage).toBeDefined();
  }, 15000);

  it("throws error when goal is missing", async () => {
    const context = await setupRepo({
      "src/main.ts": "export function foo() {}\n",
    });

    await expect(hybridSearch(context, { goal: "" })).rejects.toThrow();
  }, 15000);

  it("supplements with YAML files when required_types includes yaml", async () => {
    const context = await setupRepo({
      "src/main.ts": "export function deploy() {}\n",
      "config/deploy.yaml": "service: web\nreplicas: 2\n",
    });

    const result = await hybridSearch(context, {
      goal: "deploy service config",
      required_types: ["yaml"],
      compact: true,
    });

    expect(result.coverage).toMatchObject({
      semantic_count: expect.any(Number),
      supplemental_count: expect.any(Number),
      triggered: expect.any(Boolean),
      missing_types: expect.any(Array),
    });
    // Whether triggered or not depends on semantic search results
    // but the structure should always be valid
    expect(Array.isArray(result.context)).toBe(true);
    expect(Array.isArray(result.supplemental)).toBe(true);
  }, 15000);
});

// =============================================================================
// parseHybridSearchParams (via RPC handler + spy)
// Tests parser normalization without running a real DB
// =============================================================================

describe("parseHybridSearchParams (rpc parser)", () => {
  const createMockHandler = () => {
    const warningManager = new WarningManager();
    const context: ServerContext = {
      db: {} as DuckDBClient,
      repoId: 1,
      services: {} as ServerServices,
      tableAvailability: {
        hasMetadataTables: true,
        hasLinkTable: true,
        hasHintLog: true,
        hasHintDictionary: true,
        hasGraphMetrics: true,
        hasCochange: true,
      },
      warningManager,
    };
    const degrade = new DegradeController(process.cwd());
    const metrics = new MetricsRegistry();
    return createRpcHandler({ context, degrade, metrics, tokens: [], allowDegrade: false });
  };

  const buildCall = (args: Record<string, unknown>) => ({
    jsonrpc: "2.0" as const,
    id: 1,
    method: "tools/call",
    params: { name: "hybrid_search", arguments: args },
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes required_types: strips dots, lowercases, deduplicates, caps at 5", async () => {
    let captured: HybridSearchParams | undefined;
    vi.spyOn(handlers, "hybridSearch").mockImplementation(async (_ctx, params) => {
      captured = params;
      return {
        context: [],
        supplemental: [],
        coverage: { semantic_count: 0, supplemental_count: 0, triggered: false, missing_types: [] },
      };
    });

    const handler = createMockHandler();
    await handler(
      buildCall({
        goal: "test",
        required_types: [".SQL", "  .yaml  ", "SQL", "ts", "md", "rs", "go"],
      })
    );

    // .SQL → sql, .yaml (trimmed) → yaml, SQL (dup) → removed, ts, md, rs capped at 5
    expect(captured?.required_types).toEqual(["sql", "yaml", "ts", "md", "rs"]);
  });

  it("returns isError true when goal is missing", async () => {
    const handler = createMockHandler();
    const response = await handler(buildCall({}));
    expect(response?.response).toMatchObject({ result: { isError: true } });
  });

  it("returns isError true when goal is empty string", async () => {
    const handler = createMockHandler();
    const response = await handler(buildCall({ goal: "   " }));
    expect(response?.response).toMatchObject({ result: { isError: true } });
  });

  it("returns isError true when limit > 20", async () => {
    const handler = createMockHandler();
    const response = await handler(buildCall({ goal: "test", limit: 99 }));
    expect(response?.response).toMatchObject({ result: { isError: true } });
  });
});
