import path from "node:path";

import { DuckDBClient } from "../shared/duckdb.js";

import { ServerContext } from "./context.js";
import { loadScoringProfile } from "./scoring.js";

export interface FilesSearchParams {
  query: string;
  lang?: string;
  ext?: string;
  path_prefix?: string;
  limit?: number;
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
}

export interface ContextBundleItem {
  path: string;
  range: [number, number];
  preview: string;
  why: string[];
  score: number;
}

export interface ContextBundleResult {
  context: ContextBundleItem[];
  tokens_estimate: number;
}

const DEFAULT_SEARCH_LIMIT = 50;
const DEFAULT_SNIPPET_WINDOW = 150;
const DEFAULT_BUNDLE_LIMIT = 12;
const MAX_BUNDLE_LIMIT = 20;
const MAX_KEYWORDS = 12;
const MAX_MATCHES_PER_KEYWORD = 40;
const MAX_DEPENDENCY_SEEDS = 8;
const MAX_DEPENDENCY_SEEDS_QUERY_LIMIT = 100; // SQL injection防御用の上限
const NEARBY_LIMIT = 6;
const FALLBACK_SNIPPET_WINDOW = 120;

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
  direction: "outbound";
  nodes: DepsClosureNode[];
  edges: DepsClosureEdge[];
}

interface FileRow {
  path: string;
  lang: string | null;
  ext: string | null;
  content: string | null;
}

interface FileWithBinaryRow extends FileRow {
  is_binary: boolean;
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
  reasons: Set<string>;
  matchLine: number | null;
  content: string | null;
  totalLines: number | null;
  lang: string | null;
  ext: string | null;
}

interface FileContentCacheEntry {
  content: string;
  lang: string | null;
  ext: string | null;
  totalLines: number;
}

function normalizeBundleLimit(limit?: number): number {
  if (!limit || Number.isNaN(limit)) {
    return DEFAULT_BUNDLE_LIMIT;
  }
  return Math.min(Math.max(1, Math.floor(limit)), MAX_BUNDLE_LIMIT);
}

function extractKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/iu)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
  const unique: string[] = [];
  for (const word of words) {
    if (!unique.includes(word)) {
      unique.push(word);
      if (unique.length >= MAX_KEYWORDS) {
        break;
      }
    }
  }
  return unique;
}

function ensureCandidate(map: Map<string, CandidateInfo>, filePath: string): CandidateInfo {
  let candidate = map.get(filePath);
  if (!candidate) {
    candidate = {
      path: filePath,
      score: 0,
      reasons: new Set<string>(),
      matchLine: null,
      content: null,
      totalLines: null,
      lang: null,
      ext: null,
    };
    map.set(filePath, candidate);
  }
  return candidate;
}

async function loadFileContent(
  db: DuckDBClient,
  repoId: number,
  filePath: string
): Promise<FileContentCacheEntry | null> {
  const rows = await db.all<FileWithBinaryRow>(
    `
      SELECT f.path, f.lang, f.ext, f.is_binary, b.content
      FROM file f
      JOIN blob b ON b.hash = f.blob_hash
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
  if (snippet.length <= 480) {
    return snippet;
  }
  return `${snippet.slice(0, 479)}…`;
}

/**
 * トークン数を推定（行ベース）
 * 後方互換性のため、コンテンツなしでも動作する
 *
 * @param startLine - 開始行
 * @param endLine - 終了行
 * @returns 推定トークン数
 */
function estimateTokens(startLine: number, endLine: number): number {
  const lineCount = Math.max(1, endLine - startLine + 1);
  return lineCount * 4;
}

/**
 * トークン数を推定（コンテンツベース）
 * GPT-style: ~4 chars per token for code
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
  const charCount = selectedLines.reduce((sum, line) => sum + line.length, 0);
  // GPT-style: 約4文字で1トークン
  return Math.max(1, Math.ceil(charCount / 4));
}

export async function filesSearch(
  context: ServerContext,
  params: FilesSearchParams
): Promise<FilesSearchResult[]> {
  const { db, repoId } = context;
  const { query } = params;
  if (!query || query.trim().length === 0) {
    throw new Error(
      "files.search requires a non-empty query. Provide a search keyword to continue."
    );
  }

  const limit = normalizeLimit(params.limit);
  const conditions = ["f.repo_id = ?", "b.content IS NOT NULL", "b.content ILIKE '%' || ? || '%'"];
  const values: unknown[] = [repoId, query];

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

  const sql = `
    SELECT f.path, f.lang, f.ext, b.content
    FROM file f
    JOIN blob b ON b.hash = f.blob_hash
    WHERE ${conditions.join(" AND ")}
    ORDER BY f.path
    LIMIT ?
  `;

  values.push(limit);

  const rows = await db.all<FileRow>(sql, values);

  return rows.map((row) => {
    const { preview, line } = buildPreview(row.content ?? "", query);
    return {
      path: row.path,
      preview,
      matchLine: line,
      lang: row.lang,
      ext: row.ext,
      score: 1.0,
    };
  });
}

export async function snippetsGet(
  context: ServerContext,
  params: SnippetsGetParams
): Promise<SnippetResult> {
  const { db, repoId } = context;
  if (!params.path) {
    throw new Error(
      "snippets.get requires a file path. Specify a tracked text file path to continue."
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
      "context.bundle requires a non-empty goal. Describe your objective to receive context."
    );
  }

  const limit = normalizeBundleLimit(params.limit);
  const artifacts = params.artifacts ?? {};

  // スコアリング重みをロード（将来的には設定ファイルや引数から）
  const weights = loadScoringProfile();

  const keywordSources: string[] = [goal];
  if (artifacts.failing_tests && artifacts.failing_tests.length > 0) {
    keywordSources.push(artifacts.failing_tests.join(" "));
  }
  if (artifacts.last_diff) {
    keywordSources.push(artifacts.last_diff);
  }

  let keywords = extractKeywords(keywordSources.join(" "));

  if (keywords.length === 0 && artifacts.editing_path) {
    const pathSegments = artifacts.editing_path
      .split(/[\/_.-]/)
      .map((segment) => segment.toLowerCase())
      .filter((segment) => segment.length >= 3 && !STOP_WORDS.has(segment));
    keywords = pathSegments.slice(0, MAX_KEYWORDS);
  }

  const candidates = new Map<string, CandidateInfo>();
  const stringMatchSeeds = new Set<string>();
  const fileCache = new Map<string, FileContentCacheEntry>();

  for (const keyword of keywords) {
    const rows = await db.all<FileWithBinaryRow>(
      `
        SELECT f.path, f.lang, f.ext, f.is_binary, b.content
        FROM file f
        JOIN blob b ON b.hash = f.blob_hash
        WHERE f.repo_id = ?
          AND f.is_binary = FALSE
          AND b.content ILIKE '%' || ? || '%'
        ORDER BY f.path
        LIMIT ?
      `,
      [repoId, keyword, MAX_MATCHES_PER_KEYWORD]
    );

    for (const row of rows) {
      if (row.content === null) {
        continue;
      }
      const candidate = ensureCandidate(candidates, row.path);
      candidate.score += weights.textMatch;
      candidate.reasons.add(`text:${keyword}`);
      const { line } = buildPreview(row.content, keyword);
      candidate.matchLine =
        candidate.matchLine === null ? line : Math.min(candidate.matchLine, line);
      candidate.content ??= row.content;
      candidate.lang ??= row.lang;
      candidate.ext ??= row.ext;
      candidate.totalLines ??= row.content.length === 0 ? 0 : row.content.split(/\r?\n/).length;
      stringMatchSeeds.add(row.path);
      if (!fileCache.has(row.path)) {
        fileCache.set(row.path, {
          content: row.content,
          lang: row.lang,
          ext: row.ext,
          totalLines: candidate.totalLines ?? 0,
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

  const dependencySeeds = new Set<string>();
  for (const pathSeed of stringMatchSeeds) {
    dependencySeeds.add(pathSeed);
    if (dependencySeeds.size >= MAX_DEPENDENCY_SEEDS) {
      break;
    }
  }
  if (artifacts.editing_path) {
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
      } else {
        const loaded = await loadFileContent(db, repoId, candidate.path);
        if (!loaded) {
          continue;
        }
        candidate.content = loaded.content;
        candidate.lang = loaded.lang;
        candidate.ext = loaded.ext;
        candidate.totalLines = loaded.totalLines;
        fileCache.set(candidate.path, loaded);
      }
    }
    materializedCandidates.push(candidate);
  }

  if (materializedCandidates.length === 0) {
    return { context: [], tokens_estimate: 0 };
  }

  const sortedCandidates = materializedCandidates
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

    const preview = buildSnippetPreview(candidate.content, startLine, endLine);
    const reasons = new Set(candidate.reasons);
    if (selected && selected.symbol_name) {
      reasons.add(`symbol:${selected.symbol_name}`);
    }

    const normalizedScore = maxScore > 0 ? candidate.score / maxScore : 0;

    results.push({
      path: candidate.path,
      range: [startLine, endLine],
      preview,
      why: Array.from(reasons).sort(),
      score: Number.isFinite(normalizedScore) ? normalizedScore : 0,
    });
  }

  // コンテンツベースのトークン推定を使用（より正確）
  const tokensEstimate = results.reduce((acc, item) => {
    const candidate = sortedCandidates.find((c) => c.path === item.path);
    if (candidate && candidate.content) {
      return acc + estimateTokensFromContent(candidate.content, item.range[0], item.range[1]);
    }
    // フォールバック: 行ベース推定
    return acc + estimateTokens(item.range[0], item.range[1]);
  }, 0);

  return { context: results, tokens_estimate: tokensEstimate };
}

export async function depsClosure(
  context: ServerContext,
  params: DepsClosureParams
): Promise<DepsClosureResult> {
  const { db, repoId } = context;
  if (!params.path) {
    throw new Error(
      "deps.closure requires a file path. Provide a tracked source file path to continue."
    );
  }

  if (params.direction && params.direction !== "outbound") {
    throw new Error("deps.closure currently supports only outbound direction. Use outbound.");
  }

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

  const outbound = new Map<string, DependencyRow[]>();
  for (const row of dependencyRows) {
    if (!outbound.has(row.src_path)) {
      outbound.set(row.src_path, []);
    }
    outbound.get(row.src_path)?.push(row);
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
    const edges = outbound.get(current.path) ?? [];
    for (const edge of edges) {
      const nextDepth = current.depth + 1;
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
    direction: "outbound",
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
