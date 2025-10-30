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

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: unknown;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: unknown;
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
    name: "context.bundle",
    description:
      "Extract relevant code context based on task goals. Use this first when starting new tasks, fixing bugs, or understanding features - it minimizes token usage by returning only relevant snippets.",
    inputSchema: {
      type: "object",
      required: ["goal"],
      additionalProperties: true,
      properties: {
        goal: { type: "string", description: "Description of the task or goal to accomplish." },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 20,
          description: "Maximum number of snippets to return. Default is 12.",
        },
        profile: { type: "string", description: "Evaluation profile name." },
        boost_profile: {
          type: "string",
          enum: ["default", "docs", "none"],
          description:
            'File type boosting mode: "default" prioritizes implementation files (src/*.ts), "docs" prioritizes documentation (*.md), "none" disables boosting. Default is "default".',
        },
        artifacts: {
          type: "object",
          additionalProperties: true,
          properties: {
            editing_path: {
              type: "string",
              description: "Path to the file currently being edited.",
            },
            failing_tests: {
              type: "array",
              items: { type: "string" },
              description: "Names of failing test cases.",
            },
            last_diff: { type: "string", description: "Recent diff content." },
          },
        },
      },
    },
  },
  {
    name: "semantic.rerank",
    description:
      "Re-rank candidates by semantic similarity. Use this to refine search results or prioritize files by relevance to a query.",
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
    name: "files.search",
    description:
      "Search files by keyword using full-text index. Use this to find implementation patterns, specific functions, or explore unfamiliar code areas.",
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: true,
      properties: {
        query: { type: "string" },
        lang: { type: "string" },
        ext: { type: "string" },
        path_prefix: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 200 },
        boost_profile: {
          type: "string",
          enum: ["default", "docs", "none"],
          description:
            'File type boosting mode: "default" prioritizes implementation files (src/*.ts), "docs" prioritizes documentation (*.md), "none" disables boosting. Default is "default".',
        },
      },
    },
  },
  {
    name: "snippets.get",
    description:
      "Retrieve code snippets from a specific file. Use this to read only the necessary parts instead of entire files, reducing token usage.",
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
    name: "deps.closure",
    description:
      "Get dependency graph neighbors. Use this to understand impact scope when refactoring, or to trace call chains and module relationships.",
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

export function successResponse(id: unknown, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

export function errorResponse(id: unknown, message: string, code = -32603): JsonRpcError {
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
    case "context.bundle": {
      const params = parseContextBundleParams(toolParams);
      const handler = async () =>
        await withSpan("context.bundle", async () => await contextBundle(context, params));
      return await degrade.withResource(handler, "duckdb:context.bundle");
    }
    case "semantic.rerank": {
      const params = parseSemanticRerankParams(toolParams);
      const handler = async () =>
        await withSpan("semantic.rerank", async () => await semanticRerank(context, params));
      return await degrade.withResource(handler, "duckdb:semantic.rerank");
    }
    case "files.search": {
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
          await withSpan("files.search", async () => await filesSearch(context, params));
        return await degrade.withResource(handler, "duckdb:files.search");
      }
    }
    case "snippets.get": {
      const params = parseSnippetsGetParams(toolParams);
      const handler = async () =>
        await withSpan("snippets.get", async () => await snippetsGet(context, params));
      return await degrade.withResource(handler, "duckdb:snippets.get");
    }
    case "deps.closure": {
      const params = parseDepsClosureParams(toolParams);
      const handler = async () =>
        await withSpan("deps.closure", async () => await depsClosure(context, params));
      return await degrade.withResource(handler, "duckdb:deps.closure");
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

export function createRpcHandler(
  dependencies: RpcHandlerDependencies
): (payload: JsonRpcRequest) => Promise<RpcHandleResult> {
  const { context, degrade, metrics, tokens, allowDegrade } = dependencies;
  return async (payload: JsonRpcRequest): Promise<RpcHandleResult> => {
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
        case "tools/call": {
          // MCP standard tool invocation
          const paramsRecord = payload.params as Record<string, unknown> | null | undefined;
          if (!paramsRecord || typeof paramsRecord !== "object") {
            return {
              statusCode: 400,
              response: errorResponse(
                payload.id ?? null,
                "Invalid params for tools/call. Provide name and arguments.",
                -32602
              ),
            };
          }

          const toolName = paramsRecord.name;
          if (typeof toolName !== "string") {
            return {
              statusCode: 400,
              response: errorResponse(
                payload.id ?? null,
                "Invalid params for tools/call. Tool name must be a string.",
                -32602
              ),
            };
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
        case "context.bundle": {
          result = await executeToolByName(
            "context.bundle",
            payload.params,
            context,
            degrade,
            allowDegrade
          );
          break;
        }
        case "semantic.rerank": {
          result = await executeToolByName(
            "semantic.rerank",
            payload.params,
            context,
            degrade,
            allowDegrade
          );
          break;
        }
        case "files.search": {
          result = await executeToolByName(
            "files.search",
            payload.params,
            context,
            degrade,
            allowDegrade
          );
          break;
        }
        case "snippets.get": {
          result = await executeToolByName(
            "snippets.get",
            payload.params,
            context,
            degrade,
            allowDegrade
          );
          break;
        }
        case "deps.closure": {
          result = await executeToolByName(
            "deps.closure",
            payload.params,
            context,
            degrade,
            allowDegrade
          );
          break;
        }
        default: {
          return {
            statusCode: 404,
            response: errorResponse(
              payload.id ?? null,
              "Requested method is not available. Use tools/call, or legacy methods: context.bundle, semantic.rerank, files.search, snippets.get, or deps.closure.",
              -32601
            ),
          };
        }
      }
      const masked = maskValue(result, { tokens });
      if (masked.applied > 0) {
        metrics.recordMask(masked.applied);
      }
      return {
        statusCode: 200,
        response: successResponse(payload.id ?? null, masked.masked),
      };
    } catch (error) {
      if (degrade.current.active && !allowDegrade) {
        return {
          statusCode: 503,
          response: errorResponse(
            payload.id ?? null,
            "Backend degraded and --allow-degrade not set. Restore DuckDB availability or restart server."
          ),
        };
      }
      if (degrade.current.active && allowDegrade) {
        return {
          statusCode: 503,
          response: errorResponse(
            payload.id ?? null,
            degrade.current.reason
              ? `Backend degraded due to ${degrade.current.reason}. Only files.search is operational.`
              : "Backend degraded. Only files.search is operational."
          ),
        };
      }
      const message =
        error instanceof Error
          ? error.message
          : "Unknown error occurred. Inspect server logs and retry the request.";
      return {
        statusCode: 500,
        response: errorResponse(payload.id ?? null, message),
      };
    }
  };
}
