import { ServerContext } from "../context.js";

/**
 * snippets_get tool のパラメータ
 */
/**
 * view パラメータの有効な値
 * - "auto": 現行動作を維持（シンボルがあればシンボル境界、なければ行範囲）
 * - "symbol": 強制的にシンボル境界ベースのスニペットを返す
 * - "lines": 行範囲ベースのスニペットを返す（シンボル境界を無視）
 * - "full": ファイル全体を返す（安全上限付き）
 */
export type SnippetsGetView = "auto" | "symbol" | "lines" | "full";

export interface SnippetsGetParams {
  path: string;
  start_line?: number;
  end_line?: number;
  compact?: boolean; // If true, omit content payload entirely
  includeLineNumbers?: boolean; // If true, prefix content lines with line numbers
  view?: SnippetsGetView; // 取得戦略を明示的に制御
}

/**
 * snippets_get tool のレスポンス
 */
export interface SnippetResult {
  path: string;
  startLine: number;
  endLine: number;
  content?: string;
  totalLines: number;
  symbolName: string | null;
  symbolKind: string | null;
  truncated?: boolean; // 行数/文字数の安全上限で切り詰められた場合 true
}

/**
 * Internal types for database queries
 */
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

interface SnippetRow {
  snippet_id: number;
  start_line: number;
  end_line: number;
  symbol_id: number | null;
  symbol_name: string | null;
  symbol_kind: string | null;
}

/**
 * Constants
 */
const DEFAULT_SNIPPET_WINDOW = 150;
const MAX_SNIPPET_LINES = 500; // 全モード共通の安全上限
const MAX_SNIPPET_CHARS = 200_000; // 返却内容の安全上限（1レスポンスの最大文字数）

/**
 * 行番号をプレフィックスとして追加する（動的幅調整）
 *
 * @param snippet - スニペットの内容
 * @param startLine - 開始行番号（1-indexed）
 * @returns 行番号付きスニペット
 */
function prependLineNumbers(snippet: string, startLine: number): string {
  const lines = snippet.split(/\r?\n/);
  if (lines.length === 0) {
    return snippet;
  }
  // Calculate required width from the last line number (dynamic sizing)
  const endLine = startLine + lines.length - 1;
  const width = String(endLine).length;
  return lines
    .map((line, index) => `${String(startLine + index).padStart(width, " ")}→${line}`)
    .join("\n");
}

/**
 * snippets_get MCP Tool Handler
 *
 * 指定されたファイルパスから、シンボル境界を考慮したコードスニペットを取得する。
 * start_line/end_line が指定されていない場合、最適なシンボル（関数、クラスなど）を自動選択する。
 *
 * @param context - サーバーコンテキスト（DB、repoId等）
 * @param params - snippets_get パラメータ
 * @returns スニペット結果
 * @throws Error ファイルが見つからない、バイナリファイル、コンテンツが利用不可の場合
 */
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
      `Requested snippet file ${params.path} was not indexed. Re-run the indexer or choose another path.`
    );
  }

  const row = rows[0];
  if (!row) {
    throw new Error(
      `Requested snippet file ${params.path} was not indexed. Re-run the indexer or choose another path.`
    );
  }

  if (row.is_binary) {
    throw new Error(
      "Binary snippets are not supported. Choose a text file to preview its content."
    );
  }

  if (row.content === null) {
    throw new Error(
      `Snippet content was NULL for ${params.path}. Re-run the indexer with --full to repopulate blob content.`
    );
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

  const view = params.view ?? "auto";

  // view パラメータに基づいて取得戦略を決定
  let useSymbolSnippets: boolean;
  let requestedStart: number;
  let requestedEnd: number;

  switch (view) {
    case "symbol":
      // 強制的にシンボル境界を使用
      useSymbolSnippets = snippetRows.length > 0;
      requestedStart = params.start_line ?? 1;
      requestedEnd =
        params.end_line ?? Math.min(totalLines, requestedStart + DEFAULT_SNIPPET_WINDOW - 1);
      break;
    case "lines":
      // 行ベース取得（シンボル境界を無視）
      useSymbolSnippets = false;
      requestedStart = params.start_line ?? 1;
      requestedEnd =
        params.end_line ?? Math.min(totalLines, requestedStart + DEFAULT_SNIPPET_WINDOW - 1);
      break;
    case "full":
      // ファイル全体を返す（安全上限付き、start_line/end_line は無視）
      useSymbolSnippets = false;
      requestedStart = 1; // 常に1行目から開始
      requestedEnd = Math.min(totalLines, MAX_SNIPPET_LINES);
      break;
    case "auto":
    default: {
      // 現行動作: シンボルがあり end_line 未指定の場合はシンボル境界を使用
      useSymbolSnippets = snippetRows.length > 0 && params.end_line === undefined;
      requestedStart = params.start_line ?? 1;
      requestedEnd =
        params.end_line ?? Math.min(totalLines, requestedStart + DEFAULT_SNIPPET_WINDOW - 1);
      break;
    }
  }

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
  let truncated = false;

  if (snippetSelection) {
    startLine = snippetSelection.start_line;
    endLine = snippetSelection.end_line;
    symbolName = snippetSelection.symbol_name;
    symbolKind = snippetSelection.symbol_kind;
  } else {
    startLine = Math.max(1, Math.min(totalLines, requestedStart));
    endLine = Math.max(startLine, Math.min(totalLines, requestedEnd));
  }

  if (view === "full" && totalLines > MAX_SNIPPET_LINES) {
    truncated = true;
  }

  const limitEnd = snippetSelection ? Math.min(snippetSelection.end_line, totalLines) : totalLines;

  if (snippetSelection) {
    const symbolLineCount = snippetSelection.end_line - snippetSelection.start_line + 1;
    if (symbolLineCount > MAX_SNIPPET_LINES) {
      const anchor = Math.max(
        snippetSelection.start_line,
        Math.min(snippetSelection.end_line, requestedStart)
      );
      const maxStart = Math.max(
        snippetSelection.start_line,
        snippetSelection.end_line - MAX_SNIPPET_LINES + 1
      );
      startLine = Math.min(Math.max(anchor, snippetSelection.start_line), maxStart);
      endLine = Math.min(limitEnd, startLine + MAX_SNIPPET_LINES - 1);
      truncated = true;
    }
  }

  if (endLine > limitEnd) {
    endLine = limitEnd;
  }

  if (endLine - startLine + 1 > MAX_SNIPPET_LINES) {
    endLine = Math.min(limitEnd, startLine + MAX_SNIPPET_LINES - 1);
    truncated = true;
  }

  const isCompact = params.compact === true;
  const addLineNumbers = params.includeLineNumbers === true && !isCompact;

  let content: string | undefined;
  if (!isCompact) {
    const snippetContent = lines.slice(startLine - 1, endLine).join("\n");
    const numberedContent = addLineNumbers
      ? prependLineNumbers(snippetContent, startLine)
      : snippetContent;
    if (numberedContent.length > MAX_SNIPPET_CHARS) {
      content = numberedContent.slice(0, MAX_SNIPPET_CHARS);
      truncated = true;
    } else {
      content = numberedContent;
    }
  }

  return {
    path: row.path,
    startLine,
    endLine,
    ...(content !== undefined && { content }),
    totalLines,
    symbolName,
    symbolKind,
    ...(truncated && { truncated }),
  };
}
