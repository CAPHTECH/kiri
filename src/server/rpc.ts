import packageJson from "../../package.json" with { type: "json" };
import { maskValue } from "../shared/security/masker.js";

import { ServerContext } from "./context.js";
import { DegradeController } from "./fallbacks/degradeController.js";
import {
  ContextBundleParams,
  DepsClosureParams,
  FilesSearchParams,
  SemanticRerankParams,
  SnippetsGetParams,
  contextBundle,
  depsClosure,
  filesSearch,
  semanticRerank,
  snippetsGet,
} from "./handlers.js";
import { MetricsRegistry } from "./observability/metrics.js";
import { withSpan } from "./observability/tracing.js";

/**
 * WarningManager - 警告メッセージの表示を管理するクラス
 *
 * 各警告を一度だけ表示するための状態管理を提供します。
 * グローバル変数を使わずにServerContextにカプセル化することで、
 * テスタビリティと並行性を改善します。
 *
 * メモリリーク防止のため、保持する警告キーの数に上限を設定しています。
 */
export class WarningManager {
  private readonly shownWarnings = new Set<string>();
  public readonly responseWarnings: string[] = [];
  private readonly maxUniqueWarnings: number;
  private limitReachedWarningShown = false;

  /**
   * WarningManagerを構築します
   *
   * @param maxUniqueWarnings - 追跡する一意の警告の最大数（デフォルト: 1000）
   */
  constructor(maxUniqueWarnings: number = 1000) {
    this.maxUniqueWarnings = maxUniqueWarnings;
  }

  /**
   * 指定されたキーの警告をまだ表示していない場合にのみ表示します
   *
   * @param key - 警告を識別するユニークなキー
   * @param message - 表示する警告メッセージ
   * @param forResponse - true の場合、警告をAPIレスポンスに含める
   * @returns 警告が表示された場合はtrue、既に表示済みの場合はfalse
   */
  warnOnce(key: string, message: string, forResponse: boolean = false): boolean {
    if (this.shownWarnings.has(key)) {
      return false;
    }

    // メモリリーク防止: 上限に達したら新しい警告を追加しない
    if (this.shownWarnings.size >= this.maxUniqueWarnings) {
      if (!this.limitReachedWarningShown) {
        console.warn(
          "WarningManager: Unique warning limit reached. No new warnings will be shown."
        );
        this.limitReachedWarningShown = true;
      }
      return false;
    }

    console.warn(message);
    this.shownWarnings.add(key);

    if (forResponse) {
      this.responseWarnings.push(message);
    }

    return true;
  }

  /**
   * テスト用：表示済み警告の履歴をクリアします
   */
  reset(): void {
    this.shownWarnings.clear();
    this.responseWarnings.length = 0;
    this.limitReachedWarningShown = false;
  }
}

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

export interface RpcHandlerDependencies {
  context: ServerContext;
  degrade: DegradeController;
  metrics: MetricsRegistry;
  tokens: string[];
  allowDegrade: boolean;
}

export interface RpcHandleResult {
  response: JsonRpcResponse;
  statusCode: number;
}

interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const SERVER_INFO = {
  name: "kiri",
  version: typeof packageJson?.version === "string" ? packageJson.version : "0.0.0",
} as const;

const TOOL_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: "context_bundle",
    description:
      "Primary code discovery tool. Provide a concrete `goal` to receive ranked `context` entries containing `path`, `range`, optional `preview`, scoring `why`, and `score`.\n\n" +
      "Returns {context, tokens_estimate, warnings?}; the tool only reads from the index. Empty or vague goals raise an MCP error that asks for specific keywords.\n\n" +
      "Example: context_bundle({goal: 'Fix pagination off-by-one in src/catalog/products.ts'}) surfaces the affected files. Invalid: goal='debug' triggers a validation error.",
    inputSchema: {
      type: "object",
      required: ["goal"],
      additionalProperties: true,
      properties: {
        goal: {
          type: "string",
          description:
            "A clear, specific description using concrete keywords. Focus on WHAT you're looking for, not HOW to find it. " +
            "Good: 'User login validation, session management, token refresh'. " +
            "Bad: 'Understand how users log in', 'explore auth', 'authentication'.",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 20,
          description:
            "Maximum number of snippets to return. Default: 7 (optimized for token efficiency), use 5 for quick exploration, 10-15 for deep investigation.",
        },
        compact: {
          type: "boolean",
          description:
            "If true, omits the 'preview' field to drastically reduce token consumption (~95% reduction). " +
            "Returns only metadata: path, range, why, score. Use with snippets.get for two-tier approach. " +
            "Default: true (v0.8.0+). Set to false if you need immediate code previews.",
        },
        profile: {
          type: "string",
          description: "Evaluation profile name (bugfix, testfail, refactor, typeerror, feature).",
        },
        boost_profile: {
          type: "string",
          enum: ["default", "docs", "none"],
          description:
            'File type boosting mode: "default" prioritizes implementation files (src/app/, src/components/), "docs" prioritizes documentation (*.md), "none" disables boosting. Default is "default".',
        },
        artifacts: {
          type: "object",
          additionalProperties: true,
          properties: {
            editing_path: {
              type: "string",
              pattern: "^(?!.*\\.\\.)[A-Za-z0-9_./\\-]+$",
              description:
                "Path to the file currently being edited. Strongly recommended to provide for better context; boosts that file and related dependencies in the bundle output.",
            },
            failing_tests: {
              type: "array",
              items: { type: "string" },
              description: "Names of failing test cases. Useful for debugging.",
            },
            last_diff: {
              type: "string",
              description: "Recent diff content. Useful for understanding current changes.",
            },
          },
        },
      },
    },
  },
  {
    name: "semantic_rerank",
    description:
      "Reorders candidate files by embedding similarity to `text`. Use after keyword or heuristic search when you already have `candidates` and want a semantic ranking update without fetching new files.\n\n" +
      "Returns {candidates: [{path, semantic, base, combined}]}; purely read-only. Missing `text` or an empty candidate list causes an MCP error describing the required inputs.\n\n" +
      "Example: semantic_rerank({text: 'JWT login flow', candidates: [...]}) reprioritises auth code. Invalid: semantic_rerank({text: '', candidates: [...]}) raises a validation error.",
    inputSchema: {
      type: "object",
      required: ["text", "candidates"],
      additionalProperties: true,
      properties: {
        text: { type: "string", description: "Query or goal text for similarity comparison." },
        candidates: {
          type: "array",
          items: {
            type: "object",
            required: ["path"],
            additionalProperties: true,
            properties: {
              path: { type: "string" },
              score: { type: "number" },
            },
          },
        },
        k: { type: "number", minimum: 1, description: "Number of top results to return." },
        profile: { type: "string" },
      },
    },
  },
  {
    name: "files_search",
    description:
      "Token-aware substring search for precise identifiers, error messages, or import fragments. Prefer this tool when you already know the exact string you need to locate; use `context_bundle` for exploratory work.\n\n" +
      "Returns an array of `{path, preview, matchLine, lang, ext, score}` objects; the tool never mutates the repo. Empty queries raise an MCP error prompting you to provide a concrete keyword. If DuckDB is unavailable but the server runs with `--allow-degrade`, the same array shape is returned using filesystem-based fallbacks (with `lang`/`ext` set to null).\n\n" +
      'Example: files_search({query: "AuthenticationError", path_prefix: "src/auth/"}) narrows to auth handlers. Invalid: files_search({query: ""}) reports that the query must be non-empty.',
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: true,
      properties: {
        query: {
          type: "string",
          description:
            "Specific keyword, function name, class name, error message, or code pattern to search for. " +
            "Be as specific as possible. Good: 'handleUserLogin', 'JWT_SECRET', 'ReferenceError'. " +
            "Bad: 'login', 'authentication', 'understand'.",
        },
        lang: {
          type: "string",
          description: "Filter by language name (e.g., 'typescript', 'python', 'swift').",
        },
        ext: {
          type: "string",
          description: "Filter by file extension (e.g., '.ts', '.py', '.md').",
        },
        path_prefix: {
          type: "string",
          pattern: "^(?!.*\\.\\.)[A-Za-z0-9_./\\-]+/?$",
          description: "Filter by path prefix (e.g., 'src/auth/', 'tests/'). No '..' allowed.",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 200,
          description:
            "Maximum number of results. Default: 50. Use higher values for exhaustive search.",
        },
        boost_profile: {
          type: "string",
          enum: ["default", "docs", "none"],
          description:
            'File type boosting mode: "default" prioritizes implementation files (src/app/, src/components/), "docs" prioritizes documentation (*.md), "none" disables boosting. Default is "default".',
        },
      },
    },
  },
  {
    name: "snippets_get",
    description:
      "Focused snippet retrieval by file path. The tool uses recorded symbol boundaries to return the smallest readable span, or falls back to the requested line window.\n\n" +
      "Returns {path, startLine, endLine, content, totalLines, symbolName, symbolKind}; this is a read-only lookup. Missing `path`, binary files, or absent index entries raise an MCP error with guidance to re-run the indexer.\n\n" +
      "Example: snippets_get({path: 'src/auth/login.ts'}) surfaces the enclosing function. Invalid: snippets_get({path: 'assets/logo.png'}) reports that binary snippets are unsupported.",
    inputSchema: {
      type: "object",
      required: ["path"],
      additionalProperties: true,
      properties: {
        path: {
          type: "string",
          pattern: "^(?!.*\\.\\.)[A-Za-z0-9_./\\-]+$",
        },
        start_line: { type: "number", minimum: 0 },
        end_line: { type: "number", minimum: 0 },
      },
    },
  },
  {
    name: "deps_closure",
    description:
      "Dependency graph traversal from a starting file. Use it during impact analysis to map outbound imports or inbound dependents before large refactors.\n\n" +
      "Returns {root, direction, nodes, edges}; nodes/edges include depth metadata and never mutate repository state. Invalid paths, excessive depth, or non-indexed files raise MCP errors with remediation tips.\n\n" +
      "Example: deps_closure({path: 'src/shared/config.ts', direction: 'inbound', max_depth: 2}) lists consumers. Invalid: deps_closure({path: '../secret'}) fails path validation.",
    inputSchema: {
      type: "object",
      required: ["path"],
      additionalProperties: true,
      properties: {
        path: {
          type: "string",
          pattern: "^(?!.*\\.\\.)[A-Za-z0-9_./\\-]+$",
        },
        max_depth: { type: "number", minimum: 0 },
        direction: { type: "string", enum: ["outbound", "inbound"] },
        include_packages: { type: "boolean" },
      },
    },
  },
];

const INITIALIZE_PAYLOAD = {
  protocolVersion: "2024-11-05",
  serverInfo: SERVER_INFO,
  capabilities: {
    tools: {},
    resources: {},
  },
} as const;

function parseFilesSearchParams(input: unknown): FilesSearchParams {
  if (!input || typeof input !== "object") {
    return { query: "" };
  }
  const record = input as Record<string, unknown>;
  const limitValue = record.limit;
  let limit: number | undefined;
  if (typeof limitValue === "number") {
    limit = limitValue;
  } else if (typeof limitValue === "string") {
    const parsed = Number(limitValue);
    if (!Number.isNaN(parsed)) {
      limit = parsed;
    }
  }
  const params: FilesSearchParams = {
    query: typeof record.query === "string" ? record.query : "",
  };
  if (typeof record.lang === "string") params.lang = record.lang;
  if (typeof record.ext === "string") params.ext = record.ext;

  // Validate path_prefix to prevent path traversal attacks
  if (typeof record.path_prefix === "string") {
    if (record.path_prefix.includes("..")) {
      throw new Error("path_prefix cannot contain '..' (path traversal not allowed)");
    }
    params.path_prefix = record.path_prefix;
  }

  // Validate limit is within acceptable range
  if (limit !== undefined) {
    if (limit < 1 || limit > 200) {
      throw new Error("limit must be between 1 and 200");
    }
    params.limit = limit;
  }

  // Parse boost_profile parameter
  const boostProfile = record.boost_profile;
  if (boostProfile === "default" || boostProfile === "docs" || boostProfile === "none") {
    params.boost_profile = boostProfile;
  }

  return params;
}

function parseSnippetsGetParams(input: unknown): SnippetsGetParams {
  if (!input || typeof input !== "object") {
    return { path: "" };
  }
  const record = input as Record<string, unknown>;
  const toNumber = (value: unknown): number | undefined => {
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      return Number.isNaN(parsed) ? undefined : parsed;
    }
    return undefined;
  };
  const startLine = toNumber(record.start_line);
  const endLine = toNumber(record.end_line);
  const params: SnippetsGetParams = {
    path: typeof record.path === "string" ? record.path : "",
  };
  if (startLine !== undefined) params.start_line = startLine;
  if (endLine !== undefined) params.end_line = endLine;
  return params;
}

function parseDepsClosureParams(input: unknown): DepsClosureParams {
  if (!input || typeof input !== "object") {
    return { path: "" };
  }
  const record = input as Record<string, unknown>;
  const toNumber = (value: unknown): number | undefined => {
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      return Number.isNaN(parsed) ? undefined : parsed;
    }
    return undefined;
  };
  const direction =
    record.direction === "inbound" || record.direction === "outbound"
      ? (record.direction as "inbound" | "outbound")
      : undefined;
  const includePackages =
    typeof record.include_packages === "boolean" ? record.include_packages : undefined;
  const maxDepth = toNumber(record.max_depth);
  const params: DepsClosureParams = {
    path: typeof record.path === "string" ? record.path : "",
  };
  if (maxDepth !== undefined) params.max_depth = maxDepth;
  if (direction !== undefined) params.direction = direction;
  if (includePackages !== undefined) params.include_packages = includePackages;
  return params;
}

function parseContextBundleParams(input: unknown, context: ServerContext): ContextBundleParams {
  if (!input || typeof input !== "object") {
    return { goal: "" };
  }
  const record = input as Record<string, unknown>;
  const params: ContextBundleParams = {
    goal: typeof record.goal === "string" ? record.goal : "",
  };

  // Parse and validate limit parameter
  const limitValue = record.limit;
  let limit: number | undefined;
  if (typeof limitValue === "number") {
    limit = limitValue;
  } else if (typeof limitValue === "string") {
    const parsed = Number(limitValue);
    if (!Number.isNaN(parsed)) {
      limit = parsed;
    }
  }

  if (limit !== undefined) {
    if (limit < 1 || limit > 20) {
      throw new Error("limit must be between 1 and 20");
    }
    params.limit = limit;
  }

  const artifactsValue = record.artifacts;
  if (artifactsValue && typeof artifactsValue === "object") {
    const artifactsRecord = artifactsValue as Record<string, unknown>;
    const artifacts: ContextBundleParams["artifacts"] = {};
    if (typeof artifactsRecord.editing_path === "string") {
      artifacts.editing_path = artifactsRecord.editing_path;
    }
    if (Array.isArray(artifactsRecord.failing_tests)) {
      const failingTests = artifactsRecord.failing_tests.filter(
        (value): value is string => typeof value === "string"
      );
      if (failingTests.length > 0) {
        artifacts.failing_tests = failingTests;
      }
    }
    if (typeof artifactsRecord.last_diff === "string") {
      artifacts.last_diff = artifactsRecord.last_diff;
    }
    if (artifacts.editing_path || artifacts.failing_tests || artifacts.last_diff) {
      params.artifacts = artifacts;
    }
  }

  if (typeof record.profile === "string") {
    params.profile = record.profile;
  }

  // Parse boost_profile parameter
  const boostProfile = record.boost_profile;
  if (boostProfile === "default" || boostProfile === "docs" || boostProfile === "none") {
    params.boost_profile = boostProfile;
  }

  // Parse compact parameter (default: true for token efficiency)
  if (typeof record.compact === "boolean") {
    params.compact = record.compact;
  } else {
    params.compact = true; // Default to compact mode (v0.8.0+: breaking change)

    // Show one-time warning about breaking change using WarningManager
    // forResponse: true adds this warning to the API response
    context.warningManager.warnOnce(
      "compact-default-v0.8.0",
      "BREAKING CHANGE (v0.8.0): compact mode is now default. " +
        "Set compact: false to restore previous behavior. " +
        "See CHANGELOG.md for details.",
      true // Add to API response
    );
  }

  return params;
}

function parseSemanticRerankParams(input: unknown): SemanticRerankParams {
  if (!input || typeof input !== "object") {
    return { text: "", candidates: [] };
  }
  const record = input as Record<string, unknown>;
  const params: SemanticRerankParams = {
    text: typeof record.text === "string" ? record.text : "",
    candidates: [],
  };

  const candidatesValue = record.candidates;
  if (Array.isArray(candidatesValue)) {
    for (const candidate of candidatesValue) {
      if (!candidate || typeof candidate !== "object") {
        continue;
      }
      const candidateRecord = candidate as Record<string, unknown>;
      if (typeof candidateRecord.path !== "string" || candidateRecord.path.length === 0) {
        continue;
      }
      const candidateInput: SemanticRerankParams["candidates"][number] = {
        path: candidateRecord.path,
      };
      if (typeof candidateRecord.score === "number" && Number.isFinite(candidateRecord.score)) {
        candidateInput.score = candidateRecord.score;
      }
      params.candidates.push(candidateInput);
    }
  }

  const limitValue = record.k;
  if (typeof limitValue === "number" && Number.isFinite(limitValue)) {
    params.k = limitValue;
  } else if (typeof limitValue === "string") {
    const parsed = Number(limitValue);
    if (!Number.isNaN(parsed)) {
      params.k = parsed;
    }
  }

  if (typeof record.profile === "string") {
    params.profile = record.profile;
  }

  return params;
}

export function successResponse(id: string | number, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

export function errorResponse(
  id: string | number | null,
  message: string,
  code = -32603
): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function validateJsonRpcRequest(payload: JsonRpcRequest): string | null {
  if (payload.jsonrpc !== "2.0" || typeof payload.method !== "string") {
    return "Malformed JSON-RPC request. Provide method and jsonrpc=2.0.";
  }
  return null;
}

// MCP standard tool result format
interface McpToolResult {
  content: Array<{
    type: "text";
    text: string;
  }>;
  isError?: boolean;
}

// Helper function to execute a tool by name
async function executeToolByName(
  toolName: string,
  toolParams: unknown,
  context: ServerContext,
  degrade: DegradeController,
  allowDegrade: boolean
): Promise<unknown> {
  switch (toolName) {
    case "context_bundle": {
      const params = parseContextBundleParams(toolParams, context);
      const handler = async () =>
        await withSpan("context_bundle", async () => await contextBundle(context, params));
      return await degrade.withResource(handler, "duckdb:context_bundle");
    }
    case "semantic_rerank": {
      const params = parseSemanticRerankParams(toolParams);
      const handler = async () =>
        await withSpan("semantic_rerank", async () => await semanticRerank(context, params));
      return await degrade.withResource(handler, "duckdb:semantic_rerank");
    }
    case "files_search": {
      const params = parseFilesSearchParams(toolParams);
      if (degrade.current.active && allowDegrade) {
        return degrade.search(params.query, params.limit ?? 20).map((hit) => ({
          path: hit.path,
          preview: hit.preview,
          matchLine: hit.matchLine,
          lang: null,
          ext: null,
          score: 0,
        }));
      } else {
        const handler = async () =>
          await withSpan("files_search", async () => await filesSearch(context, params));
        return await degrade.withResource(handler, "duckdb:files_search");
      }
    }
    case "snippets_get": {
      const params = parseSnippetsGetParams(toolParams);
      const handler = async () =>
        await withSpan("snippets_get", async () => await snippetsGet(context, params));
      return await degrade.withResource(handler, "duckdb:snippets_get");
    }
    case "deps_closure": {
      const params = parseDepsClosureParams(toolParams);
      const handler = async () =>
        await withSpan("deps_closure", async () => await depsClosure(context, params));
      return await degrade.withResource(handler, "duckdb:deps_closure");
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

export function createRpcHandler(
  dependencies: RpcHandlerDependencies
): (payload: JsonRpcRequest) => Promise<RpcHandleResult | null> {
  const { context, degrade, metrics, tokens, allowDegrade } = dependencies;
  return async (payload: JsonRpcRequest): Promise<RpcHandleResult | null> => {
    const hasResponseId = typeof payload.id === "string" || typeof payload.id === "number";
    try {
      let result: unknown;

      switch (payload.method) {
        case "initialize": {
          result = INITIALIZE_PAYLOAD;
          break;
        }
        case "ping": {
          // Health check endpoint - returns server info and uptime
          result = {
            status: "ok",
            serverInfo: SERVER_INFO,
            pid: process.pid,
            uptime: process.uptime(),
          };
          break;
        }
        case "tools/list": {
          // MCP standard format: tools array without nextCursor (no pagination)
          result = { tools: TOOL_DESCRIPTORS };
          break;
        }
        case "resources/list": {
          // MCP standard format: resources array without pagination
          result = { resources: [] };
          break;
        }
        case "tools/call": {
          // MCP standard tool invocation
          const paramsRecord = payload.params as Record<string, unknown> | null | undefined;
          if (!paramsRecord || typeof paramsRecord !== "object") {
            return hasResponseId
              ? {
                  statusCode: 400,
                  response: errorResponse(
                    payload.id as string | number,
                    "Invalid params for tools/call. Provide name and arguments.",
                    -32602
                  ),
                }
              : null;
          }

          const toolName = paramsRecord.name;
          if (typeof toolName !== "string") {
            return hasResponseId
              ? {
                  statusCode: 400,
                  response: errorResponse(
                    payload.id as string | number,
                    "Invalid params for tools/call. Tool name must be a string.",
                    -32602
                  ),
                }
              : null;
          }

          const toolArguments = paramsRecord.arguments ?? {};

          try {
            const toolResult = await executeToolByName(
              toolName,
              toolArguments,
              context,
              degrade,
              allowDegrade
            );

            // Convert to MCP standard format
            const mcpResult: McpToolResult = {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(toolResult, null, 2),
                },
              ],
              isError: false,
            };
            result = mcpResult;
          } catch (error) {
            // Tool execution error - return as MCP error result
            const errorMessage =
              error instanceof Error
                ? error.message
                : "Tool execution failed. Inspect server logs and retry.";

            const mcpErrorResult: McpToolResult = {
              content: [
                {
                  type: "text",
                  text: errorMessage,
                },
              ],
              isError: true,
            };
            result = mcpErrorResult;
          }
          break;
        }
        // Legacy direct method invocation (backward compatibility)
        case "context_bundle": {
          result = await executeToolByName(
            "context_bundle",
            payload.params,
            context,
            degrade,
            allowDegrade
          );
          break;
        }
        case "semantic_rerank": {
          result = await executeToolByName(
            "semantic_rerank",
            payload.params,
            context,
            degrade,
            allowDegrade
          );
          break;
        }
        case "files_search": {
          result = await executeToolByName(
            "files_search",
            payload.params,
            context,
            degrade,
            allowDegrade
          );
          break;
        }
        case "snippets_get": {
          result = await executeToolByName(
            "snippets_get",
            payload.params,
            context,
            degrade,
            allowDegrade
          );
          break;
        }
        case "deps_closure": {
          result = await executeToolByName(
            "deps_closure",
            payload.params,
            context,
            degrade,
            allowDegrade
          );
          break;
        }
        default: {
          return hasResponseId
            ? {
                statusCode: 404,
                response: errorResponse(
                  payload.id as string | number,
                  "Requested method is not available. Use tools/call, or legacy methods: context_bundle, semantic_rerank, files_search, snippets_get, or deps_closure.",
                  -32601
                ),
              }
            : null;
        }
      }
      const masked = maskValue(result, { tokens });
      if (masked.applied > 0) {
        metrics.recordMask(masked.applied);
      }
      if (!hasResponseId) {
        return null;
      }
      return {
        statusCode: 200,
        response: successResponse(payload.id as string | number, masked.masked),
      };
    } catch (error) {
      if (degrade.current.active && !allowDegrade) {
        return hasResponseId
          ? {
              statusCode: 503,
              response: errorResponse(
                payload.id as string | number,
                "Backend degraded and --allow-degrade not set. Restore DuckDB availability or restart server."
              ),
            }
          : null;
      }
      if (degrade.current.active && allowDegrade) {
        return hasResponseId
          ? {
              statusCode: 503,
              response: errorResponse(
                payload.id as string | number,
                degrade.current.reason
                  ? `Backend degraded due to ${degrade.current.reason}. Only files_search is operational.`
                  : "Backend degraded. Only files_search is operational."
              ),
            }
          : null;
      }
      const message =
        error instanceof Error
          ? error.message
          : "Unknown error occurred. Inspect server logs and retry the request.";
      return hasResponseId
        ? {
            statusCode: 500,
            response: errorResponse(payload.id as string | number, message),
          }
        : null;
    }
  };
}
