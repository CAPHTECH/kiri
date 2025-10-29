import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import packageJson from "../../package.json" with { type: "json" };
import { runIndexer } from "../../src/indexer/cli.js";
import {
  createRpcHandler,
  type JsonRpcRequest,
  type JsonRpcSuccess,
} from "../../src/server/rpc.js";
import { createServerRuntime } from "../../src/server/runtime.js";
import { createTempRepo } from "../helpers/test-repo.js";

interface CleanupTarget {
  dispose: () => Promise<void>;
}

describe("MCP標準エンドポイント", () => {
  const cleanupTargets: CleanupTarget[] = [];

  afterEach(async () => {
    for (const target of cleanupTargets.splice(0, cleanupTargets.length)) {
      await target.dispose();
    }
  });

  it("initialize がサーバー情報とプロトコルを返す", async () => {
    const repo = await createTempRepo({
      "README.md": "# Sample\n\nRepository for MCP initialize test.\n",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-mcp-"));
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    const dbPath = join(dbDir, "index.duckdb");
    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const runtime = await createServerRuntime({ repoRoot: repo.path, databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await runtime.close() });

    const handler = createRpcHandler(runtime);
    const request: JsonRpcRequest = { jsonrpc: "2.0", id: 1, method: "initialize" };
    const response = await handler(request);

    expect(response.statusCode).toBe(200);
    const payload = response.response as JsonRpcSuccess;
    expect(payload.result).toHaveProperty("protocolVersion", "2024-11-05");
    const serverInfo = (payload.result as Record<string, unknown>).serverInfo as Record<
      string,
      unknown
    >;
    expect(serverInfo?.name).toBe("kiri");
    expect(serverInfo?.version).toBe(packageJson.version);
  });

  it("tools/list が利用可能ツールを列挙する", async () => {
    const repo = await createTempRepo({
      "src/app.ts": "export const app = () => 1;\n",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-mcp-tools-"));
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    const dbPath = join(dbDir, "index.duckdb");
    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const runtime = await createServerRuntime({ repoRoot: repo.path, databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await runtime.close() });

    const handler = createRpcHandler(runtime);
    const request: JsonRpcRequest = { jsonrpc: "2.0", id: 2, method: "tools/list" };
    const response = await handler(request);

    expect(response.statusCode).toBe(200);
    const payload = response.response as JsonRpcSuccess;
    const tools = (payload.result as Record<string, unknown>).tools as unknown[];
    expect(Array.isArray(tools)).toBe(true);
    const toolNames = tools
      .map((tool) =>
        tool && typeof tool === "object" ? (tool as Record<string, unknown>).name : null
      )
      .filter((name): name is string => typeof name === "string");
    expect(toolNames).toContain("context.bundle");
    expect(toolNames).toContain("files.search");
  });
});
