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

// Track if compact mode warning has been shown (v0.8.0 breaking change)
let compactWarningShown = false;

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
      "🎯 PRIMARY TOOL: Extracts relevant code context for a specific task or question.\n\n" +
      "Use this tool as your first step for any code-related task. It intelligently finds and ranks relevant files and code snippets using:\n" +
      "- **Phrase-aware tokenization**: Recognizes compound terms (kebab-case like 'page-agent', snake_case like 'user_profile') as single phrases with 2× scoring weight\n" +
      "- **Path-based scoring**: Boosts files when keywords appear in their path (e.g., searching 'auth' prioritizes src/auth/login.ts)\n" +
      "- **File type prioritization**: Uses boost_profile to prioritize implementation files over docs (configurable)\n" +
      "- **Dependency analysis**: Considers import relationships between files\n" +
      "- **Semantic similarity**: Ranks by structural similarity to your query\n\n" +
      "IMPORTANT: The 'goal' parameter MUST be a clear and specific description of your objective. Use concrete keywords, not abstract verbs.\n\n" +
      "✅ GOOD EXAMPLES (use specific keywords):\n" +
      "- goal='User authentication flow, JWT token validation'\n" +
      "- goal='Canvas page routing, API endpoints, navigation patterns'\n" +
      "- goal='Fix pagination off-by-one error in product listing'\n" +
      "- goal='Database connection pooling, retry logic'\n" +
      "- goal='page-agent Lambda handler implementation'  (hyphenated terms recognized as phrases)\n" +
      "- goal='context_bundle scoring logic'  (underscore terms recognized as phrases)\n\n" +
      "❌ BAD EXAMPLES (too vague, avoid these):\n" +
      "- goal='Understand how canvas pages are accessed' (starts with abstract verb)\n" +
      "- goal='understand' (single word, no context)\n" +
      "- goal='explore the authentication system' (vague verb + long sentence)\n" +
      "- goal='fix bug' (which bug? be specific)\n" +
      "- goal='authentication' (noun only, what about it?)\n\n" +
      "TOKEN OPTIMIZATION: Use 'compact: true' to reduce token consumption by ~95%. Returns only metadata (path, range, why, score) without preview field. " +
      "Combine with snippets.get for two-tier approach: first get candidate list (compact), then fetch selected content.\n\n" +
      "Example workflow:\n" +
      "  1. context_bundle({goal: 'auth handler', compact: true, limit: 10}) → ~2,500 tokens\n" +
      "  2. Review paths and scores from results\n" +
      "  3. snippets.get({path: result.context[0].path}) → Get only needed files\n" +
      "Total: ~5K tokens instead of 55K tokens (90% savings)\n\n" +
      "Returns ranked code snippets with explanations (e.g., 'phrase:page-agent', 'path-keyword:auth', 'dep:login.ts', 'boost:app-file') and automatically optimizes token usage.",
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
              description:
                "Path to the file currently being edited. Strongly recommended to provide for better context.",
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
      "Re-rank a list of file candidates by semantic similarity to a query text. Uses structural embeddings to compute similarity scores and combines them with existing scores. Use as a REFINEMENT step after files.search or when you have a list of candidates and want to prioritize them by semantic relevance. Not needed with context.bundle (which already does semantic ranking internally). Returns candidates sorted by combined score (base + semantic similarity). Example: after getting 20 search results, rerank them by semantic similarity to 'user authentication flow' to surface the most contextually relevant files.",
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
      "Search files by specific keywords or identifiers. Use when you know EXACT terms to search for: function names, class names, error messages, or code patterns.\n\n" +
      "IMPORTANT: For broader exploration like 'understand feature X' or 'how does Y work', use context.bundle instead. This tool is for TARGETED searches with specific identifiers.\n\n" +
      "✅ GOOD EXAMPLES (specific identifiers):\n" +
      "- query='validateToken' (exact function name)\n" +
      "- query='AuthenticationError' (specific class/error)\n" +
      "- query='Cannot read property' (exact error message)\n" +
      "- query='import { jwt }' (specific import pattern)\n" +
      "- query='userId' (variable name)\n\n" +
      "❌ BAD EXAMPLES (too vague or abstract):\n" +
      "- query='understand authentication' (use context.bundle instead)\n" +
      "- query='how login works' (use context.bundle instead)\n" +
      "- query='explore' (no specific target)\n" +
      "- query='auth' (too generic, will match too many files)\n\n" +
      "Supports filters: lang (e.g., 'typescript'), ext (e.g., '.ts'), path_prefix (e.g., 'src/auth/'). Returns matching files with previews and line numbers.",
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
      "Retrieve code snippets from a specific file path. Intelligently extracts relevant code sections using symbol boundaries (functions, classes, methods) when available. Use when you already know the exact file path and want to read its content efficiently without loading the entire file. Automatically selects appropriate snippet based on start_line or returns symbol-aligned chunks. Reduces token usage compared to reading full files. Use context.bundle instead if you don't know which file to read. Example: path='src/auth/login.ts' returns the most relevant function or class in that file.",
    inputSchema: {
      type: "object",
      required: ["path"],
      additionalProperties: true,
      properties: {
        path: { type: "string" },
        start_line: { type: "number", minimum: 0 },
        end_line: { type: "number", minimum: 0 },
      },
    },
  },
  {
    name: "deps_closure",
    description:
      "Traverse the dependency graph from a starting file. Finds all files that depend on the target (inbound) or that the target depends on (outbound). Essential for impact analysis: understanding what breaks if you change a file, tracing import chains, or mapping module relationships. Returns nodes (files/packages) and edges (import statements) with depth levels. Use when: planning refactoring, understanding module boundaries, finding circular dependencies, or analyzing affected files. Example: path='src/utils.ts', direction='inbound' shows all files importing utils.ts. Set max_depth to limit traversal (default 3).",
    inputSchema: {
      type: "object",
      required: ["path"],
      additionalProperties: true,
      properties: {
        path: { type: "string" },
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

function parseContextBundleParams(input: unknown): ContextBundleParams {
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

    // Show one-time warning about breaking change
    if (!compactWarningShown) {
      console.warn(
        "⚠️  BREAKING CHANGE (v0.8.0): compact mode is now default. " +
          "Set compact: false to restore previous behavior. " +
          "See CHANGELOG.md for details."
      );
      compactWarningShown = true;
    }
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
      const params = parseContextBundleParams(toolParams);
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
        return {
          hits: degrade.search(params.query, params.limit ?? 20).map((hit) => ({
            path: hit.path,
            preview: hit.preview,
            matchLine: hit.matchLine,
            lang: null,
            ext: null,
            score: 0,
          })),
          degrade: true,
        };
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
