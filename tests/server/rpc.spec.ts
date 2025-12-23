import { describe, it, expect, vi, afterEach } from "vitest";

import type { ServerContext } from "../../src/server/context.js";
import { DegradeController } from "../../src/server/fallbacks/degradeController.js";
import * as handlers from "../../src/server/handlers.js";
import type { ContextBundleParams } from "../../src/server/handlers.js";
import { MetricsRegistry } from "../../src/server/observability/metrics.js";
import {
  createRpcHandler,
  type JsonRpcRequest,
  type JsonRpcSuccess,
  WarningManager,
} from "../../src/server/rpc.js";
import type { ServerServices } from "../../src/server/services/index.js";
import type { DuckDBClient } from "../../src/shared/duckdb.js";

const createHandler = () => {
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

  return createRpcHandler({
    context,
    degrade,
    metrics,
    tokens: [],
    allowDegrade: false,
  });
};

const setupContextBundleSpy = () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let capturedParams: ContextBundleParams | undefined;
  vi.spyOn(handlers, "contextBundle").mockImplementation(async (_ctx, params) => {
    capturedParams = params;
    return {
      context: [],
      tokens_estimate: 0,
      warnings: [..._ctx.warningManager.responseWarnings],
    };
  });
  return { handler: createHandler(), getCaptured: () => capturedParams };
};

describe("parseContextBundleParams category", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const buildRequest = (category: unknown): JsonRpcRequest => ({
    jsonrpc: "2.0",
    id: 1,
    method: "context_bundle",
    params: {
      goal: "goal",
      category,
    },
  });

  it("有効な文字列 category をパースしてハンドラーに渡す", async () => {
    const { handler, getCaptured } = setupContextBundleSpy();

    const response = await handler(buildRequest("bugfix"));

    expect(getCaptured()?.category).toBe("bugfix");
    expect(response?.statusCode).toBe(200);
  });

  it("前後に空白がある category をトリムして受理する", async () => {
    const { handler, getCaptured } = setupContextBundleSpy();

    await handler(buildRequest("  feature  "));

    expect(getCaptured()?.category).toBe("feature");
  });

  it("エイリアス category(editor) を正規カテゴリにマップする", async () => {
    const { handler, getCaptured } = setupContextBundleSpy();

    await handler(buildRequest("editor"));

    expect(getCaptured()?.category).toBe("feature");
  });

  it("空文字の category は無視する", async () => {
    const { handler, getCaptured } = setupContextBundleSpy();

    await handler(buildRequest(""));

    expect(getCaptured()?.category).toBeUndefined();
  });

  it("非文字列の category は無視する", async () => {
    const { handler, getCaptured } = setupContextBundleSpy();

    await handler(buildRequest(123));

    expect(getCaptured()?.category).toBeUndefined();
  });

  it("無効な category は警告を付けて無視する", async () => {
    const { handler, getCaptured } = setupContextBundleSpy();

    const response = await handler(buildRequest("unknown"));

    expect(getCaptured()?.category).toBeUndefined();
    const payload = response?.response as JsonRpcSuccess | undefined;
    const result = payload?.result as Record<string, unknown> | undefined;
    const warnings = (result?.warnings as string[] | undefined) ?? [];
    expect(warnings.some((w) => w.includes('category "unknown" is not supported'))).toBe(true);
  });
});

describe("tools/list schema", () => {
  it("context_bundle の inputSchema に category が含まれる", async () => {
    const handler = createHandler();
    const response = await handler({ jsonrpc: "2.0", id: 99, method: "tools/list" });

    expect(response?.statusCode).toBe(200);
    const payload = response?.response as JsonRpcSuccess | undefined;
    const tools = (payload?.result as Record<string, unknown>)?.tools as unknown[];
    expect(Array.isArray(tools)).toBe(true);

    const contextBundle = tools.find(
      (tool) =>
        tool &&
        typeof tool === "object" &&
        (tool as Record<string, unknown>).name === "context_bundle"
    ) as Record<string, unknown> | undefined;

    expect(contextBundle).toBeDefined();
    const properties = (contextBundle?.inputSchema as Record<string, unknown>)?.properties as
      | Record<string, unknown>
      | undefined;
    expect(properties).toBeDefined();
    expect(properties).toHaveProperty("category");

    const category = properties?.category as Record<string, unknown> | undefined;
    expect(category?.type).toBe("string");
    expect(String(category?.description ?? "")).toContain("adaptive K");
  });
});
