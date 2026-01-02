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

  it("tools/list で files_search の inputSchema に top-level anyOf/oneOf/allOf が含まれない", async () => {
    const repo = await createTempRepo({
      "src/app.ts": "export const app = () => 1;\n",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-mcp-tools-schema-"));
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
    const request: JsonRpcRequest = { jsonrpc: "2.0", id: 3, method: "tools/list" };
    const response = ensureResponse(await handler(request));

    expect(response.statusCode).toBe(200);
    const payload = response.response as JsonRpcSuccess;
    const tools = (payload.result as Record<string, unknown>).tools as unknown[];
    expect(Array.isArray(tools)).toBe(true);

    const filesSearch = tools.find(
      (tool) =>
        tool &&
        typeof tool === "object" &&
        (tool as Record<string, unknown>).name === "files_search"
    ) as Record<string, unknown> | undefined;

    expect(filesSearch).toBeDefined();
    const schema = filesSearch?.inputSchema as Record<string, unknown> | undefined;
    expect(schema && typeof schema === "object").toBe(true);

    const invalidKeys = ["anyOf", "oneOf", "allOf"].filter(
      (key) => schema !== undefined && Object.prototype.hasOwnProperty.call(schema, key)
    );
    expect(invalidKeys).toHaveLength(0);
  });

  it("tools/list の全ツールの inputSchema に top-level anyOf/oneOf/allOf が含まれない", async () => {
    const repo = await createTempRepo({
      "src/app.ts": "export const app = () => 1;\n",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-mcp-all-tools-schema-"));
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
    const request: JsonRpcRequest = { jsonrpc: "2.0", id: 4, method: "tools/list" };
    const response = ensureResponse(await handler(request));

    expect(response.statusCode).toBe(200);
    const payload = response.response as JsonRpcSuccess;
    const tools = (payload.result as Record<string, unknown>).tools as unknown[];
    expect(Array.isArray(tools)).toBe(true);

    // 全ツールのスキーマを検証
    const invalidSchemaKeywords = ["anyOf", "oneOf", "allOf"];
    const toolsWithInvalidSchema: string[] = [];

    for (const tool of tools) {
      if (!tool || typeof tool !== "object") continue;
      const toolObj = tool as Record<string, unknown>;
      const toolName = toolObj.name as string;
      const schema = toolObj.inputSchema as Record<string, unknown> | undefined;

      if (schema && typeof schema === "object") {
        const foundInvalidKeys = invalidSchemaKeywords.filter((key) =>
          Object.prototype.hasOwnProperty.call(schema, key)
        );
        if (foundInvalidKeys.length > 0) {
          toolsWithInvalidSchema.push(`${toolName}: ${foundInvalidKeys.join(", ")}`);
        }
      }
    }

    // エラーメッセージで問題のあるツールを特定できるようにする
    expect(toolsWithInvalidSchema).toEqual([]);
  });

  it("resources/list がプロジェクトリソースを返す", async () => {
    const repo = await createTempRepo({
      "src/app.ts": "export const app = () => 1;\n",
      "CLAUDE.md": "# AI Instructions\n",
      "README.md": "# Project\n",
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
    // CLAUDE.md + README.md + stats = 3
    expect(resources.length).toBe(3);

    const uris = resources.map((r) => (r as Record<string, unknown>).uri);
    expect(uris).toContain("kiri://project/claude-md");
    expect(uris).toContain("kiri://project/readme");
    expect(uris).toContain("kiri://project/stats");
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
    const searchResults = JSON.parse(firstContent.text) as { results: unknown[] };
    expect(searchResults).toHaveProperty("results");
    expect(Array.isArray(searchResults.results)).toBe(true);
    expect(searchResults.results.length).toBeGreaterThan(0);
  });

  it("degrade モードでも files.search が結果を返す", async () => {
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

    const searchResults = JSON.parse(firstContent.text) as { results: Record<string, unknown>[] };
    expect(searchResults).toHaveProperty("results");
    expect(Array.isArray(searchResults.results)).toBe(true);
    expect(searchResults.results.length).toBeGreaterThan(0);

    const firstResult = searchResults.results[0];
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

      const searchResults = JSON.parse(firstContent.text) as {
        results: Array<{ preview?: string }>;
      };
      expect(searchResults).toHaveProperty("results");
      expect(Array.isArray(searchResults.results)).toBe(true);
      expect(searchResults.results.length).toBeGreaterThan(0);
      expect(searchResults.results.every((item) => item.preview === undefined)).toBe(true);
    });
  });

  // MCP 2025-06-18 Structured Output 対応テスト
  describe("MCP 2025-06-18 Structured Output", () => {
    // Note: tools/listでは outputSchema を意図的に除外している（Claude Code互換性のため）
    // レスポンスサイズが8KBを超えるとClaude CodeのMCPクライアントでパースエラーが発生するため
    it("tools/list の全ツールには outputSchema が含まれない（Claude Code互換性）", async () => {
      const repo = await createTempRepo({
        "src/app.ts": "export const app = () => 1;\n",
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-mcp-output-schema-"));
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
      const request: JsonRpcRequest = { jsonrpc: "2.0", id: 200, method: "tools/list" };
      const response = ensureResponse(await handler(request));

      expect(response.statusCode).toBe(200);
      const payload = response.response as JsonRpcSuccess;
      const tools = (payload.result as Record<string, unknown>).tools as unknown[];
      expect(Array.isArray(tools)).toBe(true);

      // 全5ツールにoutputSchemaが含まれないことを検証（Claude Code互換性のため意図的に除外）
      const expectedTools = [
        "context_bundle",
        "semantic_rerank",
        "files_search",
        "snippets_get",
        "deps_closure",
      ];

      for (const expectedToolName of expectedTools) {
        const tool = tools.find(
          (t) =>
            t && typeof t === "object" && (t as Record<string, unknown>).name === expectedToolName
        ) as Record<string, unknown> | undefined;

        expect(tool).toBeDefined();
        // outputSchemaは意図的に除外されている
        expect(tool?.outputSchema).toBeUndefined();
      }

      // レスポンスサイズが8KB以下であることを検証
      const responseJson = JSON.stringify({ tools });
      expect(responseJson.length).toBeLessThan(8192);
    });

    it("tools/call が structuredContent を含むレスポンスを返す", async () => {
      const repo = await createTempRepo({
        "src/main.ts": "export function hello() {\n  return 'world';\n}\n",
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-mcp-structured-content-"));
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
        id: 201,
        method: "tools/call",
        params: {
          name: "files_search",
          arguments: {
            query: "hello",
          },
        },
      };

      const response = ensureResponse(await handler(request));
      expect(response.statusCode).toBe(200);

      const payload = response.response as JsonRpcSuccess;
      const result = payload.result as Record<string, unknown>;

      // MCP 2025-06-18: structuredContent フィールドが含まれることを検証
      expect(result).toHaveProperty("content");
      expect(result).toHaveProperty("structuredContent");
      expect(result).toHaveProperty("isError");
      expect(result.isError).toBe(false);

      // structuredContent と content の整合性を検証
      const content = result.content as Array<{ type: string; text: string }>;
      const firstContent = content[0];
      if (!firstContent) throw new Error("Content array is empty");

      const contentParsed = JSON.parse(firstContent.text);
      expect(result.structuredContent).toEqual(contentParsed);
    });

    it("tools/call エラー時は structuredContent を含まない", async () => {
      const repo = await createTempRepo({
        "src/app.ts": "export const app = () => 1;\n",
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-mcp-structured-error-"));
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
        id: 202,
        method: "tools/call",
        params: {
          name: "unknown_tool",
          arguments: {},
        },
      };

      const response = ensureResponse(await handler(request));
      expect(response.statusCode).toBe(200);

      const payload = response.response as JsonRpcSuccess;
      const result = payload.result as Record<string, unknown>;

      // エラー時はisError=trueでstructuredContentは含まれない
      expect(result.isError).toBe(true);
      expect(result).toHaveProperty("content");
      expect(result.structuredContent).toBeUndefined();
    });

    it("context_bundle の structuredContent が正しい構造を持つ", async () => {
      const repo = await createTempRepo({
        "src/auth.ts": "export function login() { return true; }\n",
        "src/app.ts": "import { login } from './auth';\nexport const app = login;\n",
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-mcp-bundle-structured-"));
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
        id: 203,
        method: "tools/call",
        params: {
          name: "context_bundle",
          arguments: {
            goal: "login authentication",
            limit: 5,
            includeWhy: true,
          },
        },
      };

      const response = ensureResponse(await handler(request));
      expect(response.statusCode).toBe(200);

      const payload = response.response as JsonRpcSuccess;
      const result = payload.result as Record<string, unknown>;

      expect(result.structuredContent).toBeDefined();
      const structured = result.structuredContent as Record<string, unknown>;

      // context_bundle の構造を検証
      expect(structured).toHaveProperty("context");
      expect(Array.isArray(structured.context)).toBe(true);

      const context = structured.context as Array<Record<string, unknown>>;
      if (context.length > 0) {
        const firstItem = context[0];
        expect(firstItem).toHaveProperty("path");
        expect(firstItem).toHaveProperty("range");
        expect(firstItem).toHaveProperty("why");
        expect(firstItem).toHaveProperty("score");
        expect(Array.isArray(firstItem?.range)).toBe(true);
        expect(Array.isArray(firstItem?.why)).toBe(true);
      }
    });
  });

  // MCP 2025-06-18 Prompts/Resources 対応テスト
  describe("MCP 2025-06-18 Prompts/Resources", () => {
    it("prompts/list がプリセットプロンプトを返す", async () => {
      const repo = await createTempRepo({
        "src/app.ts": "export const app = () => 1;\n",
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-mcp-prompts-list-"));
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
      const request: JsonRpcRequest = { jsonrpc: "2.0", id: 300, method: "prompts/list" };
      const response = ensureResponse(await handler(request));

      expect(response.statusCode).toBe(200);
      const payload = response.response as JsonRpcSuccess;
      const prompts = (payload.result as Record<string, unknown>).prompts as unknown[];
      expect(Array.isArray(prompts)).toBe(true);
      expect(prompts.length).toBe(5);

      const promptNames = prompts.map((p) => (p as Record<string, unknown>).name);
      expect(promptNames).toContain("debug-error");
      expect(promptNames).toContain("find-tests");
      expect(promptNames).toContain("explain-function");
      expect(promptNames).toContain("find-implementations");
      expect(promptNames).toContain("trace-dependency");
    });

    it("prompts/get が有効なプロンプトでメッセージを返す", async () => {
      const repo = await createTempRepo({
        "src/app.ts": "export const app = () => 1;\n",
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-mcp-prompts-get-"));
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
        id: 301,
        method: "prompts/get",
        params: {
          name: "debug-error",
          arguments: {
            error_message: "TypeError: Cannot read property 'foo' of undefined",
          },
        },
      };
      const response = ensureResponse(await handler(request));

      expect(response.statusCode).toBe(200);
      const payload = response.response as JsonRpcSuccess;
      const result = payload.result as Record<string, unknown>;

      expect(result).toHaveProperty("messages");
      expect(result).toHaveProperty("description");

      const messages = result.messages as Array<Record<string, unknown>>;
      expect(messages.length).toBe(1);
      expect(messages[0]?.role).toBe("user");

      const content = messages[0]?.content as Record<string, unknown>;
      expect(content?.type).toBe("text");
      expect(content?.text as string).toContain(
        "TypeError: Cannot read property 'foo' of undefined"
      );
    });

    it("prompts/get が不明なプロンプトでエラーを返す", async () => {
      const repo = await createTempRepo({
        "src/app.ts": "export const app = () => 1;\n",
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-mcp-prompts-get-error-"));
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
        id: 302,
        method: "prompts/get",
        params: {
          name: "unknown-prompt",
        },
      };
      const response = ensureResponse(await handler(request));

      expect(response.statusCode).toBe(404);
      const payload = response.response;
      expect(payload).toHaveProperty("error");
    });

    it("resources/read が CLAUDE.md を返す", async () => {
      const repo = await createTempRepo({
        "src/app.ts": "export const app = () => 1;\n",
        "CLAUDE.md": "# AI Instructions\n\nTest content here.\n",
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-mcp-resources-read-"));
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
        id: 303,
        method: "resources/read",
        params: {
          uri: "kiri://project/claude-md",
        },
      };
      const response = ensureResponse(await handler(request));

      expect(response.statusCode).toBe(200);
      const payload = response.response as JsonRpcSuccess;
      const result = payload.result as Record<string, unknown>;

      expect(result).toHaveProperty("contents");
      const contents = result.contents as Array<Record<string, unknown>>;
      expect(contents.length).toBe(1);
      expect(contents[0]?.uri).toBe("kiri://project/claude-md");
      expect(contents[0]?.mimeType).toBe("text/markdown");
      expect(contents[0]?.text as string).toContain("# AI Instructions");
    });

    it("resources/read がプロジェクト統計を返す", async () => {
      const repo = await createTempRepo({
        "src/app.ts": "export const app = () => 1;\n",
        "src/utils.ts": "export const utils = () => 2;\n",
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-mcp-resources-stats-"));
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
        id: 304,
        method: "resources/read",
        params: {
          uri: "kiri://project/stats",
        },
      };
      const response = ensureResponse(await handler(request));

      expect(response.statusCode).toBe(200);
      const payload = response.response as JsonRpcSuccess;
      const result = payload.result as Record<string, unknown>;

      expect(result).toHaveProperty("contents");
      const contents = result.contents as Array<Record<string, unknown>>;
      expect(contents.length).toBe(1);
      expect(contents[0]?.mimeType).toBe("application/json");

      const stats = JSON.parse(contents[0]?.text as string);
      expect(stats).toHaveProperty("totalFiles");
      expect(stats).toHaveProperty("totalLines");
      expect(stats).toHaveProperty("languages");
      expect(stats.totalFiles).toBeGreaterThan(0);
    });

    it("resources/read が不明なリソースでエラーを返す", async () => {
      const repo = await createTempRepo({
        "src/app.ts": "export const app = () => 1;\n",
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-mcp-resources-read-error-"));
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
        id: 305,
        method: "resources/read",
        params: {
          uri: "kiri://unknown/resource",
        },
      };
      const response = ensureResponse(await handler(request));

      expect(response.statusCode).toBe(404);
      const payload = response.response;
      expect(payload).toHaveProperty("error");
    });

    it("initialize が capabilities に prompts を含む", async () => {
      const repo = await createTempRepo({
        "src/app.ts": "export const app = () => 1;\n",
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-mcp-capabilities-"));
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
      const request: JsonRpcRequest = { jsonrpc: "2.0", id: 306, method: "initialize" };
      const response = ensureResponse(await handler(request));

      expect(response.statusCode).toBe(200);
      const payload = response.response as JsonRpcSuccess;
      const result = payload.result as Record<string, unknown>;

      expect(result).toHaveProperty("capabilities");
      const capabilities = result.capabilities as Record<string, unknown>;
      expect(capabilities).toHaveProperty("tools");
      expect(capabilities).toHaveProperty("resources");
      expect(capabilities).toHaveProperty("prompts");
    });
  });
});
