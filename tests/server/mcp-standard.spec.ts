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
  type RpcHandleResult,
} from "../../src/server/rpc.js";
import { createServerRuntime } from "../../src/server/runtime.js";
import { loadSecurityConfig, updateSecurityLock } from "../../src/shared/security/config.js";
import { createTempRepo } from "../helpers/test-repo.js";

const ensureResponse = (result: RpcHandleResult | null): RpcHandleResult => {
  if (result === null) {
    throw new Error("Expected RPC handler to return a response");
  }
  return result;
};

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
    const lockPath = join(dbDir, "security.lock");
    const { hash } = loadSecurityConfig();
    updateSecurityLock(hash, lockPath);

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const runtime = await createServerRuntime({
      repoRoot: repo.path,
      databasePath: dbPath,
      securityLockPath: lockPath,
    });
    cleanupTargets.push({ dispose: async () => await runtime.close() });

    const handler = createRpcHandler(runtime);
    const request: JsonRpcRequest = { jsonrpc: "2.0", id: 1, method: "initialize" };
    const response = ensureResponse(await handler(request));

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
    const lockPath = join(dbDir, "security.lock");
    const { hash } = loadSecurityConfig();
    updateSecurityLock(hash, lockPath);

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const runtime = await createServerRuntime({
      repoRoot: repo.path,
      databasePath: dbPath,
      securityLockPath: lockPath,
    });
    cleanupTargets.push({ dispose: async () => await runtime.close() });

    const handler = createRpcHandler(runtime);
    const request: JsonRpcRequest = { jsonrpc: "2.0", id: 2, method: "tools/list" };
    const response = ensureResponse(await handler(request));

    expect(response.statusCode).toBe(200);
    const payload = response.response as JsonRpcSuccess;
    const tools = (payload.result as Record<string, unknown>).tools as unknown[];
    expect(Array.isArray(tools)).toBe(true);
    const toolNames = tools
      .map((tool) =>
        tool && typeof tool === "object" ? (tool as Record<string, unknown>).name : null
      )
      .filter((name): name is string => typeof name === "string");
    expect(toolNames).toContain("context_bundle");
    expect(toolNames).toContain("files_search");
  });

  it("resources/list が空配列を返しクライアント互換性を保つ", async () => {
    const repo = await createTempRepo({
      "src/app.ts": "export const app = () => 1;\n",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-mcp-resources-"));
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    const dbPath = join(dbDir, "index.duckdb");
    const lockPath = join(dbDir, "security.lock");
    const { hash } = loadSecurityConfig();
    updateSecurityLock(hash, lockPath);

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const runtime = await createServerRuntime({
      repoRoot: repo.path,
      databasePath: dbPath,
      securityLockPath: lockPath,
    });
    cleanupTargets.push({ dispose: async () => await runtime.close() });

    const handler = createRpcHandler(runtime);
    const request: JsonRpcRequest = { jsonrpc: "2.0", id: 3, method: "resources/list" };
    const response = ensureResponse(await handler(request));

    expect(response.statusCode).toBe(200);
    const payload = response.response as JsonRpcSuccess;
    const resources = (payload.result as Record<string, unknown>).resources as unknown[];
    expect(Array.isArray(resources)).toBe(true);
    expect(resources.length).toBe(0);
  });

  it("tools/call が files.search を実行して MCP 標準形式で結果を返す", async () => {
    const repo = await createTempRepo({
      "src/main.ts": "export function meaning() {\n  return 42;\n}\n",
      "docs/readme.md": "The meaning of life is context.\n",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-mcp-call-"));
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    const dbPath = join(dbDir, "index.duckdb");
    const lockPath = join(dbDir, "security.lock");
    const { hash } = loadSecurityConfig();
    updateSecurityLock(hash, lockPath);

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const runtime = await createServerRuntime({
      repoRoot: repo.path,
      databasePath: dbPath,
      securityLockPath: lockPath,
    });
    cleanupTargets.push({ dispose: async () => await runtime.close() });

    const handler = createRpcHandler(runtime);
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "files_search",
        arguments: {
          query: "meaning",
        },
      },
    };
    const response = ensureResponse(await handler(request));

    expect(response.statusCode).toBe(200);
    const payload = response.response as JsonRpcSuccess;
    const result = payload.result as Record<string, unknown>;

    // MCP standard format validation
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("isError");
    expect(result.isError).toBe(false);

    const content = result.content as Array<{ type: string; text: string }>;
    expect(Array.isArray(content)).toBe(true);
    expect(content.length).toBeGreaterThan(0);
    expect(content[0]).toHaveProperty("type", "text");
    expect(content[0]).toHaveProperty("text");

    // Parse the JSON result and verify it contains search results
    const firstContent = content[0];
    if (!firstContent) throw new Error("Content array is empty");
    const searchResults = JSON.parse(firstContent.text);
    expect(Array.isArray(searchResults)).toBe(true);
    expect(searchResults.length).toBeGreaterThan(0);
  });

  it("degrade モードでも files.search が配列形式で結果を返す", async () => {
    const repo = await createTempRepo({
      "src/degrade.ts": "export const degradeHelper = () => 'fallback';\n",
      "README.md": "Fallback search content here.\n",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-mcp-degrade-"));
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    const dbPath = join(dbDir, "index.duckdb");
    const lockPath = join(dbDir, "security.lock");
    const { hash } = loadSecurityConfig();
    updateSecurityLock(hash, lockPath);

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const runtime = await createServerRuntime({
      repoRoot: repo.path,
      databasePath: dbPath,
      securityLockPath: lockPath,
      allowDegrade: true,
    });
    cleanupTargets.push({ dispose: async () => await runtime.close() });

    // 強制的に degrade モードへ移行
    runtime.degrade.enable("duckdb:files_search");

    const handler = createRpcHandler(runtime);
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "files_search",
        arguments: {
          query: "fallback",
        },
      },
    };

    const response = ensureResponse(await handler(request));
    expect(response.statusCode).toBe(200);
    const payload = response.response as JsonRpcSuccess;
    const result = payload.result as Record<string, unknown>;
    const content = result.content as Array<{ type: string; text: string }>;
    expect(Array.isArray(content)).toBe(true);
    const firstContent = content[0];
    if (!firstContent) throw new Error("Content array is empty");

    const searchResults = JSON.parse(firstContent.text);
    expect(Array.isArray(searchResults)).toBe(true);
    expect(searchResults.length).toBeGreaterThan(0);

    const firstResult = searchResults[0] as Record<string, unknown>;
    expect(firstResult).toHaveProperty("path");
    expect(firstResult).toHaveProperty("preview");
    expect(firstResult).toHaveProperty("matchLine");
    expect(firstResult).toHaveProperty("lang");
    expect(firstResult).toHaveProperty("ext");
    expect(firstResult).toHaveProperty("score");
  });

  it("tools/call が不明なツール名でエラーを返す", async () => {
    const repo = await createTempRepo({
      "src/app.ts": "export const app = () => 1;\n",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-mcp-error-"));
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    const dbPath = join(dbDir, "index.duckdb");
    const lockPath = join(dbDir, "security.lock");
    const { hash } = loadSecurityConfig();
    updateSecurityLock(hash, lockPath);

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const runtime = await createServerRuntime({
      repoRoot: repo.path,
      databasePath: dbPath,
      securityLockPath: lockPath,
    });
    cleanupTargets.push({ dispose: async () => await runtime.close() });

    const handler = createRpcHandler(runtime);
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "unknown.tool",
        arguments: {},
      },
    };
    const response = ensureResponse(await handler(request));

    expect(response.statusCode).toBe(200);
    const payload = response.response as JsonRpcSuccess;
    const result = payload.result as Record<string, unknown>;

    // Should return MCP error format (not JSON-RPC error)
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("isError");
    expect(result.isError).toBe(true);

    const content = result.content as Array<{ type: string; text: string }>;
    expect(Array.isArray(content)).toBe(true);
    const firstContent = content[0];
    if (!firstContent) throw new Error("Content array is empty");
    expect(firstContent.text).toContain("Unknown tool");
  });

  it("tools/call が無効なパラメータで JSON-RPC エラーを返す", async () => {
    const repo = await createTempRepo({
      "src/app.ts": "export const app = () => 1;\n",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-mcp-invalid-"));
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    const dbPath = join(dbDir, "index.duckdb");
    const lockPath = join(dbDir, "security.lock");
    const { hash } = loadSecurityConfig();
    updateSecurityLock(hash, lockPath);

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const runtime = await createServerRuntime({
      repoRoot: repo.path,
      databasePath: dbPath,
      securityLockPath: lockPath,
    });
    cleanupTargets.push({ dispose: async () => await runtime.close() });

    const handler = createRpcHandler(runtime);
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        // Missing "name" field
        arguments: {},
      },
    };
    const response = ensureResponse(await handler(request));

    expect(response.statusCode).toBe(400);
    const payload = response.response;
    expect(payload).toHaveProperty("error");
  }, 15000);

  it("id を含まない通知リクエストではレスポンスを生成しない", async () => {
    const repo = await createTempRepo({
      "src/app.ts": "export const app = () => 1;\n",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-mcp-notify-"));
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    const dbPath = join(dbDir, "index.duckdb");
    const lockPath = join(dbDir, "security.lock");
    const { hash } = loadSecurityConfig();
    updateSecurityLock(hash, lockPath);

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const runtime = await createServerRuntime({
      repoRoot: repo.path,
      databasePath: dbPath,
      securityLockPath: lockPath,
    });
    cleanupTargets.push({ dispose: async () => await runtime.close() });

    const handler = createRpcHandler(runtime);
    const request: JsonRpcRequest = { jsonrpc: "2.0", method: "ping" };
    const response = await handler(request);

    expect(response).toBeNull();
  });

  // 項目4: RPC統合テスト（snake_case/camelCase変換の検証）
  describe("v0.9.6 新パラメータの RPC 統合テスト", () => {
    it("snippets_get が include_line_numbers を snake_case で受け付ける", async () => {
      const repo = await createTempRepo({
        "src/logic.ts": [
          "export function alpha() {",
          "  return 1;",
          "}",
          "",
          "export function beta() {",
          "  return 2;",
          "}",
        ].join("\n"),
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-rpc-line-numbers-"));
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      const dbPath = join(dbDir, "index.duckdb");
      const lockPath = join(dbDir, "security.lock");
      const { hash } = loadSecurityConfig();
      updateSecurityLock(hash, lockPath);

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const runtime = await createServerRuntime({
        repoRoot: repo.path,
        databasePath: dbPath,
        securityLockPath: lockPath,
      });
      cleanupTargets.push({ dispose: async () => await runtime.close() });

      const handler = createRpcHandler(runtime);
      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 100,
        method: "tools/call",
        params: {
          name: "snippets_get",
          arguments: {
            path: "src/logic.ts",
            start_line: 1,
            end_line: 3,
            include_line_numbers: true, // snake_case
          },
        },
      };

      const response = ensureResponse(await handler(request));
      expect(response.statusCode).toBe(200);

      const payload = response.response as JsonRpcSuccess;
      const result = payload.result as Record<string, unknown>;
      const content = result.content as Array<{ type: string; text: string }>;
      const firstContent = content[0];
      if (!firstContent) throw new Error("Content array is empty");

      const snippetResult = JSON.parse(firstContent.text) as { content?: string };
      expect(snippetResult.content).toBeDefined();
      expect(snippetResult.content).toMatch(/^\s*1→/);
    });

    it("context_bundle が include_tokens_estimate を snake_case で受け付ける", async () => {
      const repo = await createTempRepo({
        "src/app.ts": "export function app() { return 1; }\n",
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-rpc-tokens-estimate-"));
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      const dbPath = join(dbDir, "index.duckdb");
      const lockPath = join(dbDir, "security.lock");
      const { hash } = loadSecurityConfig();
      updateSecurityLock(hash, lockPath);

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const runtime = await createServerRuntime({
        repoRoot: repo.path,
        databasePath: dbPath,
        securityLockPath: lockPath,
      });
      cleanupTargets.push({ dispose: async () => await runtime.close() });

      const handler = createRpcHandler(runtime);
      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 101,
        method: "tools/call",
        params: {
          name: "context_bundle",
          arguments: {
            goal: "investigate app",
            limit: 3,
            include_tokens_estimate: true, // snake_case
          },
        },
      };

      const response = ensureResponse(await handler(request));
      expect(response.statusCode).toBe(200);

      const payload = response.response as JsonRpcSuccess;
      const result = payload.result as Record<string, unknown>;
      const content = result.content as Array<{ type: string; text: string }>;
      const firstContent = content[0];
      if (!firstContent) throw new Error("Content array is empty");

      const bundleResult = JSON.parse(firstContent.text) as {
        tokens_estimate?: number;
      };
      expect(bundleResult.tokens_estimate).toBeDefined();
      expect(typeof bundleResult.tokens_estimate).toBe("number");
    });

    it("files_search が compact パラメータを受け付けて preview を省略する", async () => {
      const repo = await createTempRepo({
        "src/main.ts": "export const foo = 1;\nexport const bar = foo + 1;\n",
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-rpc-compact-"));
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      const dbPath = join(dbDir, "index.duckdb");
      const lockPath = join(dbDir, "security.lock");
      const { hash } = loadSecurityConfig();
      updateSecurityLock(hash, lockPath);

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const runtime = await createServerRuntime({
        repoRoot: repo.path,
        databasePath: dbPath,
        securityLockPath: lockPath,
      });
      cleanupTargets.push({ dispose: async () => await runtime.close() });

      const handler = createRpcHandler(runtime);
      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 102,
        method: "tools/call",
        params: {
          name: "files_search",
          arguments: {
            query: "foo",
            compact: true,
          },
        },
      };

      const response = ensureResponse(await handler(request));
      expect(response.statusCode).toBe(200);

      const payload = response.response as JsonRpcSuccess;
      const result = payload.result as Record<string, unknown>;
      const content = result.content as Array<{ type: string; text: string }>;
      const firstContent = content[0];
      if (!firstContent) throw new Error("Content array is empty");

      const searchResults = JSON.parse(firstContent.text) as Array<{ preview?: string }>;
      expect(Array.isArray(searchResults)).toBe(true);
      expect(searchResults.length).toBeGreaterThan(0);
      expect(searchResults.every((item) => item.preview === undefined)).toBe(true);
    });
  });
});
