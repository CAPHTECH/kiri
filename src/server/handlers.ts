import path from "node:path";

import { DuckDBClient } from "../shared/duckdb.js";
import { generateEmbedding, structuralSimilarity } from "../shared/embedding.js";
import { encode as encodeGPT, tokenizeText } from "../shared/tokenizer.js";

import { ServerContext } from "./context.js";
import { coerceProfileName, loadScoringProfile, type ScoringWeights } from "./scoring.js";

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

/**
 * Check if a file path represents a configuration file
 * Supports multiple languages: JS/TS, Python, Ruby, Go, PHP, Java, Rust, C/C++, Docker, CI/CD
 * @param path - Full file path
 * @param fileName - File name only (extracted from path)
 * @returns true if the file is a configuration file
 */
function isConfigFile(path: string, fileName: string): boolean {
  return (
    (CONFIG_FILES as readonly string[]).includes(fileName) ||
    CONFIG_EXTENSIONS.some((ce) => path.endsWith(ce)) ||
    CONFIG_PATTERNS.some((pattern) => path.includes(pattern)) ||
    fileName.startsWith(".env")
  );
}

export interface FilesSearchParams {
  query: string;
  lang?: string;
  ext?: string;
  path_prefix?: string;
  limit?: number;
  boost_profile?: "default" | "docs" | "none";
}

export interface FilesSearchResult {
  path: string;
  preview: string;
  matchLine: number;
  lang: string | null;
  ext: string | null;
  score: number;
}

export interface SnippetsGetParams {
  path: string;
  start_line?: number;
  end_line?: number;
}

export interface SnippetResult {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  totalLines: number;
  symbolName: string | null;
  symbolKind: string | null;
}

export interface ContextBundleArtifacts {
  editing_path?: string;
  failing_tests?: string[];
  last_diff?: string;
}

export interface ContextBundleParams {
  goal: string;
  artifacts?: ContextBundleArtifacts;
  limit?: number;
  profile?: string;
  boost_profile?: "default" | "docs" | "none";
  compact?: boolean; // If true, omit preview field to reduce token usage
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
  tokens_estimate: number;
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
const DEFAULT_SNIPPET_WINDOW = 150;
const DEFAULT_BUNDLE_LIMIT = 7; // Reduced from 12 to optimize token usage
const MAX_BUNDLE_LIMIT = 20;
const MAX_KEYWORDS = 12;
const MAX_MATCHES_PER_KEYWORD = 40;
const MAX_DEPENDENCY_SEEDS = 8;
const MAX_DEPENDENCY_SEEDS_QUERY_LIMIT = 100; // SQL injection防御用の上限
const NEARBY_LIMIT = 6;
const FALLBACK_SNIPPET_WINDOW = 40; // Reduced from 120 to optimize token usage
const MAX_RERANK_LIMIT = 50;

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "have",
  "has",
  "will",
  "would",
  "into",
  "about",
  "there",
  "their",
  "your",
  "fix",
  "test",
  "tests",
  "issue",
  "error",
  "bug",
  "fail",
  "failing",
  "make",
  "when",
  "where",
  "should",
  "could",
  "need",
  "goal",
]);

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
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term));
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
      if (part.length >= 3 && !STOP_WORDS.has(part) && !segments.includes(part)) {
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
    (word) => word.length >= 3 && !STOP_WORDS.has(word)
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
          .filter((part) => part.length >= 3 && !STOP_WORDS.has(part));
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

  return result;
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
    };
    map.set(filePath, candidate);
  }
  return candidate;
}

function parseEmbedding(vectorJson: string | null, vectorDims: number | null): number[] | null {
  if (!vectorJson || !vectorDims || vectorDims <= 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(vectorJson) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    const values: number[] = [];
    for (let i = 0; i < parsed.length && i < vectorDims; i += 1) {
      const raw = parsed[i];
      const num = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(num)) {
        return null;
      }
      values.push(num);
    }
    return values.length === vectorDims ? values : null;
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
  profile: "default" | "docs" | "none" = "default",
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
  if (blacklistedDirs.some((dir) => path.startsWith(dir))) {
    return -100; // Effectively remove it
  }

  if (profile === "none") {
    return baseScore;
  }

  // Extract file extension for type detection
  const ext = path.includes(".") ? path.substring(path.lastIndexOf(".")) : null;

  // ✅ UNIFIED LOGIC: Use same multiplicative penalties as context_bundle
  if (profile === "docs") {
    // Boost documentation files
    if (path.endsWith(".md") || path.endsWith(".yaml") || path.endsWith(".yml")) {
      return baseScore * 1.5; // 50% boost (same as context_bundle)
    }
    // Penalty for implementation files in docs mode
    if (
      path.startsWith("src/") &&
      (path.endsWith(".ts") || path.endsWith(".js") || path.endsWith(".tsx"))
    ) {
      return baseScore * 0.5; // 50% penalty
    }
    return baseScore;
  }

  // Default profile: Use configurable multiplicative penalties
  let multiplier = 1.0;
  const fileName = path.split("/").pop() ?? "";

  // ✅ Step 1: Config files get strongest penalty (95% reduction)
  if (isConfigFile(path, fileName)) {
    multiplier *= weights.configPenaltyMultiplier; // 0.05 = 95% reduction
    return baseScore * multiplier;
  }

  // ✅ Step 2: Documentation files get moderate penalty (50% reduction)
  const docExtensions = [".md", ".yaml", ".yml", ".mdc"];
  if (docExtensions.some((docExt) => path.endsWith(docExt))) {
    multiplier *= weights.docPenaltyMultiplier; // 0.5 = 50% reduction
    return baseScore * multiplier;
  }

  // ✅ Step 3: Implementation file boosts
  if (path.startsWith("src/app/")) {
    multiplier *= weights.implBoostMultiplier * 1.4; // Extra boost for app files
  } else if (path.startsWith("src/components/")) {
    multiplier *= weights.implBoostMultiplier * 1.3;
  } else if (path.startsWith("src/lib/")) {
    multiplier *= weights.implBoostMultiplier * 1.2;
  } else if (path.startsWith("src/")) {
    if (ext === ".ts" || ext === ".tsx" || ext === ".js") {
      multiplier *= weights.implBoostMultiplier; // Base impl boost
    }
  }

  // Test files: additive penalty (keep strong for files_search)
  if (path.startsWith("tests/") || path.startsWith("test/")) {
    return baseScore * 0.2; // Strong penalty for tests
  }

  return baseScore * multiplier;
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

  // フレーズがパスに完全一致する場合（最高の重み）
  for (const phrase of extractedTerms.phrases) {
    if (lowerPath.includes(phrase)) {
      candidate.score += weights.pathMatch * 1.5; // 1.5倍のブースト
      candidate.reasons.add(`path-phrase:${phrase}`);
      return; // 最初のマッチのみ適用
    }
  }

  // パスセグメントがマッチする場合（中程度の重み）
  const pathParts = lowerPath.split("/");
  for (const segment of extractedTerms.pathSegments) {
    if (pathParts.includes(segment)) {
      candidate.score += weights.pathMatch;
      candidate.reasons.add(`path-segment:${segment}`);
      return; // 最初のマッチのみ適用
    }
  }

  // 通常のキーワードがパスに含まれる場合（低い重み）
  for (const keyword of extractedTerms.keywords) {
    if (lowerPath.includes(keyword)) {
      candidate.score += weights.pathMatch * 0.5; // 0.5倍のブースト
      candidate.reasons.add(`path-keyword:${keyword}`);
      return; // 最初のマッチのみ適用
    }
  }
}

/**
 * 加算的ファイルペナルティを適用
 * ブラックリストディレクトリ、テストファイル、lockファイル、設定ファイル、マイグレーションファイルに強いペナルティ
 * @returns true if penalty was applied and processing should stop
 */
function applyAdditiveFilePenalties(
  candidate: CandidateInfo,
  path: string,
  lowerPath: string,
  fileName: string
): boolean {
  // Blacklisted directories - effectively remove
  const blacklistedDirs = [
    ".cursor/",
    ".devcontainer/",
    ".serena/",
    "__mocks__/",
    "docs/",
    "test/",
    "tests/",
    ".git/",
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
  if (blacklistedDirs.some((dir) => path.startsWith(dir))) {
    candidate.score = -100;
    candidate.reasons.add("penalty:blacklisted-dir");
    return true;
  }

  // Test files - strong penalty
  const testPatterns = [".spec.ts", ".spec.js", ".test.ts", ".test.js", ".spec.tsx", ".test.tsx"];
  if (testPatterns.some((pattern) => lowerPath.endsWith(pattern))) {
    candidate.score -= 2.0;
    candidate.reasons.add("penalty:test-file");
    return true;
  }

  // Lock files - very strong penalty
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
    candidate.score -= 3.0;
    candidate.reasons.add("penalty:lock-file");
    return true;
  }

  // Configuration files - strong penalty
  const configPatterns = [
    ".config.js",
    ".config.ts",
    ".config.mjs",
    ".config.cjs",
    "tsconfig.json",
    "jsconfig.json",
    "package.json",
    ".eslintrc",
    ".prettierrc",
    "jest.config",
    "vite.config",
    "vitest.config",
    "webpack.config",
    "rollup.config",
  ];
  if (
    configPatterns.some((pattern) => lowerPath.endsWith(pattern) || fileName.startsWith(".env")) ||
    fileName === "Dockerfile" ||
    fileName === "docker-compose.yml" ||
    fileName === "docker-compose.yaml"
  ) {
    candidate.score -= 1.5;
    candidate.reasons.add("penalty:config-file");
    return true;
  }

  // Migration files - strong penalty
  if (lowerPath.includes("migrate") || lowerPath.includes("migration")) {
    candidate.score -= 2.0;
    candidate.reasons.add("penalty:migration-file");
    return true;
  }

  return false; // No penalty applied, continue processing
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
  profile: "default" | "docs" | "none",
  weights: ScoringWeights
): void {
  if (profile === "none") {
    return;
  }

  // ✅ CRITICAL SAFETY: profile="docs" mode boosts docs, skips penalties
  if (profile === "docs") {
    const docExtensions = [".md", ".yaml", ".yml", ".mdc"];
    if (docExtensions.some((docExt) => path.endsWith(docExt))) {
      candidate.scoreMultiplier *= 1.5; // 50% boost for docs
      candidate.reasons.add("boost:doc-file");
    }
    // No penalty for implementation files in "docs" mode
    return;
  }

  // DEFAULT PROFILE: Use MULTIPLICATIVE penalties for config/docs, MULTIPLICATIVE boosts for impl files
  if (profile === "default") {
    const fileName = path.split("/").pop() ?? "";

    // ✅ Step 1: Config files get strongest penalty (95% reduction)
    if (isConfigFile(path, fileName)) {
      candidate.scoreMultiplier *= weights.configPenaltyMultiplier; // 0.05 = 95% reduction
      candidate.reasons.add("penalty:config-file");
      return; // Don't apply impl boosts to config files
    }

    // ✅ Step 2: Documentation files get moderate penalty (50% reduction)
    const docExtensions = [".md", ".yaml", ".yml", ".mdc"];
    if (docExtensions.some((docExt) => path.endsWith(docExt))) {
      candidate.scoreMultiplier *= weights.docPenaltyMultiplier; // 0.5 = 50% reduction
      candidate.reasons.add("penalty:doc-file");
      return; // Don't apply impl boosts to docs
    }

    // ✅ Step 3: Implementation files get multiplicative boost
    if (path.startsWith("src/app/")) {
      candidate.scoreMultiplier *= weights.implBoostMultiplier * 1.4; // Extra boost for app files
      candidate.reasons.add("boost:app-file");
    } else if (path.startsWith("src/components/")) {
      candidate.scoreMultiplier *= weights.implBoostMultiplier * 1.3;
      candidate.reasons.add("boost:component-file");
    } else if (path.startsWith("src/lib/")) {
      candidate.scoreMultiplier *= weights.implBoostMultiplier * 1.2;
      candidate.reasons.add("boost:lib-file");
    } else if (path.startsWith("src/")) {
      if (ext === ".ts" || ext === ".tsx" || ext === ".js") {
        candidate.scoreMultiplier *= weights.implBoostMultiplier;
        candidate.reasons.add("boost:impl-file");
      }
    }
  }
}

/**
 * contextBundle専用のブーストプロファイル適用（v0.7.0+: リファクタリング版）
 * 複雑度を削減するために3つのヘルパー関数に分割：
 * 1. applyPathBasedScoring: パスベースの加算的スコアリング
 * 2. applyAdditiveFilePenalties: 強力な加算的ペナルティ
 * 3. applyFileTypeMultipliers: 乗算的ペナルティ/ブースト
 *
 * CRITICAL SAFETY RULES:
 * 1. Multipliers are stored in candidate.scoreMultiplier, applied AFTER all additive scoring
 * 2. profile="docs" skips documentation penalties (allows doc-focused queries)
 * 3. Blacklist/test/lock/config files keep additive penalties (already very strong)
 */
function applyBoostProfile(
  candidate: CandidateInfo,
  row: { path: string; ext: string | null },
  profile: "default" | "docs" | "none",
  weights: ScoringWeights,
  extractedTerms?: ExtractedTerms
): void {
  if (profile === "none") {
    return;
  }

  const { path, ext } = row;
  const lowerPath = path.toLowerCase();
  const fileName = path.split("/").pop() ?? "";

  // Step 1: パスベースのスコアリング（加算的ブースト）
  applyPathBasedScoring(candidate, lowerPath, weights, extractedTerms);

  // Step 2: 加算的ペナルティ（ブラックリスト、テスト、lock、設定、マイグレーション）
  const shouldStop = applyAdditiveFilePenalties(candidate, path, lowerPath, fileName);
  if (shouldStop) {
    return; // ペナルティが適用された場合は処理終了
  }

  // Step 3: ファイルタイプ別の乗算的ペナルティ/ブースト
  applyFileTypeMultipliers(candidate, path, ext, profile, weights);
}

export async function filesSearch(
  context: ServerContext,
  params: FilesSearchParams
): Promise<FilesSearchResult[]> {
  const { db, repoId } = context;
  const { query } = params;
  if (!query || query.trim().length === 0) {
    throw new Error(
      "files_search requires a non-empty query. Provide a search keyword to continue."
    );
  }

  const limit = normalizeLimit(params.limit);
  const hasFTS = context.features?.fts ?? false;

  let sql: string;
  let values: unknown[];

  if (hasFTS) {
    // FTS拡張利用可能: fts_main_blob.match_bm25 を使用
    const conditions = ["f.repo_id = ?"];
    values = [repoId];

    // 言語・拡張子フィルタ
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

    // FTS検索（BM25スコアリング）
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

    values.unshift(query); // FTSクエリを先頭に追加
    values.push(limit);
  } else {
    // FTS拡張利用不可: ILIKE検索（Phase 1の単語分割ロジック）
    const conditions = ["f.repo_id = ?", "b.content IS NOT NULL"];
    values = [repoId];

    const words = splitQueryWords(query);
    if (words.length === 1) {
      conditions.push("b.content ILIKE '%' || ? || '%'");
      values.push(query);
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

  const rows = await db.all<FileRow>(sql, values);

  const boostProfile = params.boost_profile ?? "default";

  // ✅ v0.7.0+: Load configurable scoring weights for unified boosting logic
  // Note: filesSearch doesn't have a separate profile parameter, uses default weights
  const weights = loadScoringProfile(null);

  return rows
    .map((row) => {
      const { preview, line } = buildPreview(row.content ?? "", query);
      const baseScore = row.score ?? 1.0; // FTS時はBM25スコア、ILIKE時は1.0
      const boostedScore = applyFileTypeBoost(row.path, baseScore, boostProfile, weights);

      return {
        path: row.path,
        preview,
        matchLine: line,
        lang: row.lang,
        ext: row.ext,
        score: boostedScore,
      };
    })
    .sort((a, b) => b.score - a.score); // スコアの高い順に再ソート
}

export async function snippetsGet(
  context: ServerContext,
  params: SnippetsGetParams
): Promise<SnippetResult> {
  const { db, repoId } = context;
  if (!params.path) {
    throw new Error(
      "snippets_get requires a file path. Specify a tracked text file path to continue."
    );
  }

  const rows = await db.all<FileWithBinaryRow>(
    `
      SELECT f.path, f.lang, f.ext, f.is_binary, b.content
      FROM file f
      JOIN blob b ON b.hash = f.blob_hash
      WHERE f.repo_id = ? AND f.path = ?
      LIMIT 1
    `,
    [repoId, params.path]
  );

  if (rows.length === 0) {
    throw new Error(
      "Requested snippet file was not indexed. Re-run the indexer or choose another path."
    );
  }

  const row = rows[0];
  if (!row) {
    throw new Error(
      "Requested snippet file was not indexed. Re-run the indexer or choose another path."
    );
  }

  if (row.is_binary) {
    throw new Error(
      "Binary snippets are not supported. Choose a text file to preview its content."
    );
  }

  if (row.content === null) {
    throw new Error("Snippet content is unavailable. Re-run the indexer to refresh DuckDB state.");
  }

  const lines = row.content.split(/\r?\n/);
  const totalLines = lines.length;
  const snippetRows = await db.all<SnippetRow>(
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
    [repoId, params.path]
  );

  const requestedStart = params.start_line ?? 1;
  const requestedEnd =
    params.end_line ?? Math.min(totalLines, requestedStart + DEFAULT_SNIPPET_WINDOW - 1);

  const useSymbolSnippets = snippetRows.length > 0 && params.end_line === undefined;

  let snippetSelection: SnippetRow | null = null;
  if (useSymbolSnippets) {
    snippetSelection =
      snippetRows.find(
        (snippet) => requestedStart >= snippet.start_line && requestedStart <= snippet.end_line
      ) ?? null;
    if (!snippetSelection) {
      const firstSnippet = snippetRows[0];
      if (firstSnippet && requestedStart < firstSnippet.start_line) {
        snippetSelection = firstSnippet;
      } else {
        snippetSelection = snippetRows[snippetRows.length - 1] ?? null;
      }
    }
  }

  let startLine: number;
  let endLine: number;
  let symbolName: string | null = null;
  let symbolKind: string | null = null;

  if (snippetSelection) {
    startLine = snippetSelection.start_line;
    endLine = snippetSelection.end_line;
    symbolName = snippetSelection.symbol_name;
    symbolKind = snippetSelection.symbol_kind;
  } else {
    startLine = Math.max(1, Math.min(totalLines, requestedStart));
    endLine = Math.max(startLine, Math.min(totalLines, requestedEnd));
  }

  const snippetContent = lines.slice(startLine - 1, endLine).join("\n");

  return {
    path: row.path,
    startLine,
    endLine,
    content: snippetContent,
    totalLines,
    symbolName,
    symbolKind,
  };
}

export async function contextBundle(
  context: ServerContext,
  params: ContextBundleParams
): Promise<ContextBundleResult> {
  const { db, repoId } = context;
  const goal = params.goal?.trim() ?? "";
  if (goal.length === 0) {
    throw new Error(
      "context_bundle requires a non-empty goal. Describe your objective to receive context."
    );
  }

  const limit = normalizeBundleLimit(params.limit);
  const artifacts = params.artifacts ?? {};

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
  const semanticSeed = keywordSources.join(" ");
  const queryEmbedding = generateEmbedding(semanticSeed)?.values ?? null;

  const extractedTerms = extractKeywords(semanticSeed);

  // フォールバック: editing_pathからキーワードを抽出
  if (
    extractedTerms.phrases.length === 0 &&
    extractedTerms.keywords.length === 0 &&
    artifacts.editing_path
  ) {
    const pathSegments = artifacts.editing_path
      .split(/[/_.-]/)
      .map((segment) => segment.toLowerCase())
      .filter((segment) => segment.length >= 3 && !STOP_WORDS.has(segment));
    extractedTerms.pathSegments.push(...pathSegments.slice(0, MAX_KEYWORDS));
  }

  const candidates = new Map<string, CandidateInfo>();
  const stringMatchSeeds = new Set<string>();
  const fileCache = new Map<string, FileContentCacheEntry>();

  // フレーズマッチング（高い重み: textMatch × 2）- 統合クエリでパフォーマンス改善
  if (extractedTerms.phrases.length > 0) {
    const phrasePlaceholders = extractedTerms.phrases
      .map(() => "b.content ILIKE '%' || ? || '%'")
      .join(" OR ");
    const rows = await db.all<FileWithEmbeddingRow>(
      `
        SELECT f.path, f.lang, f.ext, f.is_binary, b.content, fe.vector_json, fe.dims AS vector_dims
        FROM file f
        JOIN blob b ON b.hash = f.blob_hash
        LEFT JOIN file_embedding fe
          ON fe.repo_id = f.repo_id
         AND fe.path = f.path
        WHERE f.repo_id = ?
          AND f.is_binary = FALSE
          AND (${phrasePlaceholders})
        ORDER BY f.path
        LIMIT ?
      `,
      [repoId, ...extractedTerms.phrases, MAX_MATCHES_PER_KEYWORD * extractedTerms.phrases.length]
    );

    const boostProfile = params.boost_profile ?? "default";

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

      // 各マッチしたフレーズに対してスコアリング
      for (const phrase of matchedPhrases) {
        // フレーズマッチは通常の2倍のスコア
        candidate.score += weights.textMatch * 2.0;
        candidate.reasons.add(`phrase:${phrase}`);
      }

      // Apply boost profile once per file
      applyBoostProfile(candidate, row, boostProfile, weights, extractedTerms);

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
  }

  // キーワードマッチング（通常の重み）- 統合クエリでパフォーマンス改善
  if (extractedTerms.keywords.length > 0) {
    const keywordPlaceholders = extractedTerms.keywords
      .map(() => "b.content ILIKE '%' || ? || '%'")
      .join(" OR ");
    const rows = await db.all<FileWithEmbeddingRow>(
      `
        SELECT f.path, f.lang, f.ext, f.is_binary, b.content, fe.vector_json, fe.dims AS vector_dims
        FROM file f
        JOIN blob b ON b.hash = f.blob_hash
        LEFT JOIN file_embedding fe
          ON fe.repo_id = f.repo_id
         AND fe.path = f.path
        WHERE f.repo_id = ?
          AND f.is_binary = FALSE
          AND (${keywordPlaceholders})
        ORDER BY f.path
        LIMIT ?
      `,
      [repoId, ...extractedTerms.keywords, MAX_MATCHES_PER_KEYWORD * extractedTerms.keywords.length]
    );

    const boostProfile = params.boost_profile ?? "default";

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

      // 各マッチしたキーワードに対してスコアリング
      for (const keyword of matchedKeywords) {
        candidate.score += weights.textMatch;
        candidate.reasons.add(`text:${keyword}`);
      }

      // Apply boost profile once per file
      applyBoostProfile(candidate, row, boostProfile, weights, extractedTerms);

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
  }

  if (artifacts.editing_path) {
    const editingCandidate = ensureCandidate(candidates, artifacts.editing_path);
    editingCandidate.score += weights.editingPath;
    editingCandidate.reasons.add("artifact:editing_path");
    editingCandidate.matchLine ??= 1;
  }

  // SQL injection防御: ファイルパスの検証パターン
  const SAFE_PATH_PATTERN = /^[a-zA-Z0-9_.\-/]+$/;

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
        `Invalid editing_path format. Path must contain only alphanumeric characters, underscores, dots, hyphens, and forward slashes.`
      );
    }
    dependencySeeds.add(artifacts.editing_path);
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
      throw new Error("Invalid placeholder generation detected. Operation aborted for safety.");
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

  const materializedCandidates: CandidateInfo[] = [];
  for (const candidate of candidates.values()) {
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
    materializedCandidates.push(candidate);
  }

  if (materializedCandidates.length === 0) {
    return { context: [], tokens_estimate: 0 };
  }

  applyStructuralScores(materializedCandidates, queryEmbedding, weights.structural);

  // ✅ CRITICAL SAFETY: Apply multipliers AFTER all additive scoring (v0.7.0)
  // Only apply to positive scores to prevent negative score inversion
  for (const candidate of materializedCandidates) {
    if (candidate.scoreMultiplier !== 1.0 && candidate.score > 0) {
      candidate.score *= candidate.scoreMultiplier;
    }
  }

  const sortedCandidates = materializedCandidates
    .filter((candidate) => candidate.score > 0) // Filter out candidates with negative or zero scores
    .sort((a, b) => {
      if (b.score === a.score) {
        return a.path.localeCompare(b.path);
      }
      return b.score - a.score;
    })
    .slice(0, limit);

  const maxScore = Math.max(...sortedCandidates.map((candidate) => candidate.score));

  const results: ContextBundleItem[] = [];
  for (const candidate of sortedCandidates) {
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

    if (endLine < startLine) {
      endLine = startLine;
    }

    const reasons = new Set(candidate.reasons);
    if (selected && selected.symbol_name) {
      reasons.add(`symbol:${selected.symbol_name}`);
    }

    const normalizedScore = maxScore > 0 ? candidate.score / maxScore : 0;

    const item: ContextBundleItem = {
      path: candidate.path,
      range: [startLine, endLine],
      why: Array.from(reasons).sort(),
      score: Number.isFinite(normalizedScore) ? normalizedScore : 0,
    };

    // Add preview only if not in compact mode
    if (!params.compact) {
      item.preview = buildSnippetPreview(candidate.content, startLine, endLine);
    }

    results.push(item);
  }

  // コンテンツベースのトークン推定を使用（より正確）
  const tokensEstimate = results.reduce((acc, item) => {
    const candidate = sortedCandidates.find((c) => c.path === item.path);
    if (candidate && candidate.content) {
      return acc + estimateTokensFromContent(candidate.content, item.range[0], item.range[1]);
    }
    // フォールバック: 行ベース推定（コンテンツが利用不可の場合）
    const lineCount = Math.max(1, item.range[1] - item.range[0] + 1);
    return acc + lineCount * 4;
  }, 0);

  return { context: results, tokens_estimate: tokensEstimate };
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

export async function resolveRepoId(db: DuckDBClient, repoRoot: string): Promise<number> {
  try {
    const rows = await db.all<{ id: number }>("SELECT id FROM repo WHERE root = ?", [repoRoot]);
    if (rows.length === 0) {
      throw new Error(
        "Target repository is missing from DuckDB. Run the indexer before starting the server."
      );
    }
    const row = rows[0];
    if (!row) {
      throw new Error("Failed to retrieve repository record. Database returned empty result.");
    }
    return row.id;
  } catch (error) {
    if (error instanceof Error && error.message.includes("Table with name repo")) {
      throw new Error(
        "Target repository is missing from DuckDB. Run the indexer before starting the server."
      );
    }
    throw error;
  }
}
