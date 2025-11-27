import fs from "node:fs";
import path from "node:path";

import { checkFTSSchemaExists } from "../indexer/schema.js";
import { getAdaptiveK } from "../shared/adaptive-k.js";
import { DuckDBClient } from "../shared/duckdb.js";
import { generateEmbedding, structuralSimilarity } from "../shared/embedding.js";
import { encode as encodeGPT, tokenizeText } from "../shared/tokenizer.js";

import { expandAbbreviations } from "./abbreviations.js";
import {
  type BoostProfileName,
  type BoostProfileConfig,
  type PathMultiplier,
  getBoostProfile,
} from "./boost-profiles.js";
import { loadPathPenalties, mergePathPenaltyEntries } from "./config-loader.js";
import { loadServerConfig } from "./config.js";
import { FtsStatusCache, ServerContext, TableAvailability } from "./context.js";
import type { DomainFileHint } from "./domain-terms.js";
import { createIdfProvider } from "./idf-provider.js";
import { coerceProfileName, loadScoringProfile, type ScoringWeights } from "./scoring.js";
import { createServerServices, ServerServices } from "./services/index.js";
import { loadStopWords, type StopWordsService } from "./stop-words.js";

// Re-export extracted handlers for backward compatibility
export {
  snippetsGet,
  type SnippetsGetParams,
  type SnippetResult,
} from "./handlers/snippets-get.js";

// Configuration file patterns (v0.8.0+: consolidated to avoid duplication)
// Comprehensive list covering multiple languages and tools
const CONFIG_FILES = [
  // JavaScript/TypeScript/Node.js
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "tsconfig.json",
  "jsconfig.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",

  // Python
  "requirements.txt",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "Pipfile",
  "Pipfile.lock",
  "poetry.lock",
  "pytest.ini",
  "tox.ini",
  ".python-version",

  // Ruby
  "Gemfile",
  "Gemfile.lock",
  ".ruby-version",
  "Rakefile",

  // Go
  "go.mod",
  "go.sum",
  "Makefile",

  // PHP
  "composer.json",
  "composer.lock",
  "phpunit.xml",

  // Java/Kotlin/Gradle/Maven
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.properties",

  // Rust
  "Cargo.toml",
  "Cargo.lock",

  // Swift
  "Package.swift",
  "Package.resolved",

  // .NET
  "packages.lock.json",
  "global.json",

  // C/C++
  "CMakeLists.txt",
  "Makefile.am",
  "configure.ac",

  // Docker
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".dockerignore",

  // CI/CD
  ".travis.yml",
  ".gitlab-ci.yml",
  "Jenkinsfile",
  "azure-pipelines.yml",

  // Git
  ".gitignore",
  ".gitattributes",
  ".gitmodules",

  // Editor config
  ".editorconfig",

  // Webserver config
  "Caddyfile",
  "nginx.conf",
  ".htaccess",
  "httpd.conf",
  "apache2.conf",
  "lighttpd.conf",
] as const;

// Configuration directories (files inside these directories are treated as config)
// Note: No trailing slashes - exact segment matching prevents false positives
const CONFIG_DIRECTORIES = [
  "bootstrap", // Laravel/Symfony framework bootstrap
  "config", // Generic config directory (all frameworks)
  "migrations", // Database migrations
  "db/migrate", // Ruby on Rails migrations
  "alembic/versions", // Python Alembic migrations
  "seeds", // Database seeds
  "fixtures", // Test fixtures
  "test-data", // Test data
  "locales", // i18n translations
  "i18n", // i18n translations
  "translations", // i18n translations
  "lang", // i18n translations
  ".terraform", // Terraform state
  "terraform", // Terraform configs
  "k8s", // Kubernetes manifests
  "kubernetes", // Kubernetes manifests
  "ansible", // Ansible playbooks
  "cloudformation", // CloudFormation templates
  "pulumi", // Pulumi infrastructure
] as const;

const CONFIG_EXTENSIONS = [".lock", ".env", ".conf"] as const;

const CONFIG_PATTERNS = [
  // Generic config patterns (any language)
  ".config.js",
  ".config.ts",
  ".config.mjs",
  ".config.cjs",
  ".config.json",
  ".config.yaml",
  ".config.yml",
  ".config.toml",

  // Linter/Formatter configs
  ".eslintrc",
  ".prettierrc",
  ".stylelintrc",
  ".pylintrc",
  ".flake8",
  ".rubocop.yml",

  // CI config files
  ".circleci/config.yml",
  ".github/workflows",
] as const;

const FTS_STATUS_CACHE_TTL_MS = 10_000;

type MetadataSourceTag = "front_matter" | "yaml" | "json" | undefined;

interface MetadataFilter {
  key: string;
  values: string[];
  source?: MetadataSourceTag;
  strict?: boolean;
}

interface MetadataEntry {
  key: string;
  value: string;
  source: MetadataSourceTag;
}

const METADATA_ALIAS_MAP = new Map<
  string,
  { key: string; source?: MetadataSourceTag; strict?: boolean }
>([
  ["tag", { key: "tags" }],
  ["tags", { key: "tags" }],
  ["category", { key: "category" }],
  ["title", { key: "title" }],
  ["service", { key: "service" }],
]);

const METADATA_KEY_PREFIXES: Array<{
  prefix: string;
  source?: MetadataSourceTag;
  strict?: boolean;
}> = [
  { prefix: "meta." },
  { prefix: "metadata.", strict: true },
  { prefix: "docmeta.", strict: true },
  { prefix: "frontmatter.", source: "front_matter" },
  { prefix: "fm.", source: "front_matter" },
  { prefix: "yaml.", source: "yaml" },
  { prefix: "json.", source: "json" },
];

const METADATA_MATCH_WEIGHT = 0.15;
const METADATA_FILTER_MATCH_WEIGHT = 0.1;
const METADATA_HINT_BONUS = 0.25;
const INBOUND_LINK_WEIGHT = 0.2;

/**
 * checkTableAvailability
 *
 * 起動時にテーブルの存在を確認し、TableAvailabilityオブジェクトを生成する。
 * これにより、グローバルミュータブル変数による競合状態を回避する。
 *
 * NOTE: スキーマ変更（テーブル追加）後はサーバーの再起動が必要です。
 *
 * @param db - DuckDBClient インスタンス
 * @returns TableAvailability オブジェクト
 * @throws データベース接続エラー等、テーブル不在以外のエラーが発生した場合
 */
export async function checkTableAvailability(db: DuckDBClient): Promise<TableAvailability> {
  const ALLOWED_TABLES = [
    "document_metadata_kv",
    "markdown_link",
    "hint_expansion",
    "hint_dictionary",
  ] as const;

  const checkTable = async (tableName: (typeof ALLOWED_TABLES)[number]): Promise<boolean> => {
    if (!ALLOWED_TABLES.includes(tableName)) {
      throw new Error(`Invalid table name: ${tableName}`);
    }

    try {
      await db.all(`SELECT 1 FROM ${tableName} LIMIT 0`);
      return true;
    } catch (error) {
      // テーブル不在エラーのみキャッチ
      if (isTableMissingError(error, tableName)) {
        return false;
      }
      // その他のエラー（接続エラー等）は再スロー
      throw new Error(
        `Failed to check table availability for ${tableName}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const result = {
    hasMetadataTables: await checkTable("document_metadata_kv"),
    hasLinkTable: await checkTable("markdown_link"),
    hasHintLog: await checkTable("hint_expansion"),
    hasHintDictionary: await checkTable("hint_dictionary"),
  };

  // 起動時警告: テーブルが存在しない場合に通知
  if (!result.hasMetadataTables) {
    console.warn(
      "document_metadata_kv table is missing. Metadata filters and boosts disabled until database is upgraded."
    );
  }
  if (!result.hasLinkTable) {
    console.warn(
      "markdown_link table is missing. Inbound link boosting disabled until database is upgraded."
    );
  }
  if (!result.hasHintLog) {
    console.warn(
      "hint_expansion table is missing. Hint logging disabled. Enable the latest schema and rerun the indexer to capture hint logs."
    );
  }
  if (!result.hasHintDictionary) {
    console.warn(
      "hint_dictionary table is missing. Dictionary hints disabled. Run scripts/diag/build-hint-dictionary.ts after upgrading the schema."
    );
  }

  return result;
}

async function hasDirtyRepos(db: DuckDBClient): Promise<boolean> {
  const statusCheck = await db.all<{ count: number }>(
    `SELECT COUNT(*) as count FROM repo
       WHERE fts_dirty = true OR fts_status IN ('dirty', 'rebuilding')`
  );
  return (statusCheck[0]?.count ?? 0) > 0;
}

async function refreshFtsStatus(context: ServerContext): Promise<FtsStatusCache> {
  const previousReady = context.features?.fts ?? false;
  const cache: FtsStatusCache = {
    ready: false,
    schemaExists: false,
    anyDirty: false,
    lastChecked: Date.now(),
  };

  try {
    cache.schemaExists = await checkFTSSchemaExists(context.db);
    if (!cache.schemaExists) {
      context.warningManager.warnForRequest(
        "fts-schema-missing",
        "FTS schema not found, falling back to ILIKE"
      );
    } else {
      cache.anyDirty = await hasDirtyRepos(context.db);
      if (cache.anyDirty) {
        context.warningManager.warnForRequest(
          "fts-stale",
          "FTS index is stale or rebuilding, using ILIKE fallback. Run indexer to update FTS."
        );
      } else {
        await context.db.run("LOAD fts;");
        cache.ready = true;
      }
    }
  } catch (error) {
    cache.ready = false;
    cache.schemaExists = false;
    context.warningManager.warnForRequest(
      "fts-check-failed",
      `FTS availability check failed: ${error}`
    );
  }

  if (!context.features) {
    context.features = {};
  }
  context.features.fts = cache.ready;
  context.ftsStatusCache = cache;

  if (cache.ready && !previousReady) {
    console.info("✅ FTS recovered and enabled");
  } else if (!cache.ready && previousReady) {
    console.warn("⚠️  FTS became unavailable; falling back to ILIKE");
  }

  return cache;
}

async function getFreshFtsStatus(context: ServerContext): Promise<FtsStatusCache> {
  const cache = context.ftsStatusCache;
  if (cache && Date.now() - cache.lastChecked < FTS_STATUS_CACHE_TTL_MS) {
    if (cache.ready) {
      const dirtyNow = await hasDirtyRepos(context.db);
      if (dirtyNow) {
        return refreshFtsStatus(context);
      }
    }
    return cache;
  }
  return refreshFtsStatus(context);
}

/**
 * Check if a file path represents a configuration file
 * Supports multiple languages: JS/TS, Python, Ruby, Go, PHP, Java, Rust, C/C++, Docker, CI/CD
 * Also checks if file is in a config directory (bootstrap/, config/, migrations/, etc.)
 * Uses exact path segment matching to prevent false positives (e.g., "myconfig/" won't match "config/")
 * @param path - Full file path
 * @param fileName - File name only (extracted from path)
 * @returns true if the file is a configuration file
 */
function isConfigFile(path: string, fileName: string): boolean {
  // Normalize path separators (Windows compatibility)
  const normalizedPath = path.replace(/\\/g, "/");

  // Check if file is in a config directory using exact path segment matching
  // Split path into segments and check for exact matches to prevent false positives
  // e.g., "bootstrap" won't match "my-bootstrap-theme" in path segments
  // Filter empty strings to handle absolute paths (e.g., "/src/app" → ["", "src", "app"] → ["src", "app"])
  const pathSegments = new Set(normalizedPath.split("/").filter(Boolean));
  const isInConfigDirectory = (CONFIG_DIRECTORIES as readonly string[]).some((dir) =>
    pathSegments.has(dir)
  );

  return (
    (CONFIG_FILES as readonly string[]).includes(fileName) ||
    CONFIG_EXTENSIONS.some((ce) => path.endsWith(ce)) ||
    CONFIG_PATTERNS.some((pattern) => path.includes(pattern)) ||
    fileName.startsWith(".env") ||
    isInConfigDirectory
  );
}

export interface FilesSearchParams {
  query: string;
  lang?: string;
  ext?: string;
  path_prefix?: string;
  limit?: number;
  boost_profile?: BoostProfileName;
  compact?: boolean; // If true, omit preview to reduce token usage
  metadata_filters?: Record<string, string | string[]>;
}

export interface FilesSearchResult {
  path: string;
  preview?: string;
  matchLine: number;
  lang: string | null;
  ext: string | null;
  score: number;
}

// SnippetsGetParams and SnippetResult are now exported from ./handlers/snippets-get.js

export interface ContextBundleArtifacts {
  editing_path?: string;
  failing_tests?: string[];
  last_diff?: string;
  hints?: string[];
}

export interface ContextBundleParams {
  goal: string;
  artifacts?: ContextBundleArtifacts;
  limit?: number;
  profile?: string;
  boost_profile?: BoostProfileName;
  compact?: boolean; // If true, omit preview field to reduce token usage
  includeTokensEstimate?: boolean; // If true, compute tokens_estimate (slower)
  metadata_filters?: Record<string, string | string[]>;
  requestId?: string; // Optional request ID for tracing/debugging
  path_prefix?: string;
  category?: string; // Query category for adaptive K (bugfix, testfail, etc.)
}

export interface ContextBundleItem {
  path: string;
  range: [number, number];
  preview?: string; // Omitted when compact: true
  why: string[];
  score: number;
}

export interface ContextBundleResult {
  context: ContextBundleItem[];
  tokens_estimate?: number;
  warnings?: string[]; // Client-visible warnings (e.g., breaking changes, deprecations)
}

function normalizeArtifactHints(hints?: string[]): string[] {
  if (!Array.isArray(hints)) {
    return [];
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const rawHint of hints) {
    if (typeof rawHint !== "string") {
      continue;
    }
    const trimmed = rawHint.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    normalized.push(trimmed);
    seen.add(trimmed);
    if (normalized.length >= MAX_ARTIFACT_HINTS) {
      break;
    }
  }
  return normalized;
}

interface ArtifactHintBuckets {
  pathHints: string[];
  substringHints: string[];
}

function bucketArtifactHints(hints: string[]): ArtifactHintBuckets {
  const buckets: ArtifactHintBuckets = {
    pathHints: [],
    substringHints: [],
  };
  for (const hint of hints) {
    if (hint.includes("/") && SAFE_PATH_PATTERN.test(hint)) {
      buckets.pathHints.push(hint);
      continue;
    }
    const normalized = hint.trim().toLowerCase();
    if (normalized.length >= 3) {
      buckets.substringHints.push(normalized);
    }
  }
  return buckets;
}

function selectDomainPathHints(hints: DomainFileHint[]): DomainFileHint[] {
  const selected: DomainFileHint[] = [];
  for (const hint of hints) {
    if (!SAFE_PATH_PATTERN.test(hint.path)) {
      continue;
    }
    if (selected.some((entry) => entry.path === hint.path)) {
      continue;
    }
    selected.push(hint);
    if (selected.length >= DOMAIN_PATH_HINT_LIMIT) {
      break;
    }
  }
  return selected;
}

/**
 * AdaptiveK用カテゴリ自動検出
 *
 * 優先順位:
 * 1. params.categoryが明示的に指定されている場合はそれを使用
 * 2. profile/artifacts/boost_profileから推論
 *
 * @param params - context_bundleのパラメータ
 * @returns 検出されたカテゴリ（undefined = デフォルトK値を使用）
 */
function determineCategory(params: ContextBundleParams): string | undefined {
  // 明示的に指定されている場合はそれを優先
  if (params.category) {
    return params.category;
  }

  const { profile, boost_profile, artifacts } = params;

  // artifacts.failing_testsがある場合はデバッグ作業
  if (artifacts?.failing_tests && artifacts.failing_tests.length > 0) {
    return "debug";
  }

  // profileからの推論
  if (profile === "testfail") {
    return "testfail";
  }
  if (profile === "bugfix" || profile === "typeerror") {
    return "debug";
  }
  if (profile === "refactor") {
    return "api";
  }
  if (profile === "feature") {
    return "feature";
  }

  // boost_profileからの推論
  if (boost_profile === "docs") {
    return "docs";
  }

  // artifacts.editing_pathからの推論
  if (artifacts?.editing_path) {
    const editingPath = artifacts.editing_path.toLowerCase();
    // テストファイルを編集中 → debug
    if (
      editingPath.includes(".test.") ||
      editingPath.includes(".spec.") ||
      editingPath.includes("__tests__")
    ) {
      return "debug";
    }
    // ドキュメントを編集中 → docs
    if (editingPath.endsWith(".md") || editingPath.includes("/docs/")) {
      return "docs";
    }
  }

  // 推論できない場合はundefined（kDefaultを使用）
  return undefined;
}

type HintOrigin = "artifact" | "dictionary";

interface ResolvedPathHint {
  path: string;
  sourceHint: string;
  origin: HintOrigin;
}

interface HintSeedMeta {
  sourceHint: string;
  origin: HintOrigin;
}

type HintExpansionKind = "path" | "dictionary" | "directory" | "dependency" | "substring";

function isMissingTableError(error: unknown, table: string): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /Table with name/i.test(error.message) && error.message.includes(table);
}

async function logHintExpansionEntry(
  db: DuckDBClient,
  tableAvailability: TableAvailability,
  entry: {
    repoId: number;
    hintValue: string;
    kind: HintExpansionKind;
    targetPath?: string;
    payload?: Record<string, unknown>;
  }
): Promise<void> {
  if (!HINT_LOG_ENABLED) {
    return;
  }
  if (!tableAvailability.hasHintLog) {
    return;
  }
  try {
    await db.run(
      `
        INSERT INTO hint_expansion (repo_id, hint_value, expansion_kind, target_path, payload)
        VALUES (?, ?, ?, ?, ?)
      `,
      [
        entry.repoId,
        entry.hintValue,
        entry.kind,
        entry.targetPath ?? null,
        entry.payload ? JSON.stringify(entry.payload) : null,
      ]
    );
  } catch (error) {
    if (isMissingTableError(error, "hint_expansion")) {
      console.warn(
        "hint_expansion table is missing in the active database. Enable the latest schema and rerun the indexer to capture hint logs."
      );
      return;
    }
    throw error;
  }
}

async function fetchDictionaryPathHints(
  db: DuckDBClient,
  tableAvailability: TableAvailability,
  repoId: number,
  hints: string[],
  perHintLimit: number
): Promise<ResolvedPathHint[]> {
  if (!HINT_DICTIONARY_ENABLED || perHintLimit <= 0 || hints.length === 0) {
    return [];
  }
  if (!tableAvailability.hasHintDictionary) {
    return [];
  }
  const uniqueHints = Array.from(new Set(hints));
  const targets: ResolvedPathHint[] = [];
  for (const hint of uniqueHints) {
    let rows: { target_path: string }[] = [];
    try {
      rows = await db.all<{ target_path: string }>(
        `
          SELECT target_path
          FROM hint_dictionary
          WHERE repo_id = ?
            AND hint_value = ?
          ORDER BY freq DESC, target_path
          LIMIT ?
        `,
        [repoId, hint, perHintLimit]
      );
    } catch (error) {
      if (isMissingTableError(error, "hint_dictionary")) {
        console.warn(
          "hint_dictionary table is missing in the active database. Run scripts/diag/build-hint-dictionary.ts after upgrading the schema."
        );
        return [];
      }
      throw error;
    }
    for (const row of rows) {
      if (!row.target_path || !SAFE_PATH_PATTERN.test(row.target_path)) {
        continue;
      }
      targets.push({ path: row.target_path, sourceHint: hint, origin: "dictionary" });
    }
  }
  return targets;
}

function createHintSeedMeta(targets: ResolvedPathHint[]): {
  list: ResolvedPathHint[];
  meta: Map<string, HintSeedMeta>;
} {
  const meta = new Map<string, HintSeedMeta>();
  const deduped: ResolvedPathHint[] = [];
  for (const target of targets) {
    if (meta.has(target.path)) {
      continue;
    }
    meta.set(target.path, { sourceHint: target.sourceHint, origin: target.origin });
    deduped.push(target);
  }
  return { list: deduped, meta };
}

function getHintSeedMeta(
  seedMeta: Map<string, HintSeedMeta> | undefined,
  path: string
): HintSeedMeta | undefined {
  return seedMeta?.get(path);
}

function computeHintPriorityBoost(weights: ScoringWeights): number {
  const textComponent = weights.textMatch * HINT_PRIORITY_TEXT_MULTIPLIER;
  const pathComponent = weights.pathMatch * HINT_PRIORITY_PATH_MULTIPLIER;
  const aggregate = textComponent + pathComponent + weights.editingPath + weights.dependency;
  return Math.max(HINT_PRIORITY_BASE_BONUS, aggregate);
}

interface HintExpansionConfig {
  dirLimit: number;
  dirMaxFiles: number;
  depOutLimit: number;
  depInLimit: number;
  semLimit: number;
  semDirCandidateLimit: number;
  semThreshold: number;
  perHintLimit: number;
  dbQueryBudget: number;
  dirBoost: number;
  depBoost: number;
  substringLimit: number;
  substringBoost: number;
}

interface HintExpansionState {
  remainingDbQueries: number;
}

function createHintExpansionConfig(weights: ScoringWeights): HintExpansionConfig {
  return {
    dirLimit: Math.max(0, HINT_DIR_LIMIT),
    dirMaxFiles: Math.max(1, HINT_DIR_MAX_FILES),
    depOutLimit: Math.max(0, HINT_DEP_OUT_LIMIT),
    depInLimit: Math.max(0, HINT_DEP_IN_LIMIT),
    semLimit: Math.max(0, HINT_SEM_LIMIT),
    semDirCandidateLimit: Math.max(1, HINT_SEM_DIR_CANDIDATE_LIMIT),
    semThreshold: Number.isFinite(HINT_SEM_THRESHOLD) ? HINT_SEM_THRESHOLD : 0.65,
    perHintLimit: Math.max(0, HINT_PER_HINT_LIMIT),
    dbQueryBudget: Math.max(0, HINT_DB_QUERY_BUDGET),
    dirBoost: computeHintPriorityBoost(weights) * 0.35,
    depBoost: weights.dependency * 0.8,
    substringLimit: Math.max(0, HINT_SUBSTRING_LIMIT),
    substringBoost: Math.max(0, HINT_SUBSTRING_BOOST),
  };
}

export interface SemanticRerankCandidateInput {
  path: string;
  score?: number;
}

export interface SemanticRerankParams {
  text: string;
  candidates: SemanticRerankCandidateInput[];
  k?: number;
  profile?: string;
}

export interface SemanticRerankItem {
  path: string;
  semantic: number;
  base: number;
  combined: number;
}

export interface SemanticRerankResult {
  candidates: SemanticRerankItem[];
}

const DEFAULT_SEARCH_LIMIT = 50;
const DEFAULT_BUNDLE_LIMIT = 7; // Reduced from 12 to optimize token usage
const MAX_BUNDLE_LIMIT = 20;
const TRACE_SEARCH = process.env.KIRI_TRACE_SEARCH === "1";
const MAX_KEYWORDS = 12;
const MAX_MATCHES_PER_KEYWORD = 40;
const MAX_DEPENDENCY_SEEDS = 8;
const MAX_DEPENDENCY_SEEDS_QUERY_LIMIT = 100; // SQL injection防御用の上限
const NEARBY_LIMIT = 6;
const serverConfig = loadServerConfig();
const mergedPathMultiplierCache = new Map<BoostProfileName, PathMultiplier[]>();
const SUPPRESS_NON_CODE_ENABLED = serverConfig.features.suppressNonCode;
const FINAL_RESULT_SUPPRESSION_ENABLED = serverConfig.features.suppressFinalResults;
const CLAMP_SNIPPETS_ENABLED = serverConfig.features.clampSnippets;
const FALLBACK_SNIPPET_WINDOW = serverConfig.features.snippetWindow;
const MAX_RERANK_LIMIT = 50;
const MAX_ARTIFACT_HINTS = 8;
/** Minimum confidence floor for co-change scoring to prevent zero-boost from low Jaccard scores */
const MIN_COCHANGE_CONFIDENCE_FLOOR = 0.2;
const DOMAIN_PATH_HINT_LIMIT = MAX_ARTIFACT_HINTS;
const SAFE_PATH_PATTERN = /^[a-zA-Z0-9_.\-/]+$/;
const HINT_PRIORITY_TEXT_MULTIPLIER = serverConfig.hints.priority.textMultiplier;
const HINT_PRIORITY_PATH_MULTIPLIER = serverConfig.hints.priority.pathMultiplier;
const HINT_PRIORITY_BASE_BONUS = serverConfig.hints.priority.baseBonus;
const PATH_FALLBACK_LIMIT = 40;
const PATH_FALLBACK_TERMS_LIMIT = 5;
const PATH_FALLBACK_KEEP = 8;
const AUTO_PATH_SEGMENT_LIMIT = 4;

function traceSearch(message: string, ...args: unknown[]): void {
  if (TRACE_SEARCH) {
    console.log(`[TRACE context_bundle] ${message}`, ...args);
  }
}

const HINT_DIR_LIMIT = serverConfig.hints.directory.limit;
const HINT_DIR_MAX_FILES = serverConfig.hints.directory.maxFiles;
const HINT_DEP_OUT_LIMIT = serverConfig.hints.dependency.outLimit;
const HINT_DEP_IN_LIMIT = serverConfig.hints.dependency.inLimit;
const HINT_SEM_LIMIT = serverConfig.hints.semantic.limit;
const HINT_SEM_DIR_CANDIDATE_LIMIT = serverConfig.hints.semantic.dirCandidateLimit;
const HINT_SEM_THRESHOLD = serverConfig.hints.semantic.threshold;

const SUPPRESSED_PATH_PREFIXES = [".github/", ".git/", "ThirdPartyNotices", "node_modules/"];
const SUPPRESSED_FILE_NAMES = ["thirdpartynotices.txt", "thirdpartynotices.md", "cgmanifest.json"];

function isSuppressedPath(path: string): boolean {
  if (!SUPPRESS_NON_CODE_ENABLED) {
    return false;
  }
  const normalized = path.startsWith("./") ? path.replace(/^\.\/+/u, "") : path;
  const lower = normalized.toLowerCase();
  if (SUPPRESSED_FILE_NAMES.some((name) => lower.endsWith(name))) {
    return true;
  }
  const lowerPrefixMatches = SUPPRESSED_PATH_PREFIXES.map((prefix) => prefix.toLowerCase());
  return lowerPrefixMatches.some((prefix) => lower.includes(prefix));
}
const HINT_PER_HINT_LIMIT = serverConfig.hints.perHintLimit;
const HINT_DB_QUERY_BUDGET = serverConfig.hints.dbQueryLimit;
const HINT_SUBSTRING_LIMIT = serverConfig.hints.substring.limit;
const HINT_SUBSTRING_BOOST = serverConfig.hints.substring.boost;
const HINT_LOG_ENABLED = process.env.KIRI_HINT_LOG === "1";
const HINT_DICTIONARY_ENABLED = process.env.KIRI_HINT_DICTIONARY !== "0";
const HINT_DICTIONARY_LIMIT = Math.max(
  0,
  Number.parseInt(process.env.KIRI_HINT_DICTIONARY_LIMIT ?? "2", 10)
);

// Issue #68: Path/Large File Penalty configuration (環境変数で上書き可能)
const PATH_MISS_DELTA = serverConfig.penalties.pathMissDelta;
const LARGE_FILE_DELTA = serverConfig.penalties.largeFileDelta;
const MAX_WHY_TAGS = 10;

// 項目3: whyタグの優先度マップ（低い数値ほど高優先度）
// All actual tag prefixes used in the codebase
const WHY_TAG_PRIORITY: Record<string, number> = {
  artifact: 1, // User-provided hints (editing_path, failing_tests, hints)
  dictionary: 1, // Dictionary-provided hints
  phrase: 2, // Multi-word literal matches (strongest signal)
  text: 3, // Single keyword matches
  metadata: 4, // Front matter / metadata filters & boosts
  substring: 4, // Substring hint expansion
  "path-phrase": 5, // Path contains multi-word phrase
  structural: 6, // Semantic similarity
  cochange: 7, // Co-change history (files that change together)
  "path-segment": 8, // Path component matches
  "path-keyword": 9, // Path keyword match
  dep: 10, // Dependency relationship
  near: 11, // Proximity to editing file
  boost: 12, // File type boost
  recent: 13, // Recently changed
  symbol: 14, // Symbol match
  penalty: 15, // Penalty explanations (keep for transparency)
  keyword: 16, // Generic keyword (deprecated, kept for compatibility)
};

// Reserve at least one slot for important structural tags
const RESERVED_WHY_SLOTS: Record<string, number> = {
  dep: 1, // Dependency relationships are critical
  symbol: 1, // Symbol boundaries help understand context
  near: 1, // Proximity explains file selection
  metadata: 1, // Preserve metadata reasons when filters/boosts are active
};

/**
 * Parse output formatting options from request parameters
 *
 * Provides a consistent way to determine what content should be included in responses.
 * Used by both normal and degraded mode to ensure consistent behavior.
 */
interface OutputOptions {
  includePreview: boolean;
  includeLineNumbers: boolean;
}

function parseOutputOptions(params: {
  compact?: boolean;
  includeLineNumbers?: boolean;
}): OutputOptions {
  return {
    includePreview: params.compact !== true,
    includeLineNumbers: params.includeLineNumbers === true && params.compact !== true,
  };
}

/**
 * Select the most informative why tags while ensuring diversity
 *
 * Guarantees at least one tag from reserved categories (dep, symbol, near) if they exist,
 * then fills remaining slots by priority. This prevents keyword matches from crowding out
 * structural context that explains "why this file?"
 *
 * DoS protection: Limits processing to first 1000 reasons to prevent CPU exhaustion.
 */
function selectWhyTags(reasons: Set<string>): string[] {
  // Protect against DoS: limit reasons processed
  if (reasons.size > 1000) {
    reasons = new Set(Array.from(reasons).slice(0, 1000));
  }

  const selected = new Set<string>();
  if (reasons.has("boost:links")) {
    selected.add("boost:links");
  }
  const byCategory = new Map<string, string[]>();

  for (const reason of reasons) {
    const prefix = reason.split(":")[0] ?? "";
    if (!byCategory.has(prefix)) {
      byCategory.set(prefix, []);
    }
    byCategory.get(prefix)!.push(reason);
  }

  // Step 1: Fill reserved slots
  for (const [category, minCount] of Object.entries(RESERVED_WHY_SLOTS)) {
    const items = byCategory.get(category) ?? [];
    for (let i = 0; i < minCount && i < items.length; i++) {
      selected.add(items[i]!); // Safe: i < items.length guarantees existence
    }
  }

  // Step 2: Fill remaining slots by priority
  const allReasons = Array.from(reasons).sort((a, b) => {
    const aPrefix = a.split(":")[0] ?? "";
    const bPrefix = b.split(":")[0] ?? "";
    const aPrio = WHY_TAG_PRIORITY[aPrefix] ?? 99;
    const bPrio = WHY_TAG_PRIORITY[bPrefix] ?? 99;
    if (aPrio !== bPrio) return aPrio - bPrio;
    return a.localeCompare(b);
  });

  for (const reason of allReasons) {
    if (selected.size >= MAX_WHY_TAGS) break;
    selected.add(reason); // Set automatically deduplicates
  }

  return Array.from(selected);
}

/**
 * ストップワードサービスの遅延初期化
 * シングルトンキャッシュを使用し、config/stop-words.yml から読み込み
 * @see Issue #48: Improve context_bundle stop word coverage and configurability
 */
let _stopWordsService: StopWordsService | null = null;
function getStopWordsService(): StopWordsService {
  if (!_stopWordsService) {
    _stopWordsService = loadStopWords();
  }
  return _stopWordsService;
}

export interface DepsClosureParams {
  path: string;
  max_depth?: number;
  direction?: "outbound" | "inbound";
  include_packages?: boolean;
}

export interface DepsClosureNode {
  kind: "path" | "package";
  target: string;
  depth: number;
}

export interface DepsClosureEdge {
  from: string;
  to: string;
  kind: "path" | "package";
  rel: string;
  depth: number;
}

export interface DepsClosureResult {
  root: string;
  direction: "outbound" | "inbound";
  nodes: DepsClosureNode[];
  edges: DepsClosureEdge[];
}

interface FileRow {
  path: string;
  lang: string | null;
  ext: string | null;
  content: string | null;
  score?: number; // FTS検索時のBM25スコア
}

interface FileWithBinaryRow extends FileRow {
  is_binary: boolean;
}

interface FileWithEmbeddingRow extends FileWithBinaryRow {
  vector_json: string | null;
  vector_dims: number | null;
}

function prioritizeHintCandidates(
  rankedCandidates: CandidateInfo[],
  hintPaths: string[],
  limit: number
): CandidateInfo[] {
  if (rankedCandidates.length === 0) {
    return [];
  }
  const sanitizedLimit = Math.max(1, Math.min(limit, rankedCandidates.length));
  const candidateByPath = new Map<string, CandidateInfo>();
  for (const candidate of rankedCandidates) {
    if (!candidateByPath.has(candidate.path)) {
      candidateByPath.set(candidate.path, candidate);
    }
  }
  const final: CandidateInfo[] = [];
  const seen = new Set<string>();

  for (const hintPath of hintPaths) {
    if (final.length >= sanitizedLimit) {
      break;
    }
    const candidate = candidateByPath.get(hintPath);
    if (!candidate || seen.has(candidate.path)) {
      continue;
    }
    final.push(candidate);
    seen.add(candidate.path);
  }

  if (final.length >= sanitizedLimit) {
    return final;
  }

  for (const candidate of rankedCandidates) {
    if (final.length >= sanitizedLimit) {
      break;
    }
    if (seen.has(candidate.path)) {
      continue;
    }
    final.push(candidate);
    seen.add(candidate.path);
  }

  return final;
}

interface SnippetRow {
  snippet_id: number;
  start_line: number;
  end_line: number;
  symbol_id: number | null;
  symbol_name: string | null;
  symbol_kind: string | null;
}

interface DependencyRow {
  src_path: string;
  dst_kind: string;
  dst: string;
  rel: string;
}

function normalizeLimit(limit?: number): number {
  if (!limit || Number.isNaN(limit)) {
    return DEFAULT_SEARCH_LIMIT;
  }
  return Math.min(Math.max(1, Math.floor(limit)), 100);
}

function buildPreview(content: string, query: string): { preview: string; line: number } {
  const lowerContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const index = lowerContent.indexOf(lowerQuery);
  if (index === -1) {
    return { preview: content.slice(0, 240), line: 1 };
  }

  const prefix = content.slice(0, index);
  const prefixLines = prefix.split(/\r?\n/);
  const matchLine = prefix.length === 0 ? 1 : prefixLines.length;

  const snippetStart = Math.max(0, index - 120);
  const snippetEnd = Math.min(content.length, index + query.length + 120);
  const preview = content.slice(snippetStart, snippetEnd);

  return { preview, line: matchLine };
}

/**
 * Lightweight function to find the line number of the first match without generating a preview.
 * Used in compact mode to minimize CPU/memory overhead.
 */
function findFirstMatchLine(content: string, query: string): number {
  const lowerContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const index = lowerContent.indexOf(lowerQuery);
  if (index === -1) {
    return 1;
  }

  const prefix = content.slice(0, index);
  const prefixLines = prefix.split(/\r?\n/);
  return prefix.length === 0 ? 1 : prefixLines.length;
}

/**
 * ペナルティ影響の記録（Issue #68: Path/Large File Penalties）
 */
interface PenaltyImpact {
  kind: "path-miss" | "large-file";
  delta: number; // Always negative
  details?: Record<string, unknown>;
}

/**
 * ペナルティ機能フラグ（Issue #68）
 */
interface PenaltyFlags {
  pathPenalty: boolean; // KIRI_PATH_PENALTY
  largeFilePenalty: boolean; // KIRI_LARGE_FILE_PENALTY
}

/**
 * クエリ統計（Issue #68: Path Miss Penalty判定用）
 */
interface QueryStats {
  wordCount: number;
  avgWordLength: number;
}

/**
 * pathMatchHits分布の型（Issue #68: Telemetry）
 * LDE: 型駆動設計でデータ構造を明示
 */
interface PathMatchDistribution {
  readonly zero: number; // pathMatchHits === 0 の候補数
  readonly one: number; // pathMatchHits === 1 の候補数
  readonly two: number; // pathMatchHits === 2 の候補数
  readonly three: number; // pathMatchHits === 3 の候補数
  readonly fourPlus: number; // pathMatchHits >= 4 の候補数
  readonly total: number; // 全候補数
}

/**
 * ペナルティ適用テレメトリー（Issue #68: Telemetry）
 * LDE: イミュータブルなデータ構造
 */
interface PenaltyTelemetry {
  readonly pathMissPenalties: number; // Path miss penalty適用数
  readonly largeFilePenalties: number; // Large file penalty適用数
  readonly totalCandidates: number; // 全候補数
  readonly pathMatchDistribution: PathMatchDistribution; // pathMatchHits分布
  readonly scoreStats: {
    // スコア統計
    readonly min: number;
    readonly max: number;
    readonly mean: number;
    readonly median: number;
  };
}

/**
 * 段階的ペナルティの設定（Issue #68: Graduated Penalty）
 * LDE: 型駆動設計で不変条件を保証
 *
 * ADR 002: Graduated Penalty System
 * - tier0Delta: pathMatchHits === 0 (no path evidence)
 * - tier1Delta: pathMatchHits === 1 (weak path evidence)
 * - tier2Delta: pathMatchHits === 2 (moderate path evidence)
 * - pathMatchHits >= 3: no penalty (strong path evidence)
 *
 * Invariants:
 * - All delta values must be <= 0 (non-positive)
 * - tier0Delta < tier1Delta < tier2Delta <= 0 (monotonicity)
 */
interface GraduatedPenaltyConfig {
  readonly enabled: boolean; // KIRI_GRADUATED_PENALTY=1
  readonly minWordCount: number; // Default: 2
  readonly minAvgWordLength: number; // Default: 4.0
  readonly tier0Delta: number; // pathMatchHits === 0, default: -0.8
  readonly tier1Delta: number; // pathMatchHits === 1, default: -0.4
  readonly tier2Delta: number; // pathMatchHits === 2, default: -0.2
}

interface CandidateInfo {
  path: string;
  score: number;
  scoreMultiplier: number; // Accumulated boost/penalty multiplier (1.0 = no change)
  reasons: Set<string>;
  matchLine: number | null;
  content: string | null;
  totalLines: number | null;
  lang: string | null;
  ext: string | null;
  embedding: number[] | null;
  semanticSimilarity: number | null;
  pathMatchHits: number; // Track path match count for path-miss penalty (Issue #68)
  keywordHits: Set<string>;
  phraseHits: number;
  pathFallbackReason?: "no-string-match" | "low-candidates" | "supplemental";
  fallbackTextHits: number;
  penalties: PenaltyImpact[]; // Penalty log for telemetry (Issue #68)
}

interface FileContentCacheEntry {
  content: string;
  lang: string | null;
  ext: string | null;
  totalLines: number;
  embedding: number[] | null;
}

function normalizeBundleLimit(limit?: number): number {
  if (!limit || Number.isNaN(limit)) {
    return DEFAULT_BUNDLE_LIMIT;
  }
  return Math.min(Math.max(1, Math.floor(limit)), MAX_BUNDLE_LIMIT);
}

/**
 * トークン化戦略
 * - phrase-aware: ハイフン区切り用語を保持（例: "page-agent" を単一ユニットとして保持）
 * - legacy: ハイフンで分割（例: "page-agent" → ["page", "agent"]）
 * - hybrid: フレーズと分割キーワードの両方を出力
 */
type TokenizationStrategy = "phrase-aware" | "legacy" | "hybrid";

/**
 * キーワード抽出結果
 */
interface ExtractedTerms {
  /** 引用符で囲まれたフレーズまたはハイフン区切り用語 */
  phrases: string[];
  /** 通常のキーワード（単語） */
  keywords: string[];
  /** パスセグメント（ディレクトリ/ファイル名など） */
  pathSegments: string[];
}

/**
 * トークン化戦略を取得
 * 環境変数またはデフォルト値から決定
 */
function getTokenizationStrategy(): TokenizationStrategy {
  const strategy = process.env.KIRI_TOKENIZATION_STRATEGY?.toLowerCase();
  if (strategy === "legacy" || strategy === "hybrid") {
    return strategy;
  }
  return "phrase-aware"; // デフォルト
}

/**
 * 引用符で囲まれたフレーズを抽出
 * 例: 'search "page-agent handler" test' → ["page-agent handler"]
 */
function extractQuotedPhrases(text: string): { phrases: string[]; remaining: string } {
  const phrases: string[] = [];
  const quotePattern = /"([^"]+)"|'([^']+)'/g;
  let match: RegExpExecArray | null;
  let remaining = text;

  while ((match = quotePattern.exec(text)) !== null) {
    const phrase = (match[1] || match[2] || "").trim().toLowerCase();
    if (phrase.length >= 3) {
      phrases.push(phrase);
    }
    remaining = remaining.replace(match[0], " ");
  }

  return { phrases, remaining };
}

/**
 * 複合用語を抽出（ハイフンまたはアンダースコア区切り）
 * Unicode文字に対応（日本語、中国語などの複合用語もサポート）
 * 例: "page-agent lambda-handler" → ["page-agent", "lambda-handler"]
 * 例: "user_profile file_embedding" → ["user_profile", "file_embedding"]
 * 例: "app-日本語" → ["app-日本語"]
 */
function extractCompoundTerms(text: string): string[] {
  // Unicode対応: ハイフン(-)とアンダースコア(_)の両方をサポート
  // snake_case (Python/Rust) と kebab-case を同等に扱う
  // 注: \b はアンダースコアを単語文字として扱うため、アンダースコアでは機能しない
  // そのため、明示的な境界チェックを使用
  const compoundPattern =
    /(?:^|\s|[^\p{L}\p{N}_-])([\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)+)(?=\s|[^\p{L}\p{N}_-]|$)/giu;
  const matches = Array.from(text.matchAll(compoundPattern)).map((m) => m[1]!);
  return matches
    .map((term) => term.toLowerCase())
    .filter((term) => term.length >= 3 && !getStopWordsService().has(term));
}

/**
 * パスライクな用語を抽出
 * Unicode文字に対応
 * 例: "lambda/page-agent/handler" → ["lambda", "page-agent", "handler"]
 */
function extractPathSegments(text: string): string[] {
  // Unicode対応: パスセグメントでもUnicode文字をサポート
  const pathPattern = /\b[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)+\b/giu;
  const matches = text.match(pathPattern) || [];
  const segments: string[] = [];

  for (const path of matches) {
    const parts = path.toLowerCase().split("/");
    for (const part of parts) {
      if (part.length >= 3 && !getStopWordsService().has(part) && !segments.includes(part)) {
        segments.push(part);
      }
    }
  }

  return segments;
}

/**
 * 通常の単語を抽出
 * 共有トークン化ユーティリティを使用
 */
function extractRegularWords(text: string, strategy: TokenizationStrategy): string[] {
  const words = tokenizeText(text, strategy).filter(
    (word) => word.length >= 3 && !getStopWordsService().has(word)
  );

  return words;
}

/**
 * テキストからキーワード、フレーズ、パスセグメントを抽出
 * トークン化戦略に基づいて、ハイフン区切り用語の処理方法を変更
 */
function extractKeywords(text: string): ExtractedTerms {
  const strategy = getTokenizationStrategy();
  const result: ExtractedTerms = {
    phrases: [],
    keywords: [],
    pathSegments: [],
  };

  // Phase 1: 引用符で囲まれたフレーズを抽出
  const { phrases: quotedPhrases, remaining: afterQuotes } = extractQuotedPhrases(text);
  result.phrases.push(...quotedPhrases);

  // Phase 2: パスセグメントを抽出
  const pathSegments = extractPathSegments(afterQuotes);
  result.pathSegments.push(...pathSegments);

  // Phase 3: 複合用語を抽出（ハイフン/アンダースコア区切り）（phrase-aware または hybrid モード）
  if (strategy === "phrase-aware" || strategy === "hybrid") {
    const compoundTerms = extractCompoundTerms(afterQuotes);
    result.phrases.push(...compoundTerms);

    // hybrid モードの場合、複合用語を分割したキーワードも追加
    if (strategy === "hybrid") {
      for (const term of compoundTerms) {
        // ハイフンとアンダースコアの両方で分割
        const parts = term
          .split(/[-_]/)
          .filter((part) => part.length >= 3 && !getStopWordsService().has(part));
        result.keywords.push(...parts);
      }
    }
  }

  // Phase 4: 通常の単語を抽出
  const regularWords = extractRegularWords(afterQuotes, strategy);

  // 重複を除去しながら、最大キーワード数まで追加
  for (const word of regularWords) {
    if (!result.keywords.includes(word) && !result.phrases.includes(word)) {
      result.keywords.push(word);
      if (result.keywords.length >= MAX_KEYWORDS) {
        break;
      }
    }
  }

  addKeywordDerivedPathSegments(result);
  return result;
}

function addKeywordDerivedPathSegments(result: ExtractedTerms): void {
  if (result.pathSegments.length >= AUTO_PATH_SEGMENT_LIMIT) {
    return;
  }
  const additional: string[] = [];
  for (const keyword of result.keywords) {
    if (keyword.length < 3 || getStopWordsService().has(keyword)) {
      continue;
    }
    if (result.pathSegments.includes(keyword) || additional.includes(keyword)) {
      continue;
    }
    additional.push(keyword);
    if (result.pathSegments.length + additional.length >= AUTO_PATH_SEGMENT_LIMIT) {
      break;
    }
  }
  if (additional.length > 0) {
    result.pathSegments.push(...additional);
  }
}

function ensureCandidate(map: Map<string, CandidateInfo>, filePath: string): CandidateInfo {
  let candidate = map.get(filePath);
  if (!candidate) {
    candidate = {
      path: filePath,
      score: 0,
      scoreMultiplier: 1.0, // Default: no boost or penalty
      reasons: new Set<string>(),
      matchLine: null,
      content: null,
      totalLines: null,
      lang: null,
      ext: null,
      embedding: null,
      semanticSimilarity: null,
      pathMatchHits: 0, // Issue #68: Track path match count
      keywordHits: new Set<string>(),
      phraseHits: 0,
      // pathFallbackReason は optional なので省略（exactOptionalPropertyTypes対応）
      fallbackTextHits: 0,
      penalties: [], // Issue #68: Penalty log for telemetry
    };
    map.set(filePath, candidate);
  }
  return candidate;
}

function normalizePathPrefix(rawPrefix: string): string {
  // Normalize, strip leading slashes/dots, and ensure trailing slash for exact prefix match
  const normalized = path.posix.normalize(rawPrefix.replace(/\\/g, "/"));
  const stripped = normalized.replace(/^\.\//, "").replace(/^\/+/, "");
  if (stripped === "" || stripped === ".") {
    return "";
  }
  return stripped.endsWith("/") ? stripped : `${stripped}/`;
}

function normalizeFilePath(filePath: string): string {
  return path.posix.normalize(filePath.replace(/\\/g, "/")).replace(/^\/+/, "");
}

function pathMatchesPrefix(filePath: string, normalizedPrefix?: string): boolean {
  if (!normalizedPrefix) {
    return true;
  }
  const normalizedPath = normalizeFilePath(filePath);
  return normalizedPath.startsWith(normalizedPrefix);
}

interface ExpandHintParams {
  db: DuckDBClient;
  tableAvailability: TableAvailability;
  repoId: number;
  hintPaths: string[];
  candidates: Map<string, CandidateInfo>;
  fileCache: Map<string, FileContentCacheEntry>;
  weights: ScoringWeights;
  config: HintExpansionConfig;
  hintSeedMeta?: Map<string, HintSeedMeta>;
}

interface ExpandSingleHintParams extends ExpandHintParams {
  hintPath: string;
  state: HintExpansionState;
}

async function expandHintCandidatesForHints(params: ExpandHintParams): Promise<void> {
  const { hintPaths, config } = params;
  if (hintPaths.length === 0 || config.perHintLimit <= 0 || config.dbQueryBudget <= 0) {
    return;
  }

  const state: HintExpansionState = { remainingDbQueries: config.dbQueryBudget };
  for (const hintPath of hintPaths) {
    if (state.remainingDbQueries <= 0) {
      break;
    }
    await expandSingleHintNeighborhood({ ...params, hintPath, state });
  }
}

async function expandSingleHintNeighborhood(args: ExpandSingleHintParams): Promise<void> {
  const { config } = args;
  let remaining = config.perHintLimit;
  if (remaining <= 0) {
    return;
  }

  if (config.dirLimit > 0) {
    const added = await addHintDirectoryNeighbors(args, Math.min(config.dirLimit, remaining));
    remaining -= added;
    if (remaining <= 0) {
      return;
    }
  }

  if (config.depOutLimit > 0 || config.depInLimit > 0) {
    const added = await addHintDependencyNeighbors(args, remaining);
    remaining -= added;
    if (remaining <= 0) {
      return;
    }
  }

  if (config.semLimit > 0) {
    await addHintSemanticNeighbors(args, Math.min(config.semLimit, remaining));
  }
}

function useHintDbBudget(state: HintExpansionState, cost = 1): boolean {
  if (state.remainingDbQueries < cost) {
    return false;
  }
  state.remainingDbQueries -= cost;
  return true;
}

function applyHintReasonBoost(
  candidate: CandidateInfo,
  reason: string,
  scoreDelta: number,
  lang?: string | null,
  ext?: string | null
): boolean {
  if (scoreDelta <= 0 || candidate.reasons.has(reason)) {
    return false;
  }
  candidate.score += scoreDelta;
  candidate.reasons.add(reason);
  candidate.pathMatchHits = Math.max(candidate.pathMatchHits, 2);
  candidate.matchLine ??= 1;
  if (lang && !candidate.lang) {
    candidate.lang = lang;
  }
  if (ext && !candidate.ext) {
    candidate.ext = ext;
  }
  return true;
}

interface PathHintPromotionArgs {
  db: DuckDBClient;
  tableAvailability: TableAvailability;
  repoId: number;
  hintTargets: ResolvedPathHint[];
  candidates: Map<string, CandidateInfo>;
  fileCache: Map<string, FileContentCacheEntry>;
  weights: ScoringWeights;
  hintSeedMeta: Map<string, HintSeedMeta>;
}

async function applyPathHintPromotions(args: PathHintPromotionArgs): Promise<void> {
  const { hintTargets } = args;
  if (hintTargets.length === 0) {
    return;
  }
  const hintBoost = computeHintPriorityBoost(args.weights);
  for (const target of hintTargets) {
    const candidate = ensureCandidate(args.candidates, target.path);
    const reasonPrefix = target.origin === "dictionary" ? "dictionary:hint" : "artifact:hint";
    candidate.score += hintBoost;
    candidate.reasons.add(`${reasonPrefix}:${target.path}`);
    candidate.pathMatchHits = Math.max(candidate.pathMatchHits, 3);
    candidate.matchLine ??= 1;
    await logHintExpansionEntry(args.db, args.tableAvailability, {
      repoId: args.repoId,
      hintValue: target.sourceHint,
      kind: target.origin === "dictionary" ? "dictionary" : "path",
      targetPath: target.path,
      payload: {
        origin: target.origin,
        source_hint: target.sourceHint,
      },
    });
  }
  await expandHintCandidatesForHints({
    db: args.db,
    tableAvailability: args.tableAvailability,
    repoId: args.repoId,
    hintPaths: hintTargets.map((target) => target.path),
    candidates: args.candidates,
    fileCache: args.fileCache,
    weights: args.weights,
    config: createHintExpansionConfig(args.weights),
    hintSeedMeta: args.hintSeedMeta,
  });
}

async function addHintSubstringMatches(
  db: DuckDBClient,
  tableAvailability: TableAvailability,
  repoId: number,
  hints: string[],
  candidates: Map<string, CandidateInfo>,
  limitPerHint: number,
  boost: number
): Promise<void> {
  if (limitPerHint <= 0 || boost <= 0) {
    return;
  }
  for (const hint of hints) {
    if (!SAFE_PATH_PATTERN.test(hint.replace(/[^a-zA-Z0-9_.-]/g, ""))) {
      continue;
    }
    const rows = await db.all<{ path: string }>(
      `
        SELECT path
        FROM file
        WHERE repo_id = ?
          AND is_binary = FALSE
          AND LOWER(path) LIKE '%' || ? || '%'
        ORDER BY path
        LIMIT ?
      `,
      [repoId, hint, limitPerHint]
    );
    for (const row of rows) {
      const candidate = ensureCandidate(candidates, row.path);
      const reason = `substring:hint:${hint}`;
      if (applyHintReasonBoost(candidate, reason, boost)) {
        await logHintExpansionEntry(db, tableAvailability, {
          repoId,
          hintValue: hint,
          kind: "substring",
          targetPath: row.path,
        });
      }
    }
  }
}

async function addHintDirectoryNeighbors(
  args: ExpandSingleHintParams,
  limit: number
): Promise<number> {
  if (limit <= 0) {
    return 0;
  }
  const dir = path.posix.dirname(args.hintPath);
  if (!dir || dir === "." || dir === "/") {
    return 0;
  }
  if (!useHintDbBudget(args.state)) {
    return 0;
  }
  const rows = await args.db.all<{ path: string; lang: string | null; ext: string | null }>(
    `
      SELECT path, lang, ext
      FROM file
      WHERE repo_id = ?
        AND is_binary = FALSE
        AND path LIKE ?
      ORDER BY path
      LIMIT ?
    `,
    [args.repoId, `${dir}/%`, args.config.dirMaxFiles + 1]
  );
  if (rows.length === 0 || rows.length > args.config.dirMaxFiles) {
    return 0;
  }
  rows.sort((a, b) => hintNeighborRank(a.path) - hintNeighborRank(b.path));

  let added = 0;
  for (const row of rows) {
    if (row.path === args.hintPath) {
      continue;
    }
    if (!SAFE_PATH_PATTERN.test(row.path)) {
      continue;
    }
    const candidate = ensureCandidate(args.candidates, row.path);
    const reason = `artifact:hint_dir:${args.hintPath}:${row.path}`;
    if (applyHintReasonBoost(candidate, reason, args.config.dirBoost, row.lang, row.ext)) {
      added += 1;
      const seedMeta = getHintSeedMeta(args.hintSeedMeta, args.hintPath);
      await logHintExpansionEntry(args.db, args.tableAvailability, {
        repoId: args.repoId,
        hintValue: seedMeta?.sourceHint ?? args.hintPath,
        kind: "directory",
        targetPath: row.path,
        payload: {
          origin: seedMeta?.origin ?? "artifact",
        },
      });
      if (added >= limit) {
        break;
      }
    }
  }

  return added;
}

async function addHintDependencyNeighbors(
  args: ExpandSingleHintParams,
  perHintRemaining: number
): Promise<number> {
  if (perHintRemaining <= 0) {
    return 0;
  }
  let added = 0;
  if (args.config.depOutLimit > 0) {
    const outLimit = Math.min(args.config.depOutLimit, perHintRemaining - added);
    if (outLimit > 0) {
      added += await addHintDependencyDirection(args, outLimit, "out");
    }
  }
  if (perHintRemaining - added <= 0) {
    return added;
  }
  if (args.config.depInLimit > 0) {
    const inLimit = Math.min(args.config.depInLimit, perHintRemaining - added);
    if (inLimit > 0) {
      added += await addHintDependencyDirection(args, inLimit, "in");
    }
  }
  return added;
}

async function addHintDependencyDirection(
  args: ExpandSingleHintParams,
  limit: number,
  direction: "out" | "in"
): Promise<number> {
  if (limit <= 0) {
    return 0;
  }
  if (!useHintDbBudget(args.state)) {
    return 0;
  }

  const fetchLimit = Math.min(limit * 4, 25);
  if (direction === "out") {
    const rows = await args.db.all<{ dst: string }>(
      `
        SELECT dst
        FROM dependency
        WHERE repo_id = ?
          AND src_path = ?
          AND dst_kind = 'path'
        LIMIT ?
      `,
      [args.repoId, args.hintPath, fetchLimit]
    );
    return await applyDependencyRows(
      args,
      rows.map((row) => row.dst),
      limit,
      direction
    );
  }

  const rows = await args.db.all<{ src_path: string }>(
    `
      SELECT src_path
      FROM dependency
      WHERE repo_id = ?
        AND dst = ?
        AND dst_kind = 'path'
      LIMIT ?
    `,
    [args.repoId, args.hintPath, fetchLimit]
  );
  return await applyDependencyRows(
    args,
    rows.map((row) => row.src_path),
    limit,
    direction
  );
}

async function applyDependencyRows(
  args: ExpandSingleHintParams,
  paths: string[],
  limit: number,
  direction: "out" | "in"
): Promise<number> {
  if (paths.length === 0) {
    return 0;
  }
  const uniquePaths = Array.from(new Set(paths)).filter((p) => p && SAFE_PATH_PATTERN.test(p));
  uniquePaths.sort((a, b) => hintNeighborRank(a) - hintNeighborRank(b));
  let added = 0;
  for (const dependencyPath of uniquePaths) {
    if (dependencyPath === args.hintPath) {
      continue;
    }
    const candidate = ensureCandidate(args.candidates, dependencyPath);
    const reason = `artifact:hint_dep_${direction}:${args.hintPath}:${dependencyPath}`;
    if (applyHintReasonBoost(candidate, reason, args.config.depBoost)) {
      added += 1;
      const seedMeta = getHintSeedMeta(args.hintSeedMeta, args.hintPath);
      await logHintExpansionEntry(args.db, args.tableAvailability, {
        repoId: args.repoId,
        hintValue: seedMeta?.sourceHint ?? args.hintPath,
        kind: "dependency",
        targetPath: dependencyPath,
        payload: {
          origin: seedMeta?.origin ?? "artifact",
          direction,
        },
      });
      if (added >= limit) {
        break;
      }
    }
  }
  return added;
}

async function addHintSemanticNeighbors(
  args: ExpandSingleHintParams,
  limit: number
): Promise<number> {
  if (limit <= 0) {
    return 0;
  }
  const dir = path.posix.dirname(args.hintPath);
  if (!dir || dir === "." || dir === "/") {
    return 0;
  }
  if (!useHintDbBudget(args.state)) {
    return 0;
  }
  const rows = await args.db.all<{ path: string }>(
    `
      SELECT path
      FROM file
      WHERE repo_id = ?
        AND is_binary = FALSE
        AND path LIKE ?
      ORDER BY path
      LIMIT ?
    `,
    [args.repoId, `${dir}/%`, args.config.semDirCandidateLimit]
  );
  const candidatePaths = rows.map((row) => row.path).filter((p) => p !== args.hintPath);
  if (candidatePaths.length === 0) {
    return 0;
  }
  if (!useHintDbBudget(args.state)) {
    return 0;
  }
  const embeddingMap = await fetchEmbeddingMap(args.db, args.repoId, [
    args.hintPath,
    ...candidatePaths,
  ]);
  const hintEmbedding = embeddingMap.get(args.hintPath);
  if (!hintEmbedding) {
    return 0;
  }
  let added = 0;
  for (const candidatePath of candidatePaths) {
    if (!SAFE_PATH_PATTERN.test(candidatePath)) {
      continue;
    }
    const embedding = embeddingMap.get(candidatePath);
    if (!embedding) {
      continue;
    }
    const similarity = structuralSimilarity(hintEmbedding, embedding);
    if (!Number.isFinite(similarity) || similarity < args.config.semThreshold) {
      continue;
    }
    const candidate = ensureCandidate(args.candidates, candidatePath);
    const reason = `artifact:hint_sem:${args.hintPath}:${candidatePath}`;
    if (applyHintReasonBoost(candidate, reason, args.weights.structural * similarity)) {
      added += 1;
      if (added >= limit) {
        break;
      }
    }
  }
  return added;
}

function hintNeighborRank(filePath: string): number {
  if (filePath.startsWith("src/") || filePath.startsWith("external/assay-kit/src/")) {
    return 0;
  }
  if (isTestLikePath(filePath)) {
    return 2;
  }
  if (filePath.startsWith("docs/")) {
    return 3;
  }
  return 1;
}

function isTestLikePath(filePath: string): boolean {
  return (
    /(^|\/)(tests?|__tests__|fixtures)\//.test(filePath) ||
    filePath.endsWith(".spec.ts") ||
    filePath.endsWith(".spec.tsx") ||
    filePath.endsWith(".test.ts") ||
    filePath.endsWith(".test.tsx")
  );
}

function parseEmbedding(
  vectorJson: string | null,
  vectorDims: number | bigint | null
): number[] | null {
  const dims =
    vectorDims === null ? null : typeof vectorDims === "bigint" ? Number(vectorDims) : vectorDims;
  if (!vectorJson || !dims || dims <= 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(vectorJson) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    const values: number[] = [];
    for (let i = 0; i < parsed.length && i < dims; i += 1) {
      const raw = parsed[i];
      const num = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(num)) {
        return null;
      }
      values.push(num);
    }
    return values.length === dims ? values : null;
  } catch {
    return null;
  }
}

function applyStructuralScores(
  candidates: CandidateInfo[],
  queryEmbedding: number[] | null,
  structuralWeight: number
): void {
  if (!queryEmbedding || structuralWeight <= 0) {
    return;
  }
  for (const candidate of candidates) {
    if (!candidate.embedding) {
      continue;
    }
    const similarity = structuralSimilarity(queryEmbedding, candidate.embedding);
    if (!Number.isFinite(similarity) || similarity <= 0) {
      continue;
    }
    candidate.semanticSimilarity = similarity;
    candidate.score += structuralWeight * similarity;
    candidate.reasons.add(`structural:${similarity.toFixed(2)}`);
  }
}

/**
 * Graph Layer: Apply graph-based scoring boosts (Phase 3.2)
 *
 * Uses precomputed metrics from graph_metrics table:
 * - inbound_count: Number of files that import this file (PageRank-like importance)
 * - importance_score: Normalized PageRank score [0, 1]
 *
 * Boosts are additive and scaled by profile weights.
 */
async function applyGraphLayerScores(
  db: DuckDBClient,
  repoId: number,
  candidates: CandidateInfo[],
  weights: ScoringWeights
): Promise<void> {
  // Skip if both weights are zero (disabled)
  if (weights.graphInbound <= 0 && weights.graphImportance <= 0) {
    return;
  }

  if (candidates.length === 0) {
    return;
  }

  // Fetch graph metrics for all candidate paths
  const paths = candidates.map((c) => c.path);
  const placeholders = paths.map(() => "?").join(", ");

  const metrics = await db.all<{
    path: string;
    inbound_count: number;
    importance_score: number;
  }>(
    `
    SELECT path, inbound_count, importance_score
    FROM graph_metrics
    WHERE repo_id = ? AND path IN (${placeholders})
    `,
    [repoId, ...paths]
  );

  // Build lookup map
  const metricsMap = new Map<string, { inbound: number; importance: number }>();
  for (const m of metrics) {
    metricsMap.set(m.path, {
      inbound: m.inbound_count,
      importance: m.importance_score,
    });
  }

  // Compute max inbound for normalization (log scale)
  let maxInbound = 1;
  for (const m of metrics) {
    if (m.inbound_count > maxInbound) {
      maxInbound = m.inbound_count;
    }
  }

  // Apply boosts
  for (const candidate of candidates) {
    const graphMetrics = metricsMap.get(candidate.path);
    if (!graphMetrics) {
      continue;
    }

    // Inbound dependency boost (log-scaled to dampen very high values)
    if (weights.graphInbound > 0 && graphMetrics.inbound > 0) {
      // Log-scale normalization: log(1 + count) / log(1 + max)
      const normalizedInbound = Math.log(1 + graphMetrics.inbound) / Math.log(1 + maxInbound);
      const inboundBoost = weights.graphInbound * normalizedInbound;
      candidate.score += inboundBoost;
      candidate.reasons.add(`graph:inbound:${graphMetrics.inbound}`);
    }

    // Importance score boost (already normalized to [0, 1])
    if (weights.graphImportance > 0 && graphMetrics.importance > 0) {
      const importanceBoost = weights.graphImportance * graphMetrics.importance;
      candidate.score += importanceBoost;
      candidate.reasons.add(`graph:importance:${graphMetrics.importance.toFixed(2)}`);
    }
  }
}

/**
 * Apply co-change scores based on git history.
 * Files that frequently change together with editing_path get boosted.
 *
 * Phase 4: Co-change graph integration.
 *
 * @param db - DuckDB client
 * @param repoId - Repository ID
 * @param candidates - Candidate files to score
 * @param weights - Scoring weights (uses cochange weight)
 * @param editingPath - Currently edited file path (optional)
 */
async function applyCochangeScores(
  db: DuckDBClient,
  repoId: number,
  candidates: CandidateInfo[],
  weights: ScoringWeights,
  editingPath?: string
): Promise<void> {
  // Skip if cochange weight is zero (disabled by default)
  if (weights.cochange <= 0) {
    return;
  }

  // Skip if no editing_path provided (co-change needs a reference file)
  if (!editingPath || candidates.length === 0) {
    return;
  }

  // Query co-change edges involving editing_path
  // Both directions: editing_path can be file1 or file2 (canonical ordering)
  const cochangeEdges = await db.all<{
    neighbor: string;
    cochange_count: number;
    confidence: number;
  }>(
    `
    SELECT
      CASE WHEN file1 = ? THEN file2 ELSE file1 END as neighbor,
      cochange_count,
      confidence
    FROM cochange
    WHERE repo_id = ? AND (file1 = ? OR file2 = ?)
    `,
    [editingPath, repoId, editingPath, editingPath]
  );

  if (cochangeEdges.length === 0) {
    return;
  }

  // Build lookup map: neighbor path -> (count, confidence)
  const cochangeMap = new Map<string, { count: number; confidence: number }>();
  for (const edge of cochangeEdges) {
    cochangeMap.set(edge.neighbor, {
      count: edge.cochange_count,
      confidence: edge.confidence ?? 0,
    });
  }

  // Compute max count for normalization
  let maxCount = 1;
  for (const edge of cochangeEdges) {
    if (edge.cochange_count > maxCount) {
      maxCount = edge.cochange_count;
    }
  }

  // Apply cochange boost to candidates
  for (const candidate of candidates) {
    const cochange = cochangeMap.get(candidate.path);
    if (!cochange || cochange.count <= 0) {
      continue;
    }

    // Normalize cochange count using log scale (similar to inbound boost)
    const normalizedCount = Math.log(1 + cochange.count) / Math.log(1 + maxCount);

    // Weight the boost by confidence (Jaccard similarity) for quality
    // Final boost = weight * normalized_count * confidence
    const confidenceFactor = Math.max(cochange.confidence, MIN_COCHANGE_CONFIDENCE_FLOOR);
    const cochangeBoost = weights.cochange * normalizedCount * confidenceFactor;

    candidate.score += cochangeBoost;
    candidate.reasons.add(`cochange:${cochange.count}:${(cochange.confidence * 100).toFixed(0)}%`);
  }
}

async function fetchEmbeddingMap(
  db: DuckDBClient,
  repoId: number,
  paths: string[]
): Promise<Map<string, number[]>> {
  const map = new Map<string, number[]>();
  if (paths.length === 0) {
    return map;
  }
  const placeholders = paths.map(() => "?").join(", ");
  const rows = await db.all<{
    path: string;
    vector_json: string | null;
    vector_dims: number | null;
  }>(
    `
      SELECT path, vector_json, dims AS vector_dims
      FROM file_embedding
      WHERE repo_id = ? AND path IN (${placeholders})
    `,
    [repoId, ...paths]
  );

  for (const row of rows) {
    const embedding = parseEmbedding(row.vector_json, row.vector_dims);
    if (embedding) {
      map.set(row.path, embedding);
    }
  }
  return map;
}

async function loadFileContent(
  db: DuckDBClient,
  repoId: number,
  filePath: string
): Promise<FileContentCacheEntry | null> {
  const rows = await db.all<FileWithEmbeddingRow>(
    `
      SELECT f.path, f.lang, f.ext, f.is_binary, b.content, fe.vector_json, fe.dims AS vector_dims
      FROM file f
      JOIN blob b ON b.hash = f.blob_hash
      LEFT JOIN file_embedding fe
        ON fe.repo_id = f.repo_id
       AND fe.path = f.path
      WHERE f.repo_id = ? AND f.path = ?
      LIMIT 1
    `,
    [repoId, filePath]
  );
  const row = rows[0];
  if (!row || row.is_binary || row.content === null) {
    return null;
  }
  const totalLines = row.content.length === 0 ? 0 : row.content.split(/\r?\n/).length;
  return {
    content: row.content,
    lang: row.lang,
    ext: row.ext,
    totalLines,
    embedding: parseEmbedding(row.vector_json ?? null, row.vector_dims ?? null),
  };
}

function selectSnippet(snippets: SnippetRow[], matchLine: number | null): SnippetRow | null {
  const firstSnippet = snippets[0];
  if (!firstSnippet) {
    return null;
  }
  if (matchLine === null) {
    return firstSnippet;
  }
  const containing = snippets.find(
    (snippet) => matchLine >= snippet.start_line && matchLine <= snippet.end_line
  );
  if (containing) {
    return containing;
  }
  if (matchLine < firstSnippet.start_line) {
    return firstSnippet;
  }
  const lastSnippet = snippets[snippets.length - 1];
  return lastSnippet ?? firstSnippet;
}

function buildSnippetPreview(content: string, startLine: number, endLine: number): string {
  const lines = content.split(/\r?\n/);
  const startIndex = Math.max(0, Math.min(startLine - 1, lines.length));
  const endIndex = Math.max(startIndex, Math.min(endLine, lines.length));
  const snippet = lines.slice(startIndex, endIndex).join("\n");
  if (snippet.length <= 240) {
    return snippet;
  }
  return `${snippet.slice(0, 239)}…`;
}

/**
 * トークン数を推定（コンテンツベース）
 * 実際のGPTトークナイザーを使用して正確にカウント
 *
 * @param content - ファイル全体のコンテンツ
 * @param startLine - 開始行（1-indexed）
 * @param endLine - 終了行（1-indexed）
 * @returns 推定トークン数
 */
function estimateTokensFromContent(content: string, startLine: number, endLine: number): number {
  const lines = content.split(/\r?\n/);
  const startIndex = Math.max(0, startLine - 1);
  const endIndex = Math.min(endLine, lines.length);
  const selectedLines = lines.slice(startIndex, endIndex);
  const text = selectedLines.join("\n");

  try {
    // 実際のGPTトークナイザーを使用
    return encodeGPT(text).length;
  } catch (error) {
    // フォールバック: 平均的な英語テキストで4文字 ≈ 1トークン
    console.warn("Token encoding failed, using character-based fallback", error);
    return Math.max(1, Math.ceil(text.length / 4));
  }
}

/**
 * 複数単語クエリを単語分割してOR検索条件を構築
 * @param query - 検索クエリ文字列
 * @returns 単語配列（2文字以下を除外）
 */
function splitQueryWords(query: string): string[] {
  // 空白、スラッシュ、ハイフン、アンダースコアで分割
  const words = query.split(/[\s/\-_]+/).filter((w) => w.length > 2);
  return words.length > 0 ? words : [query]; // 全て除外された場合は元のクエリを使用
}

function normalizeMetadataFilterKey(
  rawKey: string
): { key: string; source?: MetadataSourceTag; strict?: boolean } | null {
  if (!rawKey) {
    return null;
  }
  const normalized = rawKey.toLowerCase();
  const alias = METADATA_ALIAS_MAP.get(normalized);
  if (alias) {
    return { ...alias };
  }
  for (const entry of METADATA_KEY_PREFIXES) {
    if (normalized.startsWith(entry.prefix)) {
      const remainder = normalized.slice(entry.prefix.length);
      if (!remainder) {
        return null;
      }
      return {
        key: remainder,
        source: entry.source,
        ...(entry.strict !== undefined && { strict: entry.strict }),
      };
    }
  }
  return null;
}

function normalizeFilterValues(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    const values: string[] = [];
    for (const item of value) {
      if (typeof item === "string") {
        const trimmed = item.trim();
        if (trimmed) {
          values.push(trimmed);
        }
      }
    }
    return values;
  }
  return [];
}

function normalizeMetadataFiltersParam(input: unknown): MetadataFilter[] {
  if (!input || typeof input !== "object") {
    return [];
  }
  const filters: MetadataFilter[] = [];
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const normalizedKey = normalizeMetadataFilterKey(rawKey);
    if (!normalizedKey) {
      continue;
    }
    const values = normalizeFilterValues(rawValue);
    if (values.length === 0) {
      continue;
    }
    const filter: MetadataFilter = {
      key: normalizedKey.key,
      values,
      source: normalizedKey.source,
    };
    if (normalizedKey.strict !== undefined) {
      filter.strict = normalizedKey.strict;
    }
    filters.push(filter);
  }
  return filters;
}

function mergeMetadataFilters(filters: MetadataFilter[]): MetadataFilter[] {
  const merged = new Map<string, MetadataFilter>();
  for (const filter of filters) {
    if (filter.values.length === 0) continue;
    const mapKey = `${filter.source ?? "*"}::${filter.key}::${filter.strict ? "strict" : "hint"}`;
    const existing = merged.get(mapKey);
    if (existing) {
      const existingSet = new Set(existing.values.map((val) => val.toLowerCase()));
      for (const value of filter.values) {
        if (!existingSet.has(value.toLowerCase())) {
          existing.values.push(value);
          existingSet.add(value.toLowerCase());
        }
      }
    } else {
      const entry: MetadataFilter = {
        key: filter.key,
        source: filter.source,
        values: [...filter.values],
      };
      if (filter.strict !== undefined) {
        entry.strict = filter.strict;
      }
      merged.set(mapKey, entry);
    }
  }
  return Array.from(merged.values());
}

function parseInlineMetadataFilters(query: string): {
  cleanedQuery: string;
  filters: MetadataFilter[];
} {
  if (!query) {
    return { cleanedQuery: "", filters: [] };
  }

  const matches: Array<{ start: number; end: number; filter: MetadataFilter }> = [];
  const pattern = /(\b[\w.]+):("[^"]+"|'[^']+'|[^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(query)) !== null) {
    const normalizedKey = normalizeMetadataFilterKey(match[1] ?? "");
    if (!normalizedKey) {
      continue;
    }
    let rawValue = match[2] ?? "";
    if (
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
    ) {
      rawValue = rawValue.slice(1, -1);
    }
    const value = rawValue.trim();
    if (!value) {
      continue;
    }
    const filter: MetadataFilter = {
      key: normalizedKey.key,
      source: normalizedKey.source,
      values: [value],
    };
    if (normalizedKey.strict !== undefined) {
      filter.strict = normalizedKey.strict;
    }
    matches.push({
      start: match.index,
      end: pattern.lastIndex,
      filter,
    });
  }

  if (matches.length === 0) {
    return { cleanedQuery: query.trim(), filters: [] };
  }

  let cleaned = "";
  let lastIndex = 0;
  for (const info of matches) {
    cleaned += query.slice(lastIndex, info.start);
    lastIndex = info.end;
  }
  cleaned += query.slice(lastIndex);
  const normalizedQuery = cleaned.replace(/\s{2,}/g, " ").trim();
  return {
    cleanedQuery: normalizedQuery,
    filters: mergeMetadataFilters(matches.map((m) => m.filter)),
  };
}

function buildMetadataFilterConditions(
  filters: MetadataFilter[],
  alias: "f" | "mk" = "f"
): Array<{ sql: string; params: unknown[] }> {
  // SQL Injection対策: aliasをリテラル型で制限し、念のため検証
  if (!["f", "mk"].includes(alias)) {
    throw new Error(`Invalid SQL alias: ${alias}`);
  }
  const clauses: Array<{ sql: string; params: unknown[] }> = [];
  for (const filter of filters) {
    if (!filter.key || filter.values.length === 0) {
      continue;
    }
    const likeClauses = filter.values.map(() => "mk.value ILIKE ?").join(" OR ");
    const whereParts = [`mk.repo_id = ${alias}.repo_id`, `mk.path = ${alias}.path`];
    const params: unknown[] = [];
    if (filter.source) {
      whereParts.push("mk.source = ?");
      params.push(filter.source);
    }
    whereParts.push("mk.key = ?");
    params.push(filter.key);
    whereParts.push(`(${likeClauses})`);
    params.push(...filter.values.map((value) => `%${value}%`));
    const sql = `EXISTS (SELECT 1 FROM document_metadata_kv mk WHERE ${whereParts.join(" AND ")})`;
    clauses.push({ sql, params });
  }
  return clauses;
}

function isTableMissingError(error: unknown, table: string): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes(`Table with name ${table}`) || error.message.includes(table);
}

async function safeMetadataQuery<T>(
  db: DuckDBClient,
  tableAvailability: TableAvailability,
  sql: string,
  params: unknown[]
): Promise<T[]> {
  if (!tableAvailability.hasMetadataTables) {
    return [];
  }
  try {
    return await db.all<T>(sql, params);
  } catch (error) {
    if (isTableMissingError(error, "document_metadata_kv")) {
      console.warn(
        "Metadata tables not found; disabling metadata filters and boosts until database is upgraded."
      );
      return [];
    }
    throw error;
  }
}

async function safeLinkQuery<T>(
  db: DuckDBClient,
  tableAvailability: TableAvailability,
  sql: string,
  params: unknown[]
): Promise<T[]> {
  if (!tableAvailability.hasLinkTable) {
    return [];
  }
  try {
    return await db.all<T>(sql, params);
  } catch (error) {
    if (isTableMissingError(error, "markdown_link")) {
      console.warn(
        "Markdown link table not found; inbound link boosting disabled until database is upgraded."
      );
      return [];
    }
    throw error;
  }
}

async function fetchMetadataOnlyCandidates(
  db: DuckDBClient,
  tableAvailability: TableAvailability,
  repoId: number,
  filters: MetadataFilter[],
  limit: number,
  pathPrefix?: string
): Promise<FileRow[]> {
  if (!tableAvailability.hasMetadataTables || filters.length === 0 || limit <= 0) {
    return [];
  }

  const filterClauses = buildMetadataFilterConditions(filters);
  const whereClauses = ["f.repo_id = ?"];
  const params: unknown[] = [repoId];
  if (pathPrefix) {
    whereClauses.push("f.path LIKE ?");
    params.push(`${pathPrefix}%`);
  }
  for (const clause of filterClauses) {
    whereClauses.push(clause.sql);
    params.push(...clause.params);
  }

  const sql = `
    SELECT f.path, f.lang, f.ext, b.content
    FROM file f
    JOIN blob b ON b.hash = f.blob_hash
    WHERE ${whereClauses.join(" AND ")}
    ORDER BY f.path
    LIMIT ?
  `;
  params.push(limit);

  try {
    return await db.all<FileRow>(sql, params);
  } catch (error) {
    if (isTableMissingError(error, "document_metadata_kv")) {
      console.warn(
        "Metadata tables not found; disabling metadata-only searches until database is upgraded."
      );
      return [];
    }
    throw error;
  }
}

async function fetchMetadataKeywordMatches(
  db: DuckDBClient,
  tableAvailability: TableAvailability,
  repoId: number,
  keywords: string[],
  filters: MetadataFilter[],
  limit: number,
  excludePaths: Set<string>,
  pathPrefix?: string
): Promise<FileRow[]> {
  if (!tableAvailability.hasMetadataTables || keywords.length === 0 || limit <= 0) {
    return [];
  }

  const keywordClauses = keywords.map(() => "mk.value ILIKE ?").join(" OR ");
  const params: unknown[] = [repoId, ...keywords.map((kw) => `%${kw}%`)];
  const whereClauses = ["mk.repo_id = ?", `(${keywordClauses})`];

  if (pathPrefix) {
    whereClauses.push("f.path LIKE ?");
    params.push(`${pathPrefix}%`);
  }

  if (excludePaths.size > 0) {
    const placeholders = Array.from(excludePaths)
      .map(() => "?")
      .join(", ");
    whereClauses.push(`f.path NOT IN (${placeholders})`);
    params.push(...excludePaths);
  }

  const filterClauses = buildMetadataFilterConditions(filters, "f");
  for (const clause of filterClauses) {
    whereClauses.push(clause.sql);
    params.push(...clause.params);
  }

  params.push(limit);

  const sql = `
    SELECT f.path, f.lang, f.ext, b.content, COUNT(*) AS score
    FROM document_metadata_kv mk
    JOIN file f ON f.repo_id = mk.repo_id AND f.path = mk.path
    JOIN blob b ON b.hash = f.blob_hash
    WHERE ${whereClauses.join(" AND ")}
    GROUP BY f.path, f.lang, f.ext, b.content
    ORDER BY score DESC, f.path
    LIMIT ?
  `;

  const rows = await safeMetadataQuery<FileRow>(db, tableAvailability, sql, params);
  return rows.map((row) => ({ ...row, score: Number(row.score ?? 1) }));
}

async function loadMetadataForPaths(
  db: DuckDBClient,
  tableAvailability: TableAvailability,
  repoId: number,
  paths: string[]
): Promise<Map<string, MetadataEntry[]>> {
  const result = new Map<string, MetadataEntry[]>();
  if (!tableAvailability.hasMetadataTables || paths.length === 0) {
    return result;
  }

  const placeholders = paths.map(() => "?").join(", ");
  const sql = `
    SELECT path, key, value, source
    FROM document_metadata_kv
    WHERE repo_id = ? AND path IN (${placeholders})
  `;
  const rows = await safeMetadataQuery<{
    path: string;
    key: string;
    value: string;
    source: string | null;
  }>(db, tableAvailability, sql, [repoId, ...paths]);

  for (const row of rows) {
    if (!result.has(row.path)) {
      result.set(row.path, []);
    }
    result.get(row.path)!.push({
      key: row.key,
      value: row.value,
      source: (row.source as MetadataSourceTag) ?? undefined,
    });
  }
  return result;
}

async function loadInboundLinkCounts(
  db: DuckDBClient,
  tableAvailability: TableAvailability,
  repoId: number,
  paths: string[]
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!tableAvailability.hasLinkTable || paths.length === 0) {
    return counts;
  }
  const placeholders = paths.map(() => "?").join(", ");
  const sql = `
    SELECT resolved_path AS path, COUNT(*) AS inbound
    FROM markdown_link
    WHERE repo_id = ? AND resolved_path IS NOT NULL AND resolved_path IN (${placeholders})
    GROUP BY resolved_path
  `;
  const rows = await safeLinkQuery<{ path: string; inbound: number | bigint }>(
    db,
    tableAvailability,
    sql,
    [repoId, ...paths]
  );
  for (const row of rows) {
    const inboundValue =
      typeof row.inbound === "bigint" ? Number(row.inbound) : Number(row.inbound ?? 0);
    counts.set(row.path, inboundValue);
  }
  return counts;
}

function computeMetadataBoost(
  entries: MetadataEntry[] | undefined,
  keywordSet: Set<string>,
  filterValueSet: Set<string>
): number {
  if (!entries || entries.length === 0) {
    return 0;
  }
  let boost = 0;
  for (const entry of entries) {
    const valueLower = entry.value.toLowerCase();
    for (const keyword of keywordSet) {
      if (valueLower.includes(keyword)) {
        boost += METADATA_MATCH_WEIGHT;
        break;
      }
    }
    if (filterValueSet.has(valueLower)) {
      boost += METADATA_FILTER_MATCH_WEIGHT;
    }
  }
  return Math.min(boost, 1.5);
}

function computeInboundLinkBoost(count: number | undefined): number {
  let numericCount = count;
  if (typeof (numericCount as unknown) === "bigint") {
    numericCount = Number(numericCount);
  }
  if (!numericCount || numericCount <= 0) {
    return 0;
  }
  return Math.min(Math.log1p(numericCount) * INBOUND_LINK_WEIGHT, 1.0);
}

function candidateMatchesMetadataFilters(
  entries: MetadataEntry[] | undefined,
  filters: MetadataFilter[]
): boolean {
  if (filters.length === 0) {
    return true;
  }
  if (!entries || entries.length === 0) {
    return false;
  }
  return filters.every((filter) => {
    const expectedValues = filter.values.map((value) => value.toLowerCase());
    return entries.some((entry) => {
      if (entry.key !== filter.key) {
        return false;
      }
      if (filter.source && entry.source !== filter.source) {
        return false;
      }
      const lowerValue = entry.value.toLowerCase();
      return expectedValues.some((value) => lowerValue.includes(value));
    });
  });
}

/**
 * パス固有のマルチプライヤーを取得（最長プレフィックスマッチ）
 * 配列の順序に依存せず、常に最長一致のプレフィックスを選択
 * @param filePath - ファイルパス
 * @param profileConfig - ブーストプロファイル設定
 * @returns パス固有のマルチプライヤー（マッチなしの場合は1.0）
 */
function getPathMultiplier(filePath: string, profileConfig: BoostProfileConfig): number {
  let bestMatch = { prefix: "", multiplier: 1.0 };

  for (const { prefix, multiplier } of profileConfig.pathMultipliers) {
    if (filePath.startsWith(prefix) && prefix.length > bestMatch.prefix.length) {
      bestMatch = { prefix, multiplier };
    }
  }

  return bestMatch.multiplier;
}

/**
 * files_search専用のファイルタイプブースト適用（v0.7.0+: 設定可能な乗算的ペナルティ）
 * context_bundleと同じ乗算的ペナルティロジックを使用
 * @param path - ファイルパス
 * @param baseScore - 基本スコア（FTS BM25スコアまたは1.0）
 * @param profile - ブーストプロファイル
 * @param weights - スコアリングウェイト設定（乗算的ペナルティに使用）
 * @returns ブースト適用後のスコア
 */
function applyFileTypeBoost(
  path: string,
  baseScore: number,
  profileConfig: BoostProfileConfig,
  weights: ScoringWeights
): number {
  // Blacklisted directories that are almost always irrelevant for code context
  const blacklistedDirs = [
    ".cursor/",
    ".devcontainer/",
    ".serena/",
    "__mocks__/",
    "docs/",
    ".git/",
    "node_modules/",
  ];

  for (const dir of blacklistedDirs) {
    if (path.startsWith(dir)) {
      // ✅ Decoupled: Check denylist overrides from profile config
      if (profileConfig.denylistOverrides.includes(dir)) {
        continue;
      }
      // v1.0.0: Use multiplicative penalty instead of absolute -100
      return baseScore * weights.blacklistPenaltyMultiplier;
    }
  }

  const fileName = path.split("/").pop() ?? "";
  const ext = path.includes(".") ? path.substring(path.lastIndexOf(".")) : null;
  let multiplier = 1.0;

  // ✅ Step 1: Config files
  if (isConfigFile(path, fileName)) {
    multiplier *= profileConfig.fileTypeMultipliers.config;
    return baseScore * multiplier;
  }

  // ✅ Step 2: Documentation files
  const docExtensions = [".md", ".yaml", ".yml", ".mdc"];
  if (docExtensions.some((docExt) => path.endsWith(docExt))) {
    multiplier *= profileConfig.fileTypeMultipliers.doc;
    return baseScore * multiplier;
  }

  // ✅ Step 3: Implementation files with path-specific boosts
  const implMultiplier = profileConfig.fileTypeMultipliers.impl;

  // ✅ Use longest-prefix-match logic (order-independent)
  const pathBoost = getPathMultiplier(path, profileConfig);
  if (pathBoost !== 1.0) {
    multiplier *= implMultiplier * pathBoost;
    return baseScore * multiplier;
  }

  // Fallback for other src/ files
  if (path.startsWith("src/")) {
    if (ext === ".ts" || ext === ".tsx" || ext === ".js") {
      multiplier *= implMultiplier;
    }
  }

  // Test files: multiplicative penalty (v1.0.0)
  if (path.startsWith("tests/") || path.startsWith("test/")) {
    return baseScore * weights.testPenaltyMultiplier;
  }

  return baseScore * multiplier;
}

function applyCoverageBoost(
  candidate: CandidateInfo,
  extractedTerms: ExtractedTerms,
  weights: ScoringWeights
): void {
  // Skip for pure path-fallback candidates without text evidence
  if (
    candidate.reasons.has("fallback:path") &&
    candidate.keywordHits.size === 0 &&
    candidate.phraseHits === 0
  ) {
    return;
  }

  // Coverage boost is only meaningful for text/phrase evidence; skip if no text evidence at all
  if (candidate.keywordHits.size === 0 && candidate.phraseHits === 0) {
    return;
  }

  if (extractedTerms.keywords.length > 0 && candidate.keywordHits.size > 0) {
    const coverage = candidate.keywordHits.size / extractedTerms.keywords.length;
    const bonus = coverage * weights.textMatch * 0.4;
    candidate.score += bonus;
    candidate.reasons.add(`coverage:keywords:${coverage.toFixed(2)}`);
  }

  if (extractedTerms.phrases.length > 0 && candidate.phraseHits > 0) {
    const phraseCoverage = Math.min(1, candidate.phraseHits / extractedTerms.phrases.length);
    const bonus = phraseCoverage * weights.textMatch * 0.6;
    candidate.score += bonus;
    candidate.reasons.add(`coverage:phrases:${phraseCoverage.toFixed(2)}`);
  }
}

async function fetchPathFallbackCandidates(
  db: DuckDBClient,
  repoId: number,
  terms: string[],
  limit: number
): Promise<FileWithEmbeddingRow[]> {
  if (terms.length === 0 || limit <= 0) {
    return [];
  }

  const filters = terms.map(() => "f.path ILIKE ?").join(" OR ");
  const params: unknown[] = [repoId, ...terms.map((term) => `%${term}%`), limit];

  return await db.all<FileWithEmbeddingRow>(
    `
      SELECT f.path, f.lang, f.ext, f.is_binary, b.content, fe.vector_json, fe.dims AS vector_dims
      FROM file f
      JOIN blob b ON b.hash = f.blob_hash
      LEFT JOIN file_embedding fe
        ON fe.repo_id = f.repo_id
       AND fe.path = f.path
      WHERE f.repo_id = ?
        AND f.is_binary = FALSE
        AND (${filters})
      ORDER BY f.path
      LIMIT ?
    `,
    params
  );
}

/**
 * パスベースのスコアリングを適用（加算的ブースト）
 * goalのキーワード/フレーズがファイルパスに含まれる場合にスコアを加算
 */
function applyPathBasedScoring(
  candidate: CandidateInfo,
  lowerPath: string,
  weights: ScoringWeights,
  extractedTerms?: ExtractedTerms
): void {
  if (!extractedTerms || weights.pathMatch <= 0) {
    return;
  }

  // hasAddedScore gates additive boosts; pathMatchHits/reasons still track every hit for penalties/debugging.
  let hasAddedScore = false;

  // フレーズがパスに完全一致する場合（最高の重み）
  for (const phrase of extractedTerms.phrases) {
    if (lowerPath.includes(phrase)) {
      if (!hasAddedScore) {
        candidate.score += weights.pathMatch * 1.5; // 1.5倍のブースト
        hasAddedScore = true;
      }
      candidate.reasons.add(`path-phrase:${phrase}`);
      candidate.pathMatchHits++; // Issue #68: Track path match for penalty calculation
    }
  }

  // パスセグメントがマッチする場合（中程度の重み）
  const pathParts = lowerPath.split("/");
  for (const segment of extractedTerms.pathSegments) {
    if (pathParts.includes(segment)) {
      if (!hasAddedScore) {
        candidate.score += weights.pathMatch;
        hasAddedScore = true;
      }
      candidate.reasons.add(`path-segment:${segment}`);
      candidate.pathMatchHits++; // Issue #68: Track path match for penalty calculation
    }
  }

  // 通常のキーワードがパスに含まれる場合（低い重み）
  const matchedKeywords = new Set<string>();

  for (const keyword of extractedTerms.keywords) {
    if (lowerPath.includes(keyword)) {
      if (!hasAddedScore) {
        candidate.score += weights.pathMatch * 0.5; // 0.5倍のブースト
        hasAddedScore = true;
      }
      candidate.reasons.add(`path-keyword:${keyword}`);
      candidate.pathMatchHits++; // Issue #68: Track path match for penalty calculation
      matchedKeywords.add(keyword); // Track for abbreviation expansion
    }
  }

  // ADR 003: Abbreviation expansion for keywords with zero exact matches
  // Avoid double-counting by only expanding keywords that didn't match exactly
  // Skip abbreviation expansion for files that will be heavily penalized (test/config/lock files)
  const fileName = lowerPath.split("/").pop() ?? "";
  const testPatterns = [".spec.ts", ".spec.js", ".test.ts", ".test.js", ".spec.tsx", ".test.tsx"];
  const lockFiles = [
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "gemfile.lock",
    "cargo.lock",
    "poetry.lock",
  ];
  const configPatterns = [
    "tsconfig.json",
    "vite.config",
    "vitest.config",
    "eslint.config",
    "prettier.config",
    "package.json",
    ".env",
    "dockerfile",
  ];

  const shouldSkipAbbreviation =
    testPatterns.some((pattern) => lowerPath.endsWith(pattern)) ||
    lockFiles.some((lock) => fileName === lock) ||
    configPatterns.some((cfg) => fileName.includes(cfg));

  if (!shouldSkipAbbreviation) {
    for (const keyword of extractedTerms.keywords) {
      if (matchedKeywords.has(keyword)) {
        continue; // Skip keywords that already matched exactly
      }

      const expandedTerms = expandAbbreviations(keyword);

      // Try each expanded variant (except the original keyword itself)
      for (const term of expandedTerms) {
        if (term === keyword) continue; // Skip original to avoid duplicate check

        if (lowerPath.includes(term)) {
          // Lower weight (0.4x) for abbreviation-expanded matches
          if (!hasAddedScore) {
            candidate.score += weights.pathMatch * 0.4;
            hasAddedScore = true;
          }
          candidate.reasons.add(`abbr-path:${keyword}→${term}`);
          candidate.pathMatchHits++; // Count for penalty calculation
          break; // Only count first match per keyword to avoid over-boosting
        }
      }
    }
  }
}

/**
 * 乗算的ファイルペナルティを適用（v1.0.0+）
 * ブラックリストディレクトリ、テストファイル、lockファイルに乗算ペナルティ
 * v1.0.0: 絶対ペナルティ(-100)から乗算ペナルティ(×0.01など)に移行
 * @param weights - スコアリングウェイト設定（乗算ペナルティ係数を含む）
 * @param profile - boost_profile設定（denylistOverridesなど）
 * @returns true if severe penalty was applied (caller should skip further boosts)
 */
function applyMultiplicativeFilePenalties(
  candidate: CandidateInfo,
  path: string,
  lowerPath: string,
  fileName: string,
  weights: ScoringWeights,
  profileConfig: BoostProfileConfig
): boolean {
  // Returns true if a severe penalty was applied (should skip further boosts)

  // Blacklisted directories - apply strong multiplicative penalty (99% reduction)
  // v1.0.0: test/ and tests/ removed - handled by testPenaltyMultiplier instead
  const blacklistedDirs = [
    ".cursor/",
    ".devcontainer/",
    ".serena/",
    "__mocks__/",
    "docs/",
    ".git/",
    ".github/",
    "node_modules/",
    "db/migrate/",
    "db/migrations/",
    "config/",
    "dist/",
    "build/",
    "out/",
    "coverage/",
    ".vscode/",
    ".idea/",
    "tmp/",
    "temp/",
  ];

  for (const dir of blacklistedDirs) {
    if (path.startsWith(dir)) {
      // ✅ Decoupled: Check denylist overrides from profile config
      if (profileConfig.denylistOverrides.includes(dir)) {
        continue; // Skip this blacklisted directory
      }
      // v1.0.0: Use multiplicative penalty instead of absolute -100
      candidate.scoreMultiplier *= weights.blacklistPenaltyMultiplier;
      candidate.reasons.add("penalty:blacklisted-dir");
      return true; // Signal to skip further boosts - this is the strongest penalty
    }
  }

  if (isSuppressedPath(path)) {
    // v1.0.0: Use multiplicative penalty instead of absolute -100
    candidate.scoreMultiplier *= weights.blacklistPenaltyMultiplier;
    candidate.reasons.add("penalty:suppressed");
    return true; // Signal to skip further boosts
  }

  // Test files - strong multiplicative penalty (95% reduction)
  const testPatterns = [".spec.ts", ".spec.js", ".test.ts", ".test.js", ".spec.tsx", ".test.tsx"];
  if (testPatterns.some((pattern) => lowerPath.endsWith(pattern))) {
    candidate.scoreMultiplier *= weights.testPenaltyMultiplier;
    candidate.reasons.add("penalty:test-file");
    return true; // Signal to skip further boosts
  }

  // Lock files - very strong multiplicative penalty (99% reduction)
  const lockFiles = [
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "Gemfile.lock",
    "Cargo.lock",
    "poetry.lock",
  ];
  if (lockFiles.some((lockFile) => fileName === lockFile)) {
    candidate.scoreMultiplier *= weights.lockPenaltyMultiplier;
    candidate.reasons.add("penalty:lock-file");
    return true; // Signal to skip further boosts
  }

  // v1.0.0: No penalty applied, allow further boosts/penalties
  return false;
}

/**
 * ファイルタイプ別の乗算的ペナルティ/ブーストを適用（v0.7.0+）
 * profile="docs": ドキュメントファイルをブースト
 * profile="default": ドキュメントファイルにペナルティ、実装ファイルをブースト
 */
function applyFileTypeMultipliers(
  candidate: CandidateInfo,
  path: string,
  ext: string | null,
  profileConfig: BoostProfileConfig,
  weights: ScoringWeights
): void {
  const fileName = path.split("/").pop() ?? "";
  const lowerPath = path.toLowerCase();

  // Very low value: schemas, fixtures, testdata, examples, baseline
  const schemaJson = lowerPath.endsWith(".schema.json") || lowerPath.includes("/schemas/");
  const isFixture =
    lowerPath.includes("/fixtures/") ||
    lowerPath.includes("/fixture/") ||
    lowerPath.includes("/testdata/");
  const isExample = lowerPath.includes("/examples/") || lowerPath.includes("/example/");
  const isBaseline = lowerPath.includes("baseline") || lowerPath.includes("golden");
  if (schemaJson || isFixture || isExample || isBaseline) {
    candidate.scoreMultiplier *= weights.configPenaltyMultiplier;
    candidate.reasons.add("penalty:low-value-file");
    return;
  }

  // ✅ Step 1: Low-value files (v1.0.0: syntax/perf/legal/migration)
  // Apply configPenaltyMultiplier (strong penalty) to rarely useful file types
  const isSyntaxGrammar =
    path.includes("/syntaxes/") &&
    (lowerPath.endsWith(".tmlanguage") ||
      lowerPath.endsWith(".tmlanguage.json") ||
      lowerPath.endsWith(".tmtheme") ||
      lowerPath.endsWith(".plist"));
  const isPerfData =
    lowerPath.includes(".perf.data") ||
    lowerPath.includes(".perf-data") ||
    lowerPath.includes("-perf-data");
  const isLegalFile =
    fileName.toLowerCase().includes("thirdpartynotices") ||
    fileName.toLowerCase() === "cgmanifest.json";
  const isMigrationFile = lowerPath.includes("migrate") || lowerPath.includes("migration");

  if (isSyntaxGrammar || isPerfData || isLegalFile || isMigrationFile) {
    candidate.scoreMultiplier *= weights.configPenaltyMultiplier;
    candidate.reasons.add("penalty:low-value-file");
    return; // Don't apply impl boosts
  }

  // ✅ Step 2: Config files
  if (isConfigFile(path, fileName)) {
    candidate.scoreMultiplier *= profileConfig.fileTypeMultipliers.config;
    candidate.reasons.add("penalty:config-file");
    return; // Don't apply impl boosts to config files
  }

  // ✅ Step 3: Documentation files
  const docExtensions = [".md", ".yaml", ".yml", ".mdc"];
  if (docExtensions.some((docExt) => path.endsWith(docExt))) {
    const docMultiplier = profileConfig.fileTypeMultipliers.doc;
    candidate.scoreMultiplier *= docMultiplier;

    if (docMultiplier > 1.0) {
      candidate.reasons.add("boost:doc-file");
    } else if (docMultiplier < 1.0) {
      candidate.reasons.add("penalty:doc-file");
    }
    return; // Don't apply impl boosts to docs
  }

  // ✅ Step 4: Implementation files with path-specific boosts
  const implMultiplier = profileConfig.fileTypeMultipliers.impl;

  // ✅ Use longest-prefix-match logic (order-independent)
  const pathBoost = getPathMultiplier(path, profileConfig);
  if (pathBoost !== 1.0) {
    candidate.scoreMultiplier *= implMultiplier * pathBoost;

    // Add specific reason based on matched path
    if (path.startsWith("src/app/")) {
      candidate.reasons.add("boost:app-file");
    } else if (path.startsWith("src/components/")) {
      candidate.reasons.add("boost:component-file");
    } else if (path.startsWith("src/lib/")) {
      candidate.reasons.add("boost:lib-file");
    }
    return;
  }

  // Fallback for other src/ files
  if (path.startsWith("src/")) {
    if (ext === ".ts" || ext === ".tsx" || ext === ".js") {
      candidate.scoreMultiplier *= implMultiplier;
      candidate.reasons.add("boost:impl-file");
    }
  }
}

/**
 * contextBundle専用のブーストプロファイル適用（v1.0.0: 乗算ペナルティモデル）
 * 複雑度を削減するために3つのヘルパー関数に分割：
 * 1. applyPathBasedScoring: パスベースの加算的スコアリング
 * 2. applyMultiplicativeFilePenalties: 乗算的ペナルティ（blacklist/test/lock）
 * 3. applyFileTypeMultipliers: 乗算的ペナルティ/ブースト（doc/config/impl）
 *
 * v1.0.0 CHANGES:
 * - 絶対ペナルティ(-100)を乗算ペナルティ(×0.01など)に置き換え
 * - すべてのペナルティが組み合わせ可能に（boost_profileとの相互作用が予測可能）
 * - v0.9.0の特別ケース処理（if profile === "docs"）が不要に
 *
 * SCORING PHASES:
 * 1. Additive phase: テキストマッチ、パスマッチ、依存関係、近接性を加算
 * 2. Multiplicative phase: ペナルティとブーストを scoreMultiplier に蓄積
 * 3. Final application: score *= scoreMultiplier（最終段階で一度だけ適用）
 */
function applyBoostProfile(
  candidate: CandidateInfo,
  row: { path: string; ext: string | null },
  profileConfig: BoostProfileConfig,
  weights: ScoringWeights,
  extractedTerms?: ExtractedTerms
): void {
  const { path, ext } = row;
  const lowerPath = path.toLowerCase();
  const fileName = path.split("/").pop() ?? "";

  // Step 1: パスベースのスコアリング（加算的ブースト）
  applyPathBasedScoring(candidate, lowerPath, weights, extractedTerms);

  // Step 2: 乗算的ペナルティ（ブラックリスト、テスト、lock）
  // v1.0.0: Returns true if severe penalty applied (should skip further boosts)
  const skipFurtherBoosts = applyMultiplicativeFilePenalties(
    candidate,
    path,
    lowerPath,
    fileName,
    weights,
    profileConfig
  );

  // Step 3: ファイルタイプ別の乗算的ペナルティ/ブースト
  // Skip if severe penalty was applied (blacklist/test/lock files shouldn't get impl boosts)
  if (!skipFurtherBoosts) {
    applyFileTypeMultipliers(candidate, path, ext, profileConfig, weights);
  }
}

export async function filesSearch(
  context: ServerContext,
  params: FilesSearchParams
): Promise<FilesSearchResult[]> {
  const { db, repoId } = context;
  const rawQuery = params.query ?? "";
  const inlineMetadata = parseInlineMetadataFilters(rawQuery);
  const paramFilters = normalizeMetadataFiltersParam(params.metadata_filters);
  const metadataFilters = mergeMetadataFilters([...inlineMetadata.filters, ...paramFilters]);
  const strictMetadataFilters = metadataFilters.filter((filter) => filter.strict);
  const hintMetadataFilters = metadataFilters.filter((filter) => !filter.strict);
  const hasStrictMetadataFilters = strictMetadataFilters.length > 0;
  const hasHintMetadataFilters = hintMetadataFilters.length > 0;
  const hasAnyMetadataFilters = metadataFilters.length > 0;
  let cleanedQuery = inlineMetadata.cleanedQuery;
  let hasTextQuery = cleanedQuery.length > 0;
  if (!hasTextQuery && hasHintMetadataFilters) {
    cleanedQuery = hintMetadataFilters
      .flatMap((filter) => filter.values)
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .join(" ");
    cleanedQuery = cleanedQuery.trim();
    hasTextQuery = cleanedQuery.length > 0;
  }

  const pathPrefix =
    params.path_prefix && params.path_prefix.length > 0 ? params.path_prefix : undefined;

  const metadataValueSeed = metadataFilters
    .flatMap((filter) => filter.values)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .join(" ");
  if (metadataValueSeed.length > 0) {
    cleanedQuery = `${cleanedQuery} ${metadataValueSeed}`.trim();
    hasTextQuery = cleanedQuery.length > 0;
  }

  if (!hasTextQuery && !hasAnyMetadataFilters) {
    throw new Error(
      "files_search requires a query or metadata_filters. Provide keywords or structured filters to continue."
    );
  }

  const limit = normalizeLimit(params.limit);
  const ftsStatus = await getFreshFtsStatus(context);
  const hasFTS = ftsStatus.ready;
  const metadataClauses = buildMetadataFilterConditions(strictMetadataFilters);
  const candidateRows: FileRow[] = [];

  if (hasTextQuery) {
    let sql: string;
    let values: unknown[];

    if (hasFTS) {
      const conditions = ["f.repo_id = ?"];
      values = [repoId];

      if (params.lang) {
        conditions.push("COALESCE(f.lang, '') = ?");
        values.push(params.lang);
      }
      if (params.ext) {
        conditions.push("COALESCE(f.ext, '') = ?");
        values.push(params.ext);
      }
      if (params.path_prefix) {
        conditions.push("f.path LIKE ?");
        values.push(`${params.path_prefix}%`);
      }
      for (const clause of metadataClauses) {
        conditions.push(clause.sql);
        values.push(...clause.params);
      }

      sql = `
        SELECT f.path, f.lang, f.ext, b.content, fts.score
        FROM file f
        JOIN blob b ON b.hash = f.blob_hash
        JOIN (
          SELECT hash, fts_main_blob.match_bm25(hash, ?) AS score
          FROM blob
          WHERE score IS NOT NULL
        ) fts ON fts.hash = b.hash
        WHERE ${conditions.join(" AND ")}
        ORDER BY fts.score DESC
        LIMIT ?
      `;

      values.unshift(cleanedQuery);
      values.push(limit);
    } else {
      const conditions = ["f.repo_id = ?", "b.content IS NOT NULL"];
      values = [repoId];

      const words = splitQueryWords(cleanedQuery);
      if (words.length === 1) {
        conditions.push("b.content ILIKE '%' || ? || '%'");
        values.push(cleanedQuery);
      } else {
        const wordConditions = words.map(() => "b.content ILIKE '%' || ? || '%'");
        conditions.push(`(${wordConditions.join(" OR ")})`);
        values.push(...words);
      }

      if (params.lang) {
        conditions.push("COALESCE(f.lang, '') = ?");
        values.push(params.lang);
      }
      if (params.ext) {
        conditions.push("COALESCE(f.ext, '') = ?");
        values.push(params.ext);
      }
      if (params.path_prefix) {
        conditions.push("f.path LIKE ?");
        values.push(`${params.path_prefix}%`);
      }
      for (const clause of metadataClauses) {
        conditions.push(clause.sql);
        values.push(...clause.params);
      }

      sql = `
        SELECT f.path, f.lang, f.ext, b.content
        FROM file f
        JOIN blob b ON b.hash = f.blob_hash
        WHERE ${conditions.join(" AND ")}
        ORDER BY f.path
        LIMIT ?
      `;

      values.push(limit);
    }

    const textRows = await db.all<FileRow>(sql, values);
    candidateRows.push(...textRows);
  }

  if (!hasTextQuery && hasAnyMetadataFilters) {
    const metadataOnlyRows = await fetchMetadataOnlyCandidates(
      db,
      context.tableAvailability,
      repoId,
      metadataFilters,
      limit * 2,
      pathPrefix
    );
    for (const row of metadataOnlyRows) {
      row.score = 1 + metadataFilters.length * 0.2;
    }
    candidateRows.push(...metadataOnlyRows);
  }

  if (hasTextQuery) {
    const metadataKeywords = splitQueryWords(cleanedQuery.toLowerCase()).map((kw) =>
      kw.toLowerCase()
    );
    if (metadataKeywords.length > 0) {
      const excludePaths = new Set(candidateRows.map((row) => row.path));
      const metadataRows = await fetchMetadataKeywordMatches(
        db,
        context.tableAvailability,
        repoId,
        metadataKeywords,
        metadataFilters,
        limit * 2,
        excludePaths,
        pathPrefix
      );
      candidateRows.push(...metadataRows);
    }
  }

  if (candidateRows.length === 0) {
    return [];
  }

  const rowMap = new Map<string, FileRow>();
  for (const row of candidateRows) {
    const base = row.score ?? (hasTextQuery ? 1.0 : 0.8);
    const existing = rowMap.get(row.path);
    const existingScore = existing?.score ?? (hasTextQuery ? 1.0 : 0.8);
    if (!existing || base > existingScore) {
      rowMap.set(row.path, { ...row, score: base });
    }
  }

  const dedupedRows = Array.from(rowMap.values()).sort((a, b) => (b.score ?? 1) - (a.score ?? 1));
  const limitedRows = dedupedRows.slice(0, limit);
  const paths = limitedRows.map((row) => row.path);
  const metadataMap = await loadMetadataForPaths(db, context.tableAvailability, repoId, paths);
  const inboundCounts = await loadInboundLinkCounts(db, context.tableAvailability, repoId, paths);
  const metadataKeywordSet = hasTextQuery
    ? new Set(splitQueryWords(cleanedQuery.toLowerCase()).map((kw) => kw.toLowerCase()))
    : new Set<string>();
  const filterValueSet = new Set(
    metadataFilters.flatMap((filter) => filter.values.map((value) => value.toLowerCase()))
  );

  const boostProfile: BoostProfileName =
    params.boost_profile ??
    (hasHintMetadataFilters ? "balanced" : hasStrictMetadataFilters ? "docs" : "default");
  const baseProfileConfig = getBoostProfile(boostProfile);
  const cachedMerged = mergedPathMultiplierCache.get(boostProfile);
  const mergedPathMultipliers =
    cachedMerged ??
    mergePathPenaltyEntries(baseProfileConfig.pathMultipliers, [], serverConfig.pathPenalties);
  if (!cachedMerged) {
    mergedPathMultiplierCache.set(boostProfile, mergedPathMultipliers);
  }
  const profileConfig: BoostProfileConfig = {
    ...baseProfileConfig,
    pathMultipliers: mergedPathMultipliers,
  };
  const weights = loadScoringProfile(null);
  const options = parseOutputOptions(params);
  const previewQuery = hasTextQuery
    ? cleanedQuery
    : (metadataFilters[0]?.values[0] ?? rawQuery.trim());

  return limitedRows
    .map((row) => {
      let preview: string | undefined;
      let matchLine: number;
      const previewSource = previewQuery || row.path;

      if (options.includePreview) {
        const previewData = buildPreview(row.content ?? "", previewSource);
        preview = previewData.preview;
        matchLine = previewData.line;
      } else {
        matchLine = findFirstMatchLine(row.content ?? "", previewSource);
      }

      const metadataEntries = metadataMap.get(row.path);
      const metadataBoost = computeMetadataBoost(
        metadataEntries,
        metadataKeywordSet,
        filterValueSet
      );
      const inboundBoost = computeInboundLinkBoost(inboundCounts.get(row.path));
      const baseScore = (row.score ?? (hasTextQuery ? 1.0 : 0.8)) + metadataBoost + inboundBoost;
      const boostedScore =
        boostProfile === "none"
          ? baseScore
          : applyFileTypeBoost(row.path, baseScore, profileConfig, weights);

      const result: FilesSearchResult = {
        path: row.path,
        matchLine,
        lang: row.lang,
        ext: row.ext,
        score: boostedScore,
      };

      if (preview !== undefined) {
        result.preview = preview;
      }

      return result;
    })
    .filter((result) => result.score > SCORE_FILTER_THRESHOLD) // v1.0.0: Filter out extremely low-scored files (multiplicative penalties)
    .sort((a, b) => b.score - a.score);
}

// snippetsGet has been extracted to ./handlers/snippets-get.ts and re-exported above

// ============================================================================
// Issue #68: Path/Large File Penalty Helper Functions
// ============================================================================

/**
 * v1.0.0: Score filtering threshold for multiplicative penalty model
 * Files with score < threshold are filtered out (unless they are hint paths)
 * Default: 0.05 removes files with >95% penalty while keeping relevant files
 * Can be overridden via KIRI_SCORE_THRESHOLD environment variable
 */
const SCORE_FILTER_THRESHOLD = parseFloat(process.env.KIRI_SCORE_THRESHOLD ?? "0.05");

/**
 * 環境変数からペナルティ機能フラグを読み取る
 */
function readPenaltyFlags(): PenaltyFlags {
  return {
    pathPenalty: process.env.KIRI_PATH_PENALTY === "1",
    largeFilePenalty: process.env.KIRI_LARGE_FILE_PENALTY === "1",
  };
}

/**
 * クエリ統計を計算（単語数と平均単語長）
 */
function computeQueryStats(goal: string): QueryStats {
  const words = goal
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const totalLength = words.reduce((sum, w) => sum + w.length, 0);
  return {
    wordCount: words.length,
    avgWordLength: words.length > 0 ? totalLength / words.length : 0,
  };
}

/**
 * Path Miss Penaltyをcandidateに適用（レガシー: Binary penalty）
 * 条件: wordCount >= 2 AND avgWordLength >= 4 AND pathMatchHits === 0
 *
 * @deprecated Use applyGraduatedPenalty() instead (ADR 002)
 */
function applyPathMissPenalty(candidate: CandidateInfo, queryStats: QueryStats): void {
  if (queryStats.wordCount >= 2 && queryStats.avgWordLength >= 4 && candidate.pathMatchHits === 0) {
    candidate.score += PATH_MISS_DELTA; // -0.5
    recordPenaltyEvent(candidate, "path-miss", PATH_MISS_DELTA, {
      wordCount: queryStats.wordCount,
      avgWordLength: queryStats.avgWordLength,
      pathMatchHits: candidate.pathMatchHits,
    });
  }
}

/**
 * 段階的ペナルティをcandidateに適用（Issue #68: Graduated Penalty）
 * ADR 002: Graduated Penalty System
 *
 * @param candidate Candidate to apply penalty to
 * @param queryStats Query statistics for eligibility check
 * @param config Graduated penalty configuration
 */
function applyGraduatedPenalty(
  candidate: CandidateInfo,
  queryStats: QueryStats,
  config: GraduatedPenaltyConfig
): void {
  const penalty = computeGraduatedPenalty(candidate.pathMatchHits, queryStats, config);

  if (penalty !== 0) {
    candidate.score += penalty;
    recordPenaltyEvent(candidate, "path-miss", penalty, {
      wordCount: queryStats.wordCount,
      avgWordLength: queryStats.avgWordLength,
      pathMatchHits: candidate.pathMatchHits,
      tier:
        candidate.pathMatchHits === 0
          ? "tier0"
          : candidate.pathMatchHits === 1
            ? "tier1"
            : candidate.pathMatchHits === 2
              ? "tier2"
              : "no-penalty",
    });
  }
}

/**
 * Large File Penaltyをcandidateに適用
 * 条件: totalLines > 500 AND matchLine > 120
 * TODO(Issue #68): Add "no symbol at match location" check after selectSnippet integration
 */
function applyLargeFilePenalty(candidate: CandidateInfo): void {
  const { totalLines, matchLine } = candidate;
  if (totalLines !== null && totalLines > 500 && matchLine !== null && matchLine > 120) {
    candidate.score += LARGE_FILE_DELTA; // -0.8
    recordPenaltyEvent(candidate, "large-file", LARGE_FILE_DELTA, {
      totalLines,
      matchLine,
    });
  }
}

/**
 * ペナルティイベントを記録（テレメトリ用）
 */
function recordPenaltyEvent(
  candidate: CandidateInfo,
  kind: "path-miss" | "large-file",
  delta: number,
  details: Record<string, unknown>
): void {
  candidate.penalties.push({ kind, delta, details });
  candidate.reasons.add(`penalty:${kind}`);
}

/**
 * pathMatchHits分布を計算（Issue #68: Telemetry）
 * LDE: 純粋関数として実装（副作用なし、イミュータブル）
 */
function computePathMatchDistribution(candidates: readonly CandidateInfo[]): PathMatchDistribution {
  let zero = 0;
  let one = 0;
  let two = 0;
  let three = 0;
  let fourPlus = 0;

  for (const candidate of candidates) {
    const hits = candidate.pathMatchHits;
    if (hits === 0) zero++;
    else if (hits === 1) one++;
    else if (hits === 2) two++;
    else if (hits === 3) three++;
    else fourPlus++;
  }

  return {
    zero,
    one,
    two,
    three,
    fourPlus,
    total: candidates.length,
  };
}

/**
 * スコア統計を計算（Issue #68: Telemetry）
 * LDE: 純粋関数として実装（副作用なし、イミュータブル）
 */
function computeScoreStats(candidates: readonly CandidateInfo[]): {
  min: number;
  max: number;
  mean: number;
  median: number;
} {
  if (candidates.length === 0) {
    return { min: 0, max: 0, mean: 0, median: 0 };
  }

  const scores = candidates.map((c) => c.score).sort((a, b) => a - b);
  const sum = scores.reduce((acc, s) => acc + s, 0);
  const mean = sum / scores.length;
  const median = scores[Math.floor(scores.length / 2)] ?? 0;

  return {
    min: scores[0] ?? 0,
    max: scores[scores.length - 1] ?? 0,
    mean,
    median,
  };
}

/**
 * ペナルティ適用状況を計算（Issue #68: Telemetry）
 * LDE: 純粋関数として実装（副作用なし、イミュータブル）
 */
function computePenaltyTelemetry(candidates: readonly CandidateInfo[]): PenaltyTelemetry {
  let pathMissPenalties = 0;
  let largeFilePenalties = 0;

  for (const candidate of candidates) {
    for (const penalty of candidate.penalties) {
      if (penalty.kind === "path-miss") pathMissPenalties++;
      if (penalty.kind === "large-file") largeFilePenalties++;
    }
  }

  return {
    pathMissPenalties,
    largeFilePenalties,
    totalCandidates: candidates.length,
    pathMatchDistribution: computePathMatchDistribution(candidates),
    scoreStats: computeScoreStats(candidates),
  };
}

/**
 * テレメトリーをファイル出力（Issue #68: Debug）
 * LDE: 副作用を分離（I/O操作）
 *
 * JSON Lines形式で /tmp/kiri-penalty-telemetry.jsonl に追記
 */
function logPenaltyTelemetry(telemetry: PenaltyTelemetry, queryStats: QueryStats): void {
  const dist = telemetry.pathMatchDistribution;
  const scores = telemetry.scoreStats;

  // JSON Lines形式でテレメトリーデータを記録
  const telemetryRecord = {
    timestamp: new Date().toISOString(),
    query: {
      wordCount: queryStats.wordCount,
      avgWordLength: queryStats.avgWordLength,
    },
    totalCandidates: telemetry.totalCandidates,
    pathMissPenalties: telemetry.pathMissPenalties,
    largeFilePenalties: telemetry.largeFilePenalties,
    pathMatchDistribution: {
      zero: dist.zero,
      one: dist.one,
      two: dist.two,
      three: dist.three,
      fourPlus: dist.fourPlus,
      total: dist.total,
      percentages: {
        zero: ((dist.zero / dist.total) * 100).toFixed(1),
        one: ((dist.one / dist.total) * 100).toFixed(1),
        two: ((dist.two / dist.total) * 100).toFixed(1),
        three: ((dist.three / dist.total) * 100).toFixed(1),
        fourPlus: ((dist.fourPlus / dist.total) * 100).toFixed(1),
      },
    },
    scoreStats: {
      min: scores.min.toFixed(2),
      max: scores.max.toFixed(2),
      mean: scores.mean.toFixed(2),
      median: scores.median.toFixed(2),
      // 最大ペナルティ(-0.8)との比率
      penaltyRatio: ((0.8 / scores.mean) * 100).toFixed(1) + "%",
    },
  };

  const telemetryFile = "/tmp/kiri-penalty-telemetry.jsonl";
  fs.appendFileSync(telemetryFile, JSON.stringify(telemetryRecord) + "\n");
}

/**
 * 環境変数から段階的ペナルティ設定を読み込む（Issue #68: Graduated Penalty）
 * LDE: 純粋関数（I/O分離、テスト可能）
 */
function readGraduatedPenaltyConfig(): GraduatedPenaltyConfig {
  return {
    enabled: process.env.KIRI_GRADUATED_PENALTY === "1",
    minWordCount: parseFloat(process.env.KIRI_PENALTY_MIN_WORD_COUNT || "2"),
    minAvgWordLength: parseFloat(process.env.KIRI_PENALTY_MIN_AVG_WORD_LENGTH || "4.0"),
    tier0Delta: parseFloat(process.env.KIRI_PENALTY_TIER_0 || "-0.8"),
    tier1Delta: parseFloat(process.env.KIRI_PENALTY_TIER_1 || "-0.4"),
    tier2Delta: parseFloat(process.env.KIRI_PENALTY_TIER_2 || "-0.2"),
  };
}

/**
 * 段階的ペナルティ値を計算（Issue #68: Graduated Penalty）
 * LDE: 純粋関数（副作用なし、参照透明性）
 *
 * ADR 002: Graduated Penalty System
 * - Tier 0 (pathMatchHits === 0): Strong penalty (no path evidence)
 * - Tier 1 (pathMatchHits === 1): Medium penalty (weak path evidence)
 * - Tier 2 (pathMatchHits === 2): Light penalty (moderate path evidence)
 * - Tier 3+ (pathMatchHits >= 3): No penalty (strong path evidence)
 *
 * Invariants:
 * - Result is always <= 0 (non-positive)
 * - More path hits → less penalty (monotonicity)
 * - Query must meet eligibility criteria
 *
 * @param pathMatchHits Number of path-based scoring matches
 * @param queryStats Query word count and average word length
 * @param config Graduated penalty configuration
 * @returns Penalty delta (always <= 0)
 */
function computeGraduatedPenalty(
  pathMatchHits: number,
  queryStats: QueryStats,
  config: GraduatedPenaltyConfig
): number {
  // Early return if query doesn't meet criteria
  if (
    queryStats.wordCount < config.minWordCount ||
    queryStats.avgWordLength < config.minAvgWordLength
  ) {
    return 0;
  }

  // Graduated penalty tiers
  if (pathMatchHits === 0) return config.tier0Delta;
  if (pathMatchHits === 1) return config.tier1Delta;
  if (pathMatchHits === 2) return config.tier2Delta;
  return 0; // pathMatchHits >= 3: no penalty
}

async function contextBundleImpl(
  context: ServerContext,
  params: ContextBundleParams
): Promise<ContextBundleResult> {
  context.warningManager.startRequest();

  const { db, repoId } = context;
  const rawGoal = params.goal?.trim() ?? "";
  if (rawGoal.length === 0) {
    throw new Error(
      "context_bundle requires a non-empty goal. Describe your objective to receive context."
    );
  }
  if (process.env.KIRI_TRACE_METADATA === "1") {
    console.info(`[metadata-trace-env] goal=${rawGoal}`);
  }
  const inlineMetadata = parseInlineMetadataFilters(rawGoal);
  const paramFilters = normalizeMetadataFiltersParam(params.metadata_filters);
  const metadataFilters = mergeMetadataFilters([...inlineMetadata.filters, ...paramFilters]);
  const strictMetadataFilters = metadataFilters.filter((filter) => filter.strict);
  const hintMetadataFilters = metadataFilters.filter((filter) => !filter.strict);
  const hasStrictMetadataFilters = strictMetadataFilters.length > 0;
  const hasHintMetadataFilters = hintMetadataFilters.length > 0;
  const hasAnyMetadataFilters = metadataFilters.length > 0;
  const goal = inlineMetadata.cleanedQuery.length > 0 ? inlineMetadata.cleanedQuery : rawGoal;
  if (process.env.KIRI_TRACE_METADATA === "1") {
    console.info(
      "[metadata-trace]",
      JSON.stringify({
        rawGoal,
        cleanedGoal: goal,
        inlineFilters: inlineMetadata.filters,
        paramFilters,
        mergedFilters: metadataFilters,
      })
    );
  }

  // AdaptiveK: カテゴリに基づいてK値を動的に調整
  // 1. params.categoryが明示的に指定されていればそれを使用
  // 2. そうでなければprofile/artifacts/boost_profileから自動検出
  const detectedCategory = determineCategory(params);
  const adaptiveK = getAdaptiveK(detectedCategory, serverConfig.adaptiveK);
  if (process.env.KIRI_TRACE_ADAPTIVE_K === "1") {
    console.info(
      "[adaptive-k]",
      JSON.stringify({
        detectedCategory,
        selectedK: adaptiveK,
        userLimit: params.limit ?? null,
        enabled: serverConfig.adaptiveK.enabled,
      })
    );
  }
  const adaptiveLimit = normalizeBundleLimit(adaptiveK);
  const requestedLimit = normalizeBundleLimit(params.limit);
  // AdaptiveKが無効な場合はrequestLimitをそのまま使用
  // AdaptiveKが有効な場合:
  //   - ユーザー指定limitがなければadaptiveKを使用
  //   - ユーザー指定がある場合は小さい方を採用（過剰取得防止）
  const limit = serverConfig.adaptiveK.enabled
    ? params.limit === undefined
      ? adaptiveLimit
      : Math.min(requestedLimit, adaptiveLimit)
    : requestedLimit;
  const artifacts = params.artifacts ?? {};
  const artifactHints = normalizeArtifactHints(artifacts.hints);
  const hintBuckets = bucketArtifactHints(artifactHints);
  const artifactPathHints = hintBuckets.pathHints;
  const substringHints = hintBuckets.substringHints;
  const includeTokensEstimate = params.includeTokensEstimate === true;
  const isCompact = params.compact === true;
  const pathPrefix =
    params.path_prefix && params.path_prefix.length > 0
      ? normalizePathPrefix(params.path_prefix)
      : undefined;

  // 項目2: トークンバジェット保護警告
  // 大量データ+非コンパクトモード+トークン推定なしの場合に警告
  // リクエストごとに警告（warnForRequestを使用）
  if (!includeTokensEstimate && !isCompact && limit > 10) {
    context.warningManager.warnForRequest(
      "context_bundle:large_non_compact",
      "Large non-compact response without token estimation may exceed LLM limits. " +
        "Consider setting compact: true or includeTokensEstimate: true."
    );
  }

  // スコアリング重みをロード（将来的には設定ファイルや引数から）
  const profileName = coerceProfileName(params.profile ?? null);
  const weights = loadScoringProfile(profileName);

  const keywordSources: string[] = [goal];
  if (artifacts.failing_tests && artifacts.failing_tests.length > 0) {
    keywordSources.push(artifacts.failing_tests.join(" "));
  }
  if (artifacts.last_diff) {
    keywordSources.push(artifacts.last_diff);
  }
  if (artifacts.editing_path) {
    keywordSources.push(artifacts.editing_path);
  }
  if (artifactHints.length > 0) {
    keywordSources.push(artifactHints.join(" "));
  }
  if (hasAnyMetadataFilters) {
    const filterSeed = metadataFilters
      .map((filter) => `${filter.source ?? "meta"}:${filter.key}=${filter.values.join(",")}`)
      .join(" ");
    keywordSources.push(filterSeed);
  }

  const baseSeed = keywordSources.join(" ");
  const domainExpansion =
    process.env.KIRI_ENABLE_DOMAIN_TERMS === "1"
      ? context.services.domainTerms.expandFromText(baseSeed)
      : { matched: [], aliases: [], fileHints: [] };
  if (domainExpansion.aliases.length > 0) {
    keywordSources.push(domainExpansion.aliases.join(" "));
  }

  const semanticSeed = keywordSources.join(" ");
  const queryEmbedding = generateEmbedding(semanticSeed)?.values ?? null;

  const extractedTerms = extractKeywords(semanticSeed);
  const segmentPreview = extractedTerms.pathSegments.slice(0, AUTO_PATH_SEGMENT_LIMIT).join(",");
  traceSearch(
    `terms repo=${repoId} id=${params.requestId ?? "n/a"} keywords=${extractedTerms.keywords.length} phrases=${extractedTerms.phrases.length} pathSegments=${extractedTerms.pathSegments.length} segs=[${segmentPreview}]`
  );

  // フォールバック: editing_pathからキーワードを抽出
  if (
    extractedTerms.phrases.length === 0 &&
    extractedTerms.keywords.length === 0 &&
    artifacts.editing_path
  ) {
    const pathSegments = artifacts.editing_path
      .split(/[/_.-]/)
      .map((segment) => segment.toLowerCase())
      .filter((segment) => segment.length >= 3 && !getStopWordsService().has(segment));
    extractedTerms.pathSegments.push(...pathSegments.slice(0, MAX_KEYWORDS));
  }

  const candidates = new Map<string, CandidateInfo>();
  const stringMatchSeeds = new Set<string>();
  const fileCache = new Map<string, FileContentCacheEntry>();

  // Phase 2: IDF重み付けプロバイダーの初期化
  // キーワードの文書頻度に基づいて重みを計算し、高頻度語を自動的に減衰
  const idfProvider = createIdfProvider(db, repoId);
  const idfWeights = new Map<string, number>();

  // 抽出されたキーワードのIDF重みを事前計算（非同期バッチ処理）
  if (extractedTerms.keywords.length > 0) {
    const computedWeights = await idfProvider.computeIdfBatch(extractedTerms.keywords);
    for (const [term, weight] of computedWeights) {
      idfWeights.set(term, weight);
    }
    if (process.env.KIRI_TRACE_IDF === "1") {
      console.info(
        "[idf-weights]",
        JSON.stringify(
          Object.fromEntries(Array.from(idfWeights.entries()).map(([k, v]) => [k, v.toFixed(3)]))
        )
      );
    }
  }

  // ✅ Cache boost profile config to avoid redundant lookups in hot path
  const boostProfile: BoostProfileName =
    params.boost_profile ??
    (hasHintMetadataFilters ? "balanced" : hasStrictMetadataFilters ? "docs" : "default");
  const baseProfileConfig = getBoostProfile(boostProfile);
  const profileConfig: BoostProfileConfig = {
    ...baseProfileConfig,
    pathMultipliers: loadPathPenalties(baseProfileConfig.pathMultipliers),
  };

  // フレーズマッチング（高い重み: textMatch × 2）- 統合クエリでパフォーマンス改善
  if (extractedTerms.phrases.length > 0) {
    const phrasePlaceholders = extractedTerms.phrases
      .map(() => "b.content ILIKE '%' || ? || '%'")
      .join(" OR ");

    // DEBUG: Log SQL query parameters for troubleshooting
    traceSearch(
      `Executing phrase match query with repo_id=${repoId}, phrases=${JSON.stringify(extractedTerms.phrases)}`
    );

    const phraseWhereClauses = ["f.repo_id = ?", "f.is_binary = FALSE", `(${phrasePlaceholders})`];
    const phraseParams: unknown[] = [repoId, ...extractedTerms.phrases];
    if (pathPrefix) {
      phraseWhereClauses.push("f.path LIKE ?");
      phraseParams.push(`${pathPrefix}%`);
    }

    const rows = await db.all<FileWithEmbeddingRow>(
      `
        SELECT f.path, f.lang, f.ext, f.is_binary, b.content, fe.vector_json, fe.dims AS vector_dims
        FROM file f
        JOIN blob b ON b.hash = f.blob_hash
        LEFT JOIN file_embedding fe
          ON fe.repo_id = f.repo_id
         AND fe.path = f.path
        WHERE ${phraseWhereClauses.join(`
          AND `)}
        ORDER BY f.path
        LIMIT ?
      `,
      [...phraseParams, MAX_MATCHES_PER_KEYWORD * extractedTerms.phrases.length]
    );

    // DEBUG: Log returned paths and verify they match expected repo_id
    if (rows.length > 0) {
      traceSearch(
        `Phrase match returned ${rows.length} rows. Sample paths: ${rows
          .slice(0, 3)
          .map((r) => r.path)
          .join(", ")}`
      );

      // Verify repo_id of returned files
      const pathsToCheck = rows.slice(0, 3).map((r) => r.path);
      const verification = await db.all<{ path: string; repo_id: number }>(
        `SELECT path, repo_id FROM file WHERE path IN (${pathsToCheck.map(() => "?").join(", ")}) LIMIT 3`,
        pathsToCheck
      );
      traceSearch(`Repo ID verification`, verification);
    }

    for (const row of rows) {
      if (row.content === null) {
        continue;
      }

      // どのフレーズにマッチしたかをチェック
      const lowerContent = row.content.toLowerCase();
      const matchedPhrases = extractedTerms.phrases.filter((phrase) =>
        lowerContent.includes(phrase)
      );

      if (matchedPhrases.length === 0) {
        continue; // Should not happen, but defensive check
      }

      const candidate = ensureCandidate(candidates, row.path);
      candidate.phraseHits += matchedPhrases.length;

      // 各マッチしたフレーズに対してスコアリング
      for (const phrase of matchedPhrases) {
        // フレーズマッチは通常の2倍のスコア
        candidate.score += weights.textMatch * 2.0;
        candidate.reasons.add(`phrase:${phrase}`);
      }

      // Apply boost profile once per file
      if (boostProfile !== "none") {
        applyBoostProfile(candidate, row, profileConfig, weights, extractedTerms);
      }

      // Use first matched phrase for preview (guaranteed to exist due to length check above)
      const { line } = buildPreview(row.content, matchedPhrases[0]!);
      candidate.matchLine =
        candidate.matchLine === null ? line : Math.min(candidate.matchLine, line);
      candidate.content ??= row.content;
      candidate.lang ??= row.lang;
      candidate.ext ??= row.ext;
      candidate.totalLines ??= row.content.length === 0 ? 0 : row.content.split(/\r?\n/).length;
      candidate.embedding ??= parseEmbedding(row.vector_json ?? null, row.vector_dims ?? null);
      stringMatchSeeds.add(row.path);
      if (!fileCache.has(row.path)) {
        fileCache.set(row.path, {
          content: row.content,
          lang: row.lang,
          ext: row.ext,
          totalLines: candidate.totalLines ?? 0,
          embedding: candidate.embedding,
        });
      }
    }

    traceSearch(`phrase search produced ${rows.length} rows, candidates=${candidates.size}`);
  }

  // キーワードマッチング（通常の重み）- 統合クエリでパフォーマンス改善
  if (extractedTerms.keywords.length > 0) {
    const keywordPlaceholders = extractedTerms.keywords
      .map(() => "b.content ILIKE '%' || ? || '%'")
      .join(" OR ");
    const keywordWhereClauses = [
      "f.repo_id = ?",
      "f.is_binary = FALSE",
      `(${keywordPlaceholders})`,
    ];
    const keywordParams: unknown[] = [repoId, ...extractedTerms.keywords];
    if (pathPrefix) {
      keywordWhereClauses.push("f.path LIKE ?");
      keywordParams.push(`${pathPrefix}%`);
    }

    const rows = await db.all<FileWithEmbeddingRow>(
      `
        SELECT f.path, f.lang, f.ext, f.is_binary, b.content, fe.vector_json, fe.dims AS vector_dims
        FROM file f
        JOIN blob b ON b.hash = f.blob_hash
        LEFT JOIN file_embedding fe
          ON fe.repo_id = f.repo_id
         AND fe.path = f.path
        WHERE ${keywordWhereClauses.join(`
          AND `)}
        ORDER BY f.path
        LIMIT ?
      `,
      [...keywordParams, MAX_MATCHES_PER_KEYWORD * extractedTerms.keywords.length]
    );

    for (const row of rows) {
      if (row.content === null) {
        continue;
      }

      // どのキーワードにマッチしたかをチェック
      const lowerContent = row.content.toLowerCase();
      const matchedKeywords = extractedTerms.keywords.filter((keyword) =>
        lowerContent.includes(keyword)
      );

      if (matchedKeywords.length === 0) {
        continue; // Should not happen, but defensive check
      }

      const candidate = ensureCandidate(candidates, row.path);

      // 各マッチしたキーワードに対してスコアリング（Phase 2: IDF重み付け）
      for (const keyword of matchedKeywords) {
        // IDF重みを適用（事前計算済み、なければデフォルト1.0）
        // 減衰適用: 0.6 + 0.4 * idfWeight でファイル種別マルチプライヤとのバランスを維持
        // - 高頻度語: IDF=0 → 0.6 (40%減)
        // - 低頻度語: IDF=1 → 1.0 (減衰なし)
        const rawIdfWeight = idfWeights.get(keyword.toLowerCase()) ?? 1.0;
        const dampedIdfWeight = 0.6 + 0.4 * rawIdfWeight;
        const weightedScore = weights.textMatch * dampedIdfWeight;
        candidate.score += weightedScore;
        candidate.reasons.add(`text:${keyword}:idf=${rawIdfWeight.toFixed(2)}`);
        candidate.keywordHits.add(keyword);
      }

      // Apply boost profile once per file
      if (boostProfile !== "none") {
        applyBoostProfile(candidate, row, profileConfig, weights, extractedTerms);
      }

      // Use first matched keyword for preview (guaranteed to exist due to length check above)
      const { line } = buildPreview(row.content, matchedKeywords[0]!);
      candidate.matchLine =
        candidate.matchLine === null ? line : Math.min(candidate.matchLine, line);
      candidate.content ??= row.content;
      candidate.lang ??= row.lang;
      candidate.ext ??= row.ext;
      candidate.totalLines ??= row.content.length === 0 ? 0 : row.content.split(/\r?\n/).length;
      candidate.embedding ??= parseEmbedding(row.vector_json ?? null, row.vector_dims ?? null);
      stringMatchSeeds.add(row.path);
      if (!fileCache.has(row.path)) {
        fileCache.set(row.path, {
          content: row.content,
          lang: row.lang,
          ext: row.ext,
          totalLines: candidate.totalLines ?? 0,
          embedding: candidate.embedding,
        });
      }
    }

    traceSearch(`keyword search produced ${rows.length} rows, candidates=${candidates.size}`);
  }

  const fallbackTerms = Array.from(
    new Set(
      [...extractedTerms.phrases, ...extractedTerms.keywords, ...extractedTerms.pathSegments]
        .map((term) => term.toLowerCase())
        .filter((term) => term.length >= 3)
    )
  ).slice(0, PATH_FALLBACK_TERMS_LIMIT);

  if (fallbackTerms.length > 0) {
    const fallbackRows = await fetchPathFallbackCandidates(
      db,
      repoId,
      fallbackTerms,
      Math.min(limit * 2, PATH_FALLBACK_LIMIT)
    );
    const fallbackReason =
      stringMatchSeeds.size === 0
        ? "no-string-match"
        : candidates.size < limit
          ? "low-candidates"
          : "supplemental";
    traceSearch(
      `path fallback triggered (${fallbackReason}) terms=${JSON.stringify(fallbackTerms)} rows=${fallbackRows.length}`
    );
    const fallbackWeight =
      stringMatchSeeds.size === 0 ? weights.pathMatch * 0.75 : weights.pathMatch * 0.2;
    for (const row of fallbackRows) {
      const candidate = ensureCandidate(candidates, row.path);
      candidate.pathFallbackReason = fallbackReason;
      candidate.score += fallbackWeight;
      candidate.reasons.add("fallback:path");
      const contentLower = row.content?.toLowerCase() ?? "";
      if (contentLower.length > 0) {
        let textHits = 0;
        for (const term of fallbackTerms) {
          if (contentLower.includes(term)) {
            textHits += 1;
            candidate.keywordHits.add(term);
          }
        }
        candidate.fallbackTextHits += textHits;
        if (textHits > 0) {
          const textBoost = textHits * weights.textMatch * 0.15;
          candidate.score += textBoost;
          candidate.reasons.add(`fallback:content:${textHits}`);
        }
      }
      candidate.matchLine ??= 1;
      candidate.lang ??= row.lang;
      candidate.ext ??= row.ext;
      candidate.totalLines ??= row.content?.split(/\r?\n/).length ?? null;
      candidate.content ??= row.content;
      candidate.embedding ??= parseEmbedding(row.vector_json ?? null, row.vector_dims ?? null);
      if (boostProfile !== "none") {
        applyBoostProfile(candidate, row, profileConfig, weights, extractedTerms);
      }
      stringMatchSeeds.add(row.path);
      if (!fileCache.has(row.path) && row.content) {
        fileCache.set(row.path, {
          content: row.content,
          lang: row.lang,
          ext: row.ext,
          totalLines: candidate.totalLines ?? 0,
          embedding: candidate.embedding,
        });
      }
    }

    // Drop fallback-only candidates with zero text evidence before trimming
    for (const [path, candidate] of Array.from(candidates.entries())) {
      const isFallbackOnly =
        candidate.reasons.has("fallback:path") &&
        candidate.keywordHits.size === 0 &&
        candidate.phraseHits === 0;
      const hasTextEvidence = candidate.fallbackTextHits > 0;
      if (isFallbackOnly && !hasTextEvidence) {
        candidates.delete(path);
      }
    }

    // Demote fallback-only hits without text evidence
    for (const candidate of candidates.values()) {
      const isFallbackOnly =
        candidate.reasons.has("fallback:path") &&
        candidate.keywordHits.size === 0 &&
        candidate.phraseHits === 0;
      const hasTextEvidence = candidate.fallbackTextHits > 0;
      if (isFallbackOnly && !hasTextEvidence) {
        candidate.scoreMultiplier *= 0.5;
        candidate.reasons.add("penalty:fallback-no-text");
      }
    }

    if (fallbackRows.length > PATH_FALLBACK_KEEP) {
      const fallbackOnly = Array.from(candidates.entries())
        .filter(
          ([_, candidate]) =>
            candidate.reasons.has("fallback:path") &&
            candidate.keywordHits.size === 0 &&
            candidate.phraseHits === 0
        )
        .sort((a, b) => b[1].score - a[1].score);

      const toDrop = fallbackOnly.slice(PATH_FALLBACK_KEEP);
      for (const [path] of toDrop) {
        candidates.delete(path);
      }
      traceSearch(
        `path fallback trimmed kept=${PATH_FALLBACK_KEEP} dropped=${toDrop.length} candidates=${candidates.size}`
      );
    }
  }

  if (extractedTerms.keywords.length > 0 || extractedTerms.phrases.length > 0) {
    for (const candidate of candidates.values()) {
      applyCoverageBoost(candidate, extractedTerms, weights);
    }
  }

  const artifactPathTargets: ResolvedPathHint[] = artifactPathHints.map((hintPath) => ({
    path: hintPath,
    sourceHint: hintPath,
    origin: "artifact",
  }));
  const domainPathTargets: ResolvedPathHint[] = selectDomainPathHints(
    domainExpansion.fileHints
  ).map((hint) => ({
    path: hint.path,
    sourceHint: hint.source,
    origin: "dictionary",
  }));
  const dictionaryPathTargets = await fetchDictionaryPathHints(
    db,
    context.tableAvailability,
    repoId,
    substringHints,
    HINT_DICTIONARY_LIMIT
  );
  const { list: resolvedPathHintTargets, meta: hintSeedMeta } = createHintSeedMeta([
    ...artifactPathTargets,
    ...domainPathTargets,
    ...dictionaryPathTargets,
  ]);

  if (resolvedPathHintTargets.length > 0) {
    await applyPathHintPromotions({
      db,
      tableAvailability: context.tableAvailability,
      repoId,
      hintTargets: resolvedPathHintTargets,
      candidates,
      fileCache,
      weights,
      hintSeedMeta,
    });
  }

  if (substringHints.length > 0) {
    await addHintSubstringMatches(
      db,
      context.tableAvailability,
      repoId,
      substringHints,
      candidates,
      HINT_SUBSTRING_LIMIT,
      HINT_SUBSTRING_BOOST
    );
  }

  if (artifacts.editing_path) {
    const editingCandidate = ensureCandidate(candidates, artifacts.editing_path);
    editingCandidate.score += weights.editingPath;
    editingCandidate.reasons.add("artifact:editing_path");
    editingCandidate.matchLine ??= 1;
  }

  // SQL injection防御: ファイルパスの検証パターン
  const dependencySeeds = new Set<string>();
  for (const pathSeed of stringMatchSeeds) {
    if (!SAFE_PATH_PATTERN.test(pathSeed)) {
      console.warn(`Skipping potentially unsafe path in dependency seeds: ${pathSeed}`);
      continue;
    }
    dependencySeeds.add(pathSeed);
    if (dependencySeeds.size >= MAX_DEPENDENCY_SEEDS) {
      break;
    }
  }
  if (artifacts.editing_path) {
    if (!SAFE_PATH_PATTERN.test(artifacts.editing_path)) {
      throw new Error(
        `Invalid editing_path format: ${artifacts.editing_path}. Use only A-Z, 0-9, _, ., -, / characters.`
      );
    }
    dependencySeeds.add(artifacts.editing_path);
  }

  for (const target of resolvedPathHintTargets) {
    dependencySeeds.add(target.path);
  }

  if (dependencySeeds.size > 0) {
    // SQL injection防御: プレースホルダー生成前にサイズを検証
    if (dependencySeeds.size > MAX_DEPENDENCY_SEEDS_QUERY_LIMIT) {
      throw new Error(
        `Too many dependency seeds: ${dependencySeeds.size} (max ${MAX_DEPENDENCY_SEEDS_QUERY_LIMIT}). Narrow your search criteria.`
      );
    }

    const placeholders = Array.from(dependencySeeds, () => "?").join(", ");

    // 防御的チェック: プレースホルダーが正しい形式であることを確認
    // 期待される形式: "?, ?, ..." (クエスチョンマーク、カンマ、スペースのみ)
    if (!/^(\?)(,\s*\?)*$/.test(placeholders)) {
      throw new Error(
        "Invalid dependency placeholder sequence detected. Remove unsafe dependency seeds and retry the request."
      );
    }

    const depRows = await db.all<DependencyRow>(
      `
        SELECT src_path, dst_kind, dst, rel
        FROM dependency
        WHERE repo_id = ? AND src_path IN (${placeholders})
      `,
      [repoId, ...dependencySeeds]
    );

    for (const dep of depRows) {
      if (dep.dst_kind !== "path") {
        continue;
      }
      const candidate = ensureCandidate(candidates, dep.dst);
      candidate.score += weights.dependency;
      candidate.reasons.add(`dep:${dep.src_path}`);
    }
  }

  if (artifacts.editing_path) {
    const directory = path.posix.dirname(artifacts.editing_path);
    if (directory && directory !== ".") {
      const nearRows = await db.all<{ path: string }>(
        `
          SELECT path
          FROM file
          WHERE repo_id = ?
            AND is_binary = FALSE
            AND path LIKE ?
          ORDER BY path
          LIMIT ?
        `,
        [repoId, `${directory}/%`, NEARBY_LIMIT + 1]
      );
      for (const near of nearRows) {
        if (near.path === artifacts.editing_path) {
          continue;
        }
        const candidate = ensureCandidate(candidates, near.path);
        candidate.score += weights.proximity;
        candidate.reasons.add(`near:${directory}`);
      }
    }
  }

  const materializeCandidates = async (): Promise<CandidateInfo[]> => {
    const result: CandidateInfo[] = [];
    for (const candidate of candidates.values()) {
      if (!pathMatchesPrefix(candidate.path, pathPrefix)) {
        continue;
      }
      if (isSuppressedPath(candidate.path)) {
        continue;
      }
      if (!candidate.content) {
        const cached = fileCache.get(candidate.path);
        if (cached) {
          candidate.content = cached.content;
          candidate.lang = cached.lang;
          candidate.ext = cached.ext;
          candidate.totalLines = cached.totalLines;
          candidate.embedding = cached.embedding;
        } else {
          const loaded = await loadFileContent(db, repoId, candidate.path);
          if (!loaded) {
            continue;
          }
          candidate.content = loaded.content;
          candidate.lang = loaded.lang;
          candidate.ext = loaded.ext;
          candidate.totalLines = loaded.totalLines;
          candidate.embedding = loaded.embedding;
          fileCache.set(candidate.path, loaded);
        }
      }
      result.push(candidate);
    }
    return result;
  };

  const addMetadataFallbackCandidates = async (): Promise<void> => {
    if (!hasAnyMetadataFilters) {
      return;
    }
    const metadataRows = await fetchMetadataOnlyCandidates(
      db,
      context.tableAvailability,
      repoId,
      metadataFilters,
      limit * 2,
      pathPrefix
    );
    if (metadataRows.length === 0) {
      return;
    }
    for (const row of metadataRows) {
      const candidate = ensureCandidate(candidates, row.path);
      if (row.content) {
        candidate.content = row.content;
        candidate.totalLines = row.content.split(/\r?\n/).length;
        fileCache.set(row.path, {
          content: row.content,
          lang: row.lang,
          ext: row.ext,
          totalLines: candidate.totalLines,
          embedding: candidate.embedding,
        });
      }
      candidate.lang ??= row.lang;
      candidate.ext ??= row.ext;
      candidate.matchLine ??= 1;
      candidate.score = Math.max(candidate.score, 1 + metadataFilters.length * 0.2);
    }
  };

  if (hasAnyMetadataFilters) {
    await addMetadataFallbackCandidates();
  }

  let materializedCandidates = await materializeCandidates();
  traceSearch(`materialized candidates: ${materializedCandidates.length}`);

  if (materializedCandidates.length === 0 && hasAnyMetadataFilters) {
    await addMetadataFallbackCandidates();
    materializedCandidates = await materializeCandidates();
    traceSearch(
      `materialized candidates after metadata fallback: ${materializedCandidates.length}`
    );
  }

  if (materializedCandidates.length === 0) {
    // Get warnings from WarningManager (includes breaking change notification if applicable)
    const warnings = [...context.warningManager.responseWarnings];
    return {
      context: [],
      ...(includeTokensEstimate && { tokens_estimate: 0 }),
      ...(warnings.length > 0 && { warnings }),
    };
  }

  const metadataKeywordSet = new Set(
    extractedTerms.keywords.map((keyword) => keyword.toLowerCase())
  );
  const filterValueSet = new Set(
    metadataFilters.flatMap((filter) => filter.values.map((value) => value.toLowerCase()))
  );

  let metadataEntriesMap: Map<string, MetadataEntry[]> | undefined;
  if (hasAnyMetadataFilters || metadataKeywordSet.size > 0 || filterValueSet.size > 0) {
    metadataEntriesMap = await loadMetadataForPaths(
      db,
      context.tableAvailability,
      repoId,
      materializedCandidates.map((candidate) => candidate.path)
    );
  }

  if (hasStrictMetadataFilters) {
    metadataEntriesMap ??= new Map();
    for (let i = materializedCandidates.length - 1; i >= 0; i--) {
      const candidate = materializedCandidates[i];
      if (!candidate) {
        continue; // Skip undefined entries
      }
      const entries = metadataEntriesMap.get(candidate.path);
      const matchesFilters = candidateMatchesMetadataFilters(entries, strictMetadataFilters);
      if (!matchesFilters) {
        materializedCandidates.splice(i, 1);
        continue;
      }
      candidate.reasons.add("metadata:filter");
      if (process.env.KIRI_TRACE_METADATA === "1") {
        console.info(`[metadata-trace-match] path=${candidate.path}`);
      }
    }

    if (materializedCandidates.length === 0 && hasAnyMetadataFilters) {
      await addMetadataFallbackCandidates();
      materializedCandidates = await materializeCandidates();
    }

    if (materializedCandidates.length === 0) {
      const warnings = [...context.warningManager.responseWarnings];
      return {
        context: [],
        ...(includeTokensEstimate && { tokens_estimate: 0 }),
        ...(warnings.length > 0 && { warnings }),
      };
    }
  }

  if (hasHintMetadataFilters) {
    metadataEntriesMap ??= new Map();
    for (const candidate of materializedCandidates) {
      const entries = metadataEntriesMap.get(candidate.path);
      const matchesHints = candidateMatchesMetadataFilters(entries, hintMetadataFilters);
      if (matchesHints) {
        candidate.score += METADATA_HINT_BONUS;
        candidate.reasons.add("metadata:hint");
      }
    }
  }

  const inboundCounts = await loadInboundLinkCounts(
    db,
    context.tableAvailability,
    repoId,
    materializedCandidates.map((candidate) => candidate.path)
  );

  if (metadataEntriesMap) {
    for (const candidate of materializedCandidates) {
      const entries = metadataEntriesMap.get(candidate.path);
      const metadataBoost = computeMetadataBoost(entries, metadataKeywordSet, filterValueSet);
      if (metadataBoost > 0) {
        candidate.score += metadataBoost;
        candidate.reasons.add("boost:metadata");
      }
    }
  }

  for (const candidate of materializedCandidates) {
    const linkBoost = computeInboundLinkBoost(inboundCounts.get(candidate.path));
    if (linkBoost > 0) {
      candidate.score += linkBoost;
      candidate.reasons.add("boost:links");
    }
  }

  applyStructuralScores(materializedCandidates, queryEmbedding, weights.structural);

  // Phase 3.2: Apply graph layer scoring (inbound dependencies, PageRank importance)
  await applyGraphLayerScores(db, repoId, materializedCandidates, weights);

  // Phase 4: Apply co-change scores (files that change together with editing_path)
  await applyCochangeScores(db, repoId, materializedCandidates, weights, artifacts.editing_path);

  // ✅ CRITICAL SAFETY: Apply multipliers AFTER all additive scoring (v0.7.0)
  // Only apply to positive scores to prevent negative score inversion
  for (const candidate of materializedCandidates) {
    if (candidate.scoreMultiplier !== 1.0 && candidate.score > 0) {
      candidate.score *= candidate.scoreMultiplier;
    }
  }

  // Issue #68: Apply Path-Based Penalties (after multipliers, before sorting)
  const penaltyFlags = readPenaltyFlags();
  const queryStats = computeQueryStats(goal); // Always compute for telemetry
  const graduatedConfig = readGraduatedPenaltyConfig();

  // ADR 002: Use graduated penalty system if enabled, otherwise use legacy binary penalty
  if (graduatedConfig.enabled && penaltyFlags.pathPenalty) {
    for (const candidate of materializedCandidates) {
      applyGraduatedPenalty(candidate, queryStats, graduatedConfig);
    }
  } else if (penaltyFlags.pathPenalty) {
    // Legacy mode: Binary penalty (pathMatchHits === 0 only)
    for (const candidate of materializedCandidates) {
      applyPathMissPenalty(candidate, queryStats);
    }
  }

  // Issue #68: Apply Large File Penalty (after multipliers, before sorting)
  if (penaltyFlags.largeFilePenalty) {
    for (const candidate of materializedCandidates) {
      applyLargeFilePenalty(candidate);
    }
  }

  // Issue #68: Telemetry（デバッグ用、環境変数で制御）
  // LDE: 純粋関数（計算）と副作用（I/O）を分離
  const enableTelemetry = process.env.KIRI_PENALTY_TELEMETRY === "1";
  if (enableTelemetry) {
    console.error(
      `[DEBUG] Telemetry enabled. Flags: pathPenalty=${penaltyFlags.pathPenalty}, largeFilePenalty=${penaltyFlags.largeFilePenalty}`
    );
    const telemetry = computePenaltyTelemetry(materializedCandidates);
    logPenaltyTelemetry(telemetry, queryStats);
  }

  // v1.0.0: Filter out extremely low-scored candidates (result of multiplicative penalties)
  // Threshold removes files with >95% penalty while keeping reasonably relevant files
  // Hint paths are exempt from this threshold (always included if score > 0)
  const hintPathSet = new Set(resolvedPathHintTargets.map((target) => target.path));
  const rankedCandidates = materializedCandidates
    .filter(
      (candidate) =>
        candidate.score > SCORE_FILTER_THRESHOLD ||
        (candidate.score > 0 && hintPathSet.has(candidate.path))
    )
    .sort((a, b) => {
      if (b.score === a.score) {
        return a.path.localeCompare(b.path);
      }
      return b.score - a.score;
    });
  if (TRACE_SEARCH) {
    const sample = rankedCandidates.slice(0, 5).map((candidate) => ({
      path: candidate.path,
      score: Number(candidate.score.toFixed(3)),
      reasons: Array.from(candidate.reasons).slice(0, 3),
    }));
    traceSearch(`ranked candidates=${rankedCandidates.length}`, sample);
  }

  const prioritizedCandidates = prioritizeHintCandidates(
    rankedCandidates,
    resolvedPathHintTargets.map((target) => target.path),
    limit
  );
  if (prioritizedCandidates.length === 0) {
    const warnings = [...context.warningManager.responseWarnings];
    return {
      context: [],
      ...(includeTokensEstimate && { tokens_estimate: 0 }),
      ...(warnings.length > 0 && { warnings }),
    };
  }

  const maxScore = Math.max(...prioritizedCandidates.map((candidate) => candidate.score));

  const results: ContextBundleItem[] = [];
  for (const candidate of prioritizedCandidates) {
    if (!candidate.content) {
      continue;
    }
    const snippets = await db.all<SnippetRow>(
      `
        SELECT s.snippet_id, s.start_line, s.end_line, s.symbol_id, sym.name AS symbol_name, sym.kind AS symbol_kind
        FROM snippet s
        LEFT JOIN symbol sym
          ON sym.repo_id = s.repo_id
         AND sym.path = s.path
         AND sym.symbol_id = s.symbol_id
        WHERE s.repo_id = ? AND s.path = ?
        ORDER BY s.start_line
      `,
      [repoId, candidate.path]
    );
    const selected = selectSnippet(snippets, candidate.matchLine);

    let startLine: number;
    let endLine: number;
    if (selected) {
      startLine = selected.start_line;
      endLine = selected.end_line;
    } else {
      const totalLines = candidate.totalLines ?? 0;
      const matchLine = candidate.matchLine ?? 1;
      const windowHalf = Math.floor(FALLBACK_SNIPPET_WINDOW / 2);
      startLine = Math.max(1, matchLine - windowHalf);
      endLine = Math.min(
        totalLines === 0 ? matchLine + windowHalf : totalLines,
        startLine + FALLBACK_SNIPPET_WINDOW - 1
      );
    }

    if (CLAMP_SNIPPETS_ENABLED) {
      // Clamp snippet length to FALLBACK_SNIPPET_WINDOW even when symbol spans large regions
      const maxWindow = FALLBACK_SNIPPET_WINDOW;
      const selectedEnd = selected ? selected.end_line : endLine;
      const selectedStart = selected ? selected.start_line : startLine;
      if (endLine - startLine + 1 > maxWindow) {
        const anchor = candidate.matchLine ?? startLine;
        let clampedStart = Math.max(selectedStart, anchor - Math.floor(maxWindow / 2));
        let clampedEnd = clampedStart + maxWindow - 1;
        if (clampedEnd > selectedEnd) {
          clampedEnd = selectedEnd;
          clampedStart = Math.max(selectedStart, clampedEnd - maxWindow + 1);
        }
        startLine = clampedStart;
        endLine = Math.max(clampedStart, clampedEnd);
      }
    }

    if (endLine < startLine) {
      endLine = startLine;
    }

    const reasons = new Set(candidate.reasons);
    if (selected && selected.symbol_name) {
      reasons.add(`symbol:${selected.symbol_name}`);
    }

    const normalizedScore = maxScore > 0 ? candidate.score / maxScore : 0;

    const roundedScore = Number.isFinite(normalizedScore) ? Number(normalizedScore.toFixed(3)) : 0;

    // Select why tags with diversity guarantee (reserves slots for dep/symbol/near)
    const why = selectWhyTags(reasons);

    const item: ContextBundleItem = {
      path: candidate.path,
      range: [startLine, endLine],
      why,
      score: roundedScore,
    };

    // Add preview only if not in compact mode
    if (!params.compact) {
      item.preview = buildSnippetPreview(candidate.content, startLine, endLine);
    }

    results.push(item);
  }

  // コンテンツベースのトークン推定を使用（より正確）
  let tokensEstimate: number | undefined;
  if (includeTokensEstimate) {
    tokensEstimate = results.reduce((acc, item) => {
      const candidate = prioritizedCandidates.find((c) => c.path === item.path);
      if (candidate && candidate.content) {
        return acc + estimateTokensFromContent(candidate.content, item.range[0], item.range[1]);
      }
      // フォールバック: 行ベース推定（コンテンツが利用不可の場合）
      const lineCount = Math.max(1, item.range[1] - item.range[0] + 1);
      return acc + lineCount * 4;
    }, 0);
  }

  // Get warnings from WarningManager (includes breaking change notification if applicable)
  const warnings = [...context.warningManager.responseWarnings];

  const shouldFilterResults = FINAL_RESULT_SUPPRESSION_ENABLED && SUPPRESS_NON_CODE_ENABLED;
  const sanitizedResults = shouldFilterResults
    ? results.filter((item) => !isSuppressedPath(item.path))
    : results;
  const finalResults = sanitizedResults.length > 0 ? sanitizedResults : results;

  const payload: ContextBundleResult = {
    context: finalResults,
    ...(warnings.length > 0 && { warnings }),
  };
  if (tokensEstimate !== undefined) {
    payload.tokens_estimate = tokensEstimate;
  }
  return payload;
}

export async function semanticRerank(
  context: ServerContext,
  params: SemanticRerankParams
): Promise<SemanticRerankResult> {
  const text = params.text?.trim() ?? "";
  if (text.length === 0) {
    throw new Error(
      "semantic_rerank requires non-empty text. Describe the intent to compute semantic similarity."
    );
  }

  if (!Array.isArray(params.candidates) || params.candidates.length === 0) {
    return { candidates: [] };
  }

  const uniqueCandidates: SemanticRerankCandidateInput[] = [];
  const seenPaths = new Set<string>();
  for (const candidate of params.candidates) {
    if (!candidate || typeof candidate.path !== "string" || candidate.path.length === 0) {
      continue;
    }
    if (seenPaths.has(candidate.path)) {
      continue;
    }
    seenPaths.add(candidate.path);
    uniqueCandidates.push(candidate);
    if (uniqueCandidates.length >= MAX_RERANK_LIMIT) {
      break;
    }
  }

  if (uniqueCandidates.length === 0) {
    return { candidates: [] };
  }

  const limitRaw = params.k ?? uniqueCandidates.length;
  const limit = Math.max(1, Math.min(MAX_RERANK_LIMIT, Math.floor(limitRaw)));

  const profileName = coerceProfileName(params.profile ?? null);
  const weights = loadScoringProfile(profileName);
  const structuralWeight = weights.structural;
  const queryEmbedding = generateEmbedding(text)?.values ?? null;

  let embeddingMap = new Map<string, number[]>();
  if (queryEmbedding && structuralWeight > 0) {
    const paths = uniqueCandidates.map((candidate) => candidate.path);
    embeddingMap = await fetchEmbeddingMap(context.db, context.repoId, paths);
  }

  const scored: SemanticRerankItem[] = uniqueCandidates.map((candidate) => {
    const base =
      typeof candidate.score === "number" && Number.isFinite(candidate.score) ? candidate.score : 0;
    let semantic = 0;
    if (queryEmbedding && structuralWeight > 0) {
      const embedding = embeddingMap.get(candidate.path);
      if (embedding) {
        const similarity = structuralSimilarity(queryEmbedding, embedding);
        if (Number.isFinite(similarity) && similarity > 0) {
          semantic = similarity;
        }
      }
    }
    const combined = base + structuralWeight * semantic;
    return {
      path: candidate.path,
      base,
      semantic,
      combined,
    };
  });

  const sorted = scored.sort((a, b) => {
    if (b.combined === a.combined) {
      if (b.semantic === a.semantic) {
        return a.path.localeCompare(b.path);
      }
      return b.semantic - a.semantic;
    }
    return b.combined - a.combined;
  });

  return { candidates: sorted.slice(0, limit) };
}

export async function depsClosure(
  context: ServerContext,
  params: DepsClosureParams
): Promise<DepsClosureResult> {
  const { db, repoId } = context;
  if (!params.path) {
    throw new Error(
      "deps_closure requires a file path. Provide a tracked source file path to continue."
    );
  }

  const direction = params.direction ?? "outbound";
  const maxDepth = params.max_depth ?? 3;
  const includePackages = params.include_packages ?? true;

  const dependencyRows = await db.all<DependencyRow>(
    `
      SELECT src_path, dst_kind, dst, rel
      FROM dependency
      WHERE repo_id = ?
    `,
    [repoId]
  );

  // outbound: このファイルが使用する依存関係
  const outbound = new Map<string, DependencyRow[]>();
  // inbound: このファイルを使用しているファイル
  const inbound = new Map<string, DependencyRow[]>();

  for (const row of dependencyRows) {
    // outbound マップ構築
    if (!outbound.has(row.src_path)) {
      outbound.set(row.src_path, []);
    }
    outbound.get(row.src_path)?.push(row);

    // inbound マップ構築（dst が path の場合のみ）
    if (row.dst_kind === "path") {
      if (!inbound.has(row.dst)) {
        inbound.set(row.dst, []);
      }
      inbound.get(row.dst)?.push(row);
    }
  }

  interface Pending {
    path: string;
    depth: number;
  }

  const queue: Pending[] = [{ path: params.path, depth: 0 }];
  const visitedPaths = new Set<string>([params.path]);

  const nodeDepth = new Map<string, DepsClosureNode>();
  const edgeSet = new Map<string, DepsClosureEdge>();

  const recordNode = (node: DepsClosureNode) => {
    const key = `${node.kind}:${node.target}`;
    const existing = nodeDepth.get(key);
    if (!existing || node.depth < existing.depth) {
      nodeDepth.set(key, { ...node });
    }
  };

  const recordEdge = (edge: DepsClosureEdge) => {
    const key = `${edge.from}->${edge.to}:${edge.kind}:${edge.rel}`;
    const existing = edgeSet.get(key);
    if (!existing || edge.depth < existing.depth) {
      edgeSet.set(key, { ...edge });
    }
  };

  recordNode({ kind: "path", target: params.path, depth: 0 });

  while (queue.length > 0) {
    const current = queue.shift() as Pending;
    if (current.depth >= maxDepth) {
      continue;
    }

    // direction に応じて使用するマップを選択
    const edgeMap = direction === "inbound" ? inbound : outbound;
    const edges = edgeMap.get(current.path) ?? [];

    for (const edge of edges) {
      const nextDepth = current.depth + 1;

      if (direction === "inbound") {
        // inbound: edge.src_path がこのファイルを使用している
        recordEdge({
          from: edge.src_path,
          to: current.path,
          kind: "path",
          rel: edge.rel,
          depth: nextDepth,
        });
        recordNode({ kind: "path", target: edge.src_path, depth: nextDepth });
        if (!visitedPaths.has(edge.src_path)) {
          visitedPaths.add(edge.src_path);
          queue.push({ path: edge.src_path, depth: nextDepth });
        }
      } else {
        // outbound: このファイルが edge.dst を使用している
        if (edge.dst_kind === "path") {
          recordEdge({
            from: current.path,
            to: edge.dst,
            kind: "path",
            rel: edge.rel,
            depth: nextDepth,
          });
          recordNode({ kind: "path", target: edge.dst, depth: nextDepth });
          if (!visitedPaths.has(edge.dst)) {
            visitedPaths.add(edge.dst);
            queue.push({ path: edge.dst, depth: nextDepth });
          }
        } else if (edge.dst_kind === "package" && includePackages) {
          recordEdge({
            from: current.path,
            to: edge.dst,
            kind: "package",
            rel: edge.rel,
            depth: nextDepth,
          });
          recordNode({ kind: "package", target: edge.dst, depth: nextDepth });
        }
      }
    }
  }

  const nodes = Array.from(nodeDepth.values()).sort((a, b) => {
    if (a.depth === b.depth) {
      return a.target.localeCompare(b.target);
    }
    return a.depth - b.depth;
  });

  const edges = Array.from(edgeSet.values()).sort((a, b) => {
    if (a.depth === b.depth) {
      const fromCmp = a.from.localeCompare(b.from);
      if (fromCmp !== 0) {
        return fromCmp;
      }
      return a.to.localeCompare(b.to);
    }
    return a.depth - b.depth;
  });

  return {
    root: params.path,
    direction,
    nodes,
    edges,
  };
}

/**
 * リポジトリのrootパスをデータベースIDに解決する。
 *
 * この関数は下位互換性のために保持されているが、内部的には新しいRepoResolverを使用する。
 *
 * @param db - DuckDBクライアント
 * @param repoRoot - リポジトリのrootパス
 * @param services - オプショナルなServerServices（指定がなければ新規作成される）
 * @returns リポジトリID
 * @throws Error リポジトリがインデックスされていない場合
 */
export async function resolveRepoId(
  db: DuckDBClient,
  repoRoot: string,
  services?: ServerServices
): Promise<number> {
  const svc = services ?? createServerServices(db);
  return await svc.repoResolver.resolveId(repoRoot);
}

export async function contextBundle(
  context: ServerContext,
  params: ContextBundleParams
): Promise<ContextBundleResult> {
  try {
    return await contextBundleImpl(context, params);
  } catch (error) {
    console.error("context_bundle error:", error);
    throw error;
  }
}
