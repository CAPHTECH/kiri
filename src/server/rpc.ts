import path from "node:path";

import packageJson from "../../package.json" with { type: "json" };
import {
  ADAPTIVE_K_CATEGORIES,
  ADAPTIVE_K_CATEGORY_ALIASES,
  ADAPTIVE_K_CATEGORY_SET,
} from "../shared/adaptive-k-categories.js";
import { maskValue } from "../shared/security/masker.js";

import { isValidBoostProfile, BOOST_PROFILES } from "./boost-profiles.js";
import { ServerContext } from "./context.js";
import { DegradeController } from "./fallbacks/degradeController.js";
import {
  ContextBundleParams,
  DepsClosureParams,
  FilesSearchParams,
  SemanticRerankParams,
  SnippetsGetParams,
  SnippetsGetView,
  contextBundle,
  depsClosure,
  filesSearch,
  semanticRerank,
  snippetsGet,
} from "./handlers.js";
import { MetricsRegistry } from "./observability/metrics.js";
import { withSpan } from "./observability/tracing.js";
import { OUTPUT_SCHEMAS } from "./output-schemas.js";
import { selectProfileFromQuery } from "./profile-selector.js";
import { generatePromptMessages, listPrompts } from "./prompts.js";
import { listResources, readResource } from "./resources.js";

const RESPONSE_MASK_SKIP_KEYS = ["path"];

/**
 * WarningManager - 警告メッセージの表示を管理するクラス
 *
 * 各警告を一度だけ表示するための状態管理を提供します。
 * グローバル変数を使わずにServerContextにカプセル化することで、
 * テスタビリティと並行性を改善します。
 *
 * メモリリーク防止のため、保持する警告キーの数に上限を設定しています。
 */
interface WarningManagerSharedState {
  shownWarnings: Set<string>;
  limitReachedWarningShown: { value: boolean };
}

export class WarningManager {
  private readonly shared: WarningManagerSharedState;
  private requestWarnings: string[] = []; // Per-request warning buffer
  private readonly maxUniqueWarnings: number;

  /**
   * WarningManagerを構築します
   *
   * @param maxUniqueWarnings - 追跡する一意の警告の最大数（デフォルト: 1000）
   */
  constructor(maxUniqueWarnings: number = 1000, sharedState?: WarningManagerSharedState) {
    this.maxUniqueWarnings = maxUniqueWarnings;
    this.shared = sharedState ?? {
      shownWarnings: new Set<string>(),
      limitReachedWarningShown: { value: false },
    };
  }

  /**
   * 共有状態を保ったまま、新しい WarningManager インスタンスを作成します。
   * リクエスト単位での警告管理に利用します。
   */
  fork(): WarningManager {
    return new WarningManager(this.maxUniqueWarnings, this.shared);
  }

  /**
   * 新しいリクエストコンテキストを開始し、前回のリクエストの警告をクリアします
   *
   * 各リクエストの開始時に呼び出す必要があります。
   */
  startRequest(): void {
    this.requestWarnings = [];
  }

  /**
   * 現在のリクエストの警告のみを取得します
   *
   * リクエスト間での警告の混入を防ぐため、配列のコピーを返します。
   */
  get responseWarnings(): string[] {
    return [...this.requestWarnings];
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
    if (this.shared.shownWarnings.has(key)) {
      return false;
    }

    // メモリリーク防止: 上限に達したら新しい警告を追加しない
    if (this.shared.shownWarnings.size >= this.maxUniqueWarnings) {
      if (!this.shared.limitReachedWarningShown.value) {
        console.warn(
          "WarningManager: Unique warning limit reached. No new warnings will be shown."
        );
        this.shared.limitReachedWarningShown.value = true;
      }
      return false;
    }

    console.warn(message);
    this.shared.shownWarnings.add(key);

    if (forResponse) {
      this.requestWarnings.push(message);
    }

    return true;
  }

  /**
   * リクエストごとに警告を表示します（サーバーライフタイムでの重複チェックなし）
   *
   * warnOnce()と異なり、この方法は毎回警告をレスポンスに追加します。
   * ユーザーが危険なリクエストを繰り返し送信する場合に、
   * 毎回通知する必要がある警告に使用します。
   *
   * リクエスト内での重複は排除され、同じキーの警告は1度だけ追加されます。
   *
   * @param key - 警告を識別するキー（ログ記録用）
   * @param message - 表示する警告メッセージ
   */
  warnForRequest(key: string, message: string): void {
    const keyPrefix = `[${key}]`;
    if (this.requestWarnings.some((warning) => warning.startsWith(keyPrefix))) {
      return;
    }

    const formattedMessage = `${keyPrefix} ${message}`;
    this.requestWarnings.push(formattedMessage);
    console.warn(formattedMessage);
  }

  /**
   * テスト用：表示済み警告の履歴をクリアします
   */
  reset(): void {
    this.shared.shownWarnings.clear();
    this.requestWarnings = [];
    this.shared.limitReachedWarningShown.value = false;
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
  outputSchema?: Record<string, unknown>; // MCP 2025-06-18: Structured Output対応
}

const SERVER_INFO = {
  name: "kiri",
  version: typeof packageJson?.version === "string" ? packageJson.version : "0.0.0",
} as const;

const TOOL_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: "context_bundle",
    description:
      "Primary code discovery tool. Provide a concrete, keyword-rich `goal` (modules, files, symptoms) to receive ranked `context` entries containing `path`, `range`, optional `preview`, scoring `why`, and `score`. Avoid leading with generic imperatives such as 'find' or 'locate'; list the signals you have instead.\n\n" +
      "Returns {context, tokens_estimate?, warnings?}; computing tokens_estimate is optional and should be requested explicitly when needed. Empty or vague goals raise an MCP error that asks for specific keywords, and imperative-only phrasing usually lowers ranking quality.\n\n" +
      "Example: context_bundle({goal: 'pagination off-by-one bug; file=src/catalog/products.ts; expected=20 items; observed=19'}) surfaces the affected files. Less effective: goal='Find where pagination breaks'.\n\n" +
      "Goal-crafting best practices (applies to every high-signal identifier, not only function names):\n" +
      "- List the crucial identifiers (functions, hooks, components, file names, config IDs, etc.) first so the highest-signal terms are always at the front.\n" +
      "- Stay within 3-5 concrete keywords (about 80 characters) to limit noise and keep scoring sharp.\n" +
      "- Keep generic errors or narration minimal; if you need them, append short suffixes or parentheses after the identifiers.\n" +
      "- Attach conditions or context as concise trailing phrases (e.g., 'conditional hook calls').\n\n" +
      "Before: 'Find where pagination breaks in React hooks error'\n" +
      "After: 'useOrdersPagination src/orders/pagination.ts offByOne (React hooks error)'.\n\n" +
      "boost_profile options:\n" +
      "- 'default': Prioritizes implementation files (src/app/, src/components/) over docs\n" +
      "- 'docs': Prioritizes documentation (.md, .yaml) over implementation  \n" +
      "- 'balanced': Equal weight for both docs and implementation\n" +
      "- 'none': No file type boosting, pure BM25/keyword scoring\n\n" +
      "Example: context_bundle({goal: 'state management design', boost_profile: 'balanced'})\n\n" +
      "Metadata filtering:\n" +
      "- Inline goal tokens such as `tag:observability`, `category:operations`, or `service:kiri` are stripped from the goal and applied as metadata hints so related docs surface alongside nearby implementation.\n" +
      "- Provide an explicit `metadata_filters` object (e.g., { tags: ['observability'], 'docmeta.category': 'operations' }) to enforce structured filters; string or string[] values are accepted.\n" +
      "- Supported prefixes include meta., metadata., docmeta., frontmatter., fm., yaml., and json., plus built-in aliases (tag/tags, category, service). `meta.*` behaves as a hint, while `docmeta.*`/`metadata.*` are strict doc-only filters.\n" +
      "- Metadata filters refine and prioritize candidates but still require a concise goal; use `docmeta.*` when you need docs-only matches and `meta.*` to keep surrounding implementation eligible.",
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
        includeTokensEstimate: {
          type: "boolean",
          description:
            "If true, computes the tokens_estimate field. This is slower and should be used only when you need projected token counts.",
        },
        profile: {
          type: "string",
          description: "Evaluation profile name (bugfix, testfail, refactor, typeerror, feature).",
        },
        boost_profile: {
          type: "string",
          enum: ["default", "docs", "balanced", "none", "code"],
          description:
            'File type boosting mode: "default" prioritizes implementation files (src/app/, src/components/), "code" strongly deprioritizes documentation and config files (95% penalty), "docs" prioritizes documentation (*.md), "balanced" applies equal weight to both docs and implementation, "none" disables boosting. Default is "default".',
        },
        path_prefix: {
          type: "string",
          pattern: "^(?!.*\\.\\.)[A-Za-z0-9_./\\-]+/?$",
          description:
            "Filter by path prefix (e.g., 'docs/', 'src/server/'). Path traversal ('..') is not allowed.",
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
        metadata_filters: {
          type: "object",
          additionalProperties: true,
          description:
            "Structured metadata filters applied in addition to the goal text. Keys may use prefixes (meta./metadata./docmeta./frontmatter./fm./yaml./json.) or aliases (tag/tags, category, service). Values can be strings or string arrays. Example: { tags: ['observability'], 'docmeta.category': 'operations' }.",
        },
        category: {
          type: "string",
          enum: [...ADAPTIVE_K_CATEGORIES],
          description:
            "Query category for adaptive K-value selection. Valid values: bugfix, testfail, debug, api, docs, feature, integration, performance. When provided, the system adjusts the number of results (K) based on typical needs for that category.",
        },
      },
    },
    outputSchema: OUTPUT_SCHEMAS.context_bundle,
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
    outputSchema: OUTPUT_SCHEMAS.semantic_rerank,
  },
  {
    name: "files_search",
    description:
      "Token-aware substring search for precise identifiers, error messages, or import fragments. Prefer this tool when you already know the exact string you need to locate; use `context_bundle` for exploratory work.\n\n" +
      "Returns an array of `{path, matchLine, lang, ext, score}` objects with optional `preview`; the tool never mutates the repo. Set `compact: true` to omit previews entirely for maximum token savings. Empty queries raise an MCP error unless `metadata_filters` are provided. If DuckDB is unavailable but the server runs with `--allow-degrade`, the same array shape is returned using filesystem-based fallbacks (with `lang`/`ext` set to null).\n\n" +
      'Example: files_search({query: "", metadata_filters: { "docmeta.category": "operations" }}) lists runbooks for the operations category. Invalid: files_search({}) reports that either query or metadata_filters must be supplied.\n\n' +
      "Metadata filtering:\n" +
      "- Inline `tag:` / `category:` / `service:` tokens are parsed out of the query and treated as metadata hints, so docs and neighboring implementation stay ranked together.\n" +
      "- The `metadata_filters` object accepts string or string[] values and supports the same prefixes/aliases as context_bundle (meta., metadata., docmeta., frontmatter., fm., yaml., json.). Use `docmeta.*` when you need doc-only matches; `meta.*` keeps implementations eligible.\n" +
      '- Either a textual query or `metadata_filters` (or both) is required. Metadata-only searches are supported (tests cover `query:""` + filters) and are ideal when discovering runbooks by tag/category.',
    inputSchema: {
      type: "object",
      required: [],
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
          enum: ["default", "docs", "balanced", "none", "code"],
          description:
            'File type boosting mode: "default" prioritizes implementation files (src/app/, src/components/), "code" strongly deprioritizes documentation and config files (95% penalty), "docs" prioritizes documentation (*.md), "balanced" applies equal weight to both docs and implementation, "none" disables boosting. Default is "default".',
        },
        compact: {
          type: "boolean",
          description:
            "If true, omits previews to minimize response tokens. Pair with snippets_get for detail-on-demand workflows.",
        },
        metadata_filters: {
          type: "object",
          additionalProperties: true,
          description:
            "Structured metadata filters targeting YAML front matter or JSON docs. Keys may use meta./metadata./docmeta./frontmatter./fm./yaml./json. prefixes or aliases (tag/tags, category, service). Values accept strings or arrays. Example: { tags: ['observability'], 'docmeta.id': 'runbook-002' }.",
        },
      },
    },
    outputSchema: OUTPUT_SCHEMAS.files_search,
  },
  {
    name: "snippets_get",
    description:
      "Focused snippet retrieval by file path. The tool uses recorded symbol boundaries to return the smallest readable span, or falls back to the requested line window.\n\n" +
      "Returns {path, startLine, endLine, totalLines, symbolName, symbolKind} with optional `content`. Set `compact: true` to omit content, or `include_line_numbers: true` to prefix each line with its number; this is a read-only lookup. Missing `path`, binary files, or absent index entries raise an MCP error with guidance to re-run the indexer.\n\n" +
      "Use the `view` parameter to control retrieval strategy:\n" +
      "- 'auto' (default): Uses symbol boundaries if available, falls back to line window\n" +
      "- 'symbol': Forces symbol-based snippets\n" +
      "- 'lines': Uses line-based retrieval (respects start_line/end_line, ignores symbols)\n" +
      "- 'full': Returns entire file from line 1 (start_line is ignored). Safety limit: 500 lines. If truncated, response includes `truncated: true`.\n\n" +
      "Example: snippets_get({path: 'src/auth/login.ts'}) surfaces the enclosing function. snippets_get({path: 'src/config.ts', view: 'full'}) returns entire file. Invalid: snippets_get({path: 'assets/logo.png'}) reports that binary snippets are unsupported.",
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
        compact: {
          type: "boolean",
          description:
            "If true, returns only metadata (path, range, totals, symbols) without content payload.",
        },
        include_line_numbers: {
          type: "boolean",
          description:
            "If true, prefixes each returned line with its line number (ignored when compact is true).",
        },
        view: {
          type: "string",
          enum: ["auto", "symbol", "lines", "full"],
          description:
            'Retrieval strategy: "auto" (default) uses symbol boundaries if available, "symbol" forces symbol-based snippets, "lines" uses line-based retrieval ignoring symbols, "full" returns entire file (up to 500 lines).',
        },
      },
    },
    outputSchema: OUTPUT_SCHEMAS.snippets_get,
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
    outputSchema: OUTPUT_SCHEMAS.deps_closure,
  },
];

const INITIALIZE_PAYLOAD = {
  protocolVersion: "2024-11-05",
  serverInfo: SERVER_INFO,
  capabilities: {
    tools: {},
    resources: {},
    prompts: {},
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

  // Validate and normalize path_prefix to prevent path traversal attacks
  if (typeof record.path_prefix === "string") {
    if (record.path_prefix.includes("..")) {
      throw new Error("path_prefix cannot contain '..' (path traversal not allowed)");
    }
    // Normalize: convert backslashes, remove leading slashes (consistent with parseContextBundleParams)
    const normalizedPrefix = path.posix
      .normalize(record.path_prefix.replace(/\\/g, "/"))
      .replace(/^\/+/, "");
    params.path_prefix = normalizedPrefix;
  }

  // Validate limit is within acceptable range
  if (limit !== undefined) {
    if (limit < 1 || limit > 200) {
      throw new Error("limit must be between 1 and 200");
    }
    params.limit = limit;
  }

  // Parse boost_profile parameter with dynamic selection support
  const boostProfile = record.boost_profile;
  const autoSelect = record.auto_select_profile === true;

  if (typeof boostProfile === "string") {
    // Explicit profile specified
    if (isValidBoostProfile(boostProfile)) {
      params.boost_profile = boostProfile;
    } else {
      throw new Error(
        `Invalid boost_profile: "${boostProfile}". ` +
          `Valid profiles are: ${Object.keys(BOOST_PROFILES).join(", ")}`
      );
    }
  } else if (autoSelect && typeof params.query === "string") {
    // Auto-select profile based on query text (for FilesSearch)
    params.boost_profile = selectProfileFromQuery(params.query, "default");
  }

  if (typeof record.compact === "boolean") {
    params.compact = record.compact;
  }

  if (record.metadata_filters && typeof record.metadata_filters === "object") {
    params.metadata_filters = record.metadata_filters as Record<string, string | string[]>;
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
  if (typeof record.compact === "boolean") params.compact = record.compact;
  const includeLineNumbersValue = record.includeLineNumbers ?? record.include_line_numbers;
  if (typeof includeLineNumbersValue === "boolean") {
    params.includeLineNumbers = includeLineNumbersValue;
  }
  // Parse view parameter with validation
  const validViews: SnippetsGetView[] = ["auto", "symbol", "lines", "full"];
  if (typeof record.view === "string") {
    if (validViews.includes(record.view as SnippetsGetView)) {
      params.view = record.view as SnippetsGetView;
    } else {
      throw new Error(`Invalid view: "${record.view}". Valid values are: ${validViews.join(", ")}`);
    }
  }
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
    if (Array.isArray(artifactsRecord.hints)) {
      const hints = artifactsRecord.hints
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value): value is string => value.length > 0);
      if (hints.length > 0) {
        artifacts.hints = hints;
      }
    }
    if (
      artifacts.editing_path ||
      artifacts.failing_tests ||
      artifacts.last_diff ||
      (artifacts.hints && artifacts.hints.length > 0)
    ) {
      params.artifacts = artifacts;
    }
  }

  if (typeof record.profile === "string") {
    params.profile = record.profile;
  }

  // Parse boost_profile parameter
  const boostProfile = record.boost_profile;
  if (typeof boostProfile === "string") {
    if (isValidBoostProfile(boostProfile)) {
      params.boost_profile = boostProfile;
    } else {
      throw new Error(
        `Invalid boost_profile: "${boostProfile}". ` +
          `Valid profiles are: ${Object.keys(BOOST_PROFILES).join(", ")}`
      );
    }
  }

  if (typeof record.path_prefix === "string") {
    if (record.path_prefix.includes("..")) {
      throw new Error("path_prefix cannot contain '..' (path traversal not allowed)");
    }
    const normalizedPrefix = path.posix
      .normalize(record.path_prefix.replace(/\\/g, "/"))
      .replace(/^\/+/, "");
    params.path_prefix = normalizedPrefix;
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

  const includeTokensEstimate = record.includeTokensEstimate ?? record.include_tokens_estimate;
  if (typeof includeTokensEstimate === "boolean") {
    params.includeTokensEstimate = includeTokensEstimate;
  }

  if (record.metadata_filters && typeof record.metadata_filters === "object") {
    params.metadata_filters = record.metadata_filters as Record<string, string | string[]>;
  }

  // Parse category parameter for AdaptiveK
  if (typeof record.category === "string") {
    const trimmedCategory = record.category.trim();
    if (trimmedCategory.length > 0) {
      const normalizedCategory = ADAPTIVE_K_CATEGORY_ALIASES[trimmedCategory] ?? trimmedCategory;
      if (ADAPTIVE_K_CATEGORY_SET.has(normalizedCategory)) {
        params.category = normalizedCategory;
      } else {
        context.warningManager.warnForRequest(
          "category-invalid",
          `category "${trimmedCategory}" is not supported. Valid values: ${ADAPTIVE_K_CATEGORIES.join(
            ", "
          )}. The value was ignored.`
        );
      }
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

// MCP standard tool result format (MCP 2025-06-18: Structured Output対応)
interface McpToolResult {
  content: Array<{
    type: "text";
    text: string;
  }>;
  structuredContent?: unknown; // MCP 2025-06-18: 構造化レスポンス
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
        // Use same output option logic as normal mode for consistency
        const includePreview = params.compact !== true;
        const results = degrade.search(params.query, params.limit ?? 20).map((hit) => {
          const result = {
            path: hit.path,
            matchLine: hit.matchLine,
            lang: null,
            ext: null,
            score: 0,
          };
          return includePreview ? { ...result, preview: hit.preview } : result;
        });
        // MCP outputSchema requires type="object" at top level
        return { results };
      } else {
        const handler = async () => {
          const results = await withSpan(
            "files_search",
            async () => await filesSearch(context, params)
          );
          // MCP outputSchema requires type="object" at top level
          return { results };
        };
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
  const buildRequestContext = (): ServerContext => {
    const warningManager = context.warningManager.fork();
    warningManager.startRequest();
    return { ...context, warningManager };
  };
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
            db: context.databasePath ? path.resolve(context.databasePath) : undefined,
            repo: context.repoPath ? path.resolve(context.repoPath) : undefined,
          };
          break;
        }
        case "tools/list": {
          // MCP standard format: tools array without nextCursor (no pagination)
          // Note: outputSchemaを除外してレスポンスサイズを削減（Claude Code互換性のため）
          // outputSchemaは17KB超のJSONとなり、Claude CodeのMCPクライアントでパースエラーを起こす
          const toolsWithoutOutputSchema = TOOL_DESCRIPTORS.map(
            ({ outputSchema: _unused, ...rest }) => rest
          );
          result = { tools: toolsWithoutOutputSchema };
          break;
        }
        case "resources/list": {
          // MCP standard format: resources array without pagination
          const repoPath = context.repoPath ?? "";
          const resources = repoPath ? await listResources(repoPath) : [];
          result = { resources };
          break;
        }
        case "resources/read": {
          // MCP standard format: resource contents
          const repoPath = context.repoPath ?? "";
          if (!repoPath) {
            return hasResponseId
              ? {
                  statusCode: 500,
                  response: errorResponse(
                    payload.id as string | number,
                    "Repository path is not configured. Cannot read resources.",
                    -32603
                  ),
                }
              : null;
          }

          const paramsRecord = payload.params as Record<string, unknown> | null | undefined;
          if (!paramsRecord || typeof paramsRecord !== "object") {
            return hasResponseId
              ? {
                  statusCode: 400,
                  response: errorResponse(
                    payload.id as string | number,
                    "Invalid params for resources/read. Provide uri parameter.",
                    -32602
                  ),
                }
              : null;
          }

          const resourceUri = paramsRecord.uri;
          if (typeof resourceUri !== "string") {
            return hasResponseId
              ? {
                  statusCode: 400,
                  response: errorResponse(
                    payload.id as string | number,
                    "Invalid params for resources/read. Resource uri must be a string.",
                    -32602
                  ),
                }
              : null;
          }

          try {
            const resourceResult = await readResource(
              resourceUri,
              repoPath,
              context.db,
              context.repoId
            );
            result = resourceResult;
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : "Failed to read resource.";
            return hasResponseId
              ? {
                  statusCode: 404,
                  response: errorResponse(payload.id as string | number, errorMessage, -32602),
                }
              : null;
          }
          break;
        }
        case "prompts/list": {
          // MCP standard format: prompts array
          // repoPathが未設定の場合は空配列を返す
          const repoPath = context.repoPath ?? "";
          const prompts = repoPath ? await listPrompts(repoPath) : [];
          result = { prompts };
          break;
        }
        case "prompts/get": {
          // MCP standard format: prompt messages
          const repoPath = context.repoPath ?? "";
          if (!repoPath) {
            return hasResponseId
              ? {
                  statusCode: 500,
                  response: errorResponse(
                    payload.id as string | number,
                    "Repository path is not configured. Cannot retrieve prompts.",
                    -32603
                  ),
                }
              : null;
          }

          const paramsRecord = payload.params as Record<string, unknown> | null | undefined;
          if (!paramsRecord || typeof paramsRecord !== "object") {
            return hasResponseId
              ? {
                  statusCode: 400,
                  response: errorResponse(
                    payload.id as string | number,
                    "Invalid params for prompts/get. Provide name parameter.",
                    -32602
                  ),
                }
              : null;
          }

          const promptName = paramsRecord.name;
          if (typeof promptName !== "string") {
            return hasResponseId
              ? {
                  statusCode: 400,
                  response: errorResponse(
                    payload.id as string | number,
                    "Invalid params for prompts/get. Prompt name must be a string.",
                    -32602
                  ),
                }
              : null;
          }

          const promptArgs = (paramsRecord.arguments ?? {}) as Record<string, string>;
          const promptResult = await generatePromptMessages(promptName, promptArgs, repoPath);

          if (!promptResult) {
            return hasResponseId
              ? {
                  statusCode: 404,
                  response: errorResponse(
                    payload.id as string | number,
                    `Prompt '${promptName}' not found. Use prompts/list to see available prompts.`,
                    -32602
                  ),
                }
              : null;
          }

          result = promptResult;
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
          const scopedContext = buildRequestContext();

          try {
            const toolResult = await executeToolByName(
              toolName,
              toolArguments,
              scopedContext,
              degrade,
              allowDegrade
            );

            // Convert to MCP standard format (MCP 2025-06-18: Structured Output対応)
            const mcpResult: McpToolResult = {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(toolResult, null, 2),
                },
              ],
              structuredContent: toolResult, // MCP 2025-06-18: 構造化レスポンス
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
          const scopedContext = buildRequestContext();
          try {
            result = await executeToolByName(
              "context_bundle",
              payload.params,
              scopedContext,
              degrade,
              allowDegrade
            );
          } catch (error) {
            console.error("context_bundle execution error:", error);
            throw error;
          }
          break;
        }
        case "semantic_rerank": {
          const scopedContext = buildRequestContext();
          result = await executeToolByName(
            "semantic_rerank",
            payload.params,
            scopedContext,
            degrade,
            allowDegrade
          );
          break;
        }
        case "files_search": {
          const scopedContext = buildRequestContext();
          result = await executeToolByName(
            "files_search",
            payload.params,
            scopedContext,
            degrade,
            allowDegrade
          );
          break;
        }
        case "snippets_get": {
          const scopedContext = buildRequestContext();
          result = await executeToolByName(
            "snippets_get",
            payload.params,
            scopedContext,
            degrade,
            allowDegrade
          );
          break;
        }
        case "deps_closure": {
          const scopedContext = buildRequestContext();
          result = await executeToolByName(
            "deps_closure",
            payload.params,
            scopedContext,
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
      const masked = maskValue(result, { tokens, skipKeys: RESPONSE_MASK_SKIP_KEYS });
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
