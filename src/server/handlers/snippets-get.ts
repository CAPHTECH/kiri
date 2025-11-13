import { ServerContext } from "../context.js";

/**
 * snippets_get tool のパラメータ
 */
export interface SnippetsGetParams {
  path: string;
  start_line?: number;
  end_line?: number;
  compact?: boolean; // If true, omit content payload entirely
  includeLineNumbers?: boolean; // If true, prefix content lines with line numbers
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

  const isCompact = params.compact === true;
  const addLineNumbers = params.includeLineNumbers === true && !isCompact;

  let content: string | undefined;
  if (!isCompact) {
    const snippetContent = lines.slice(startLine - 1, endLine).join("\n");
    content = addLineNumbers ? prependLineNumbers(snippetContent, startLine) : snippetContent;
  }

  return {
    path: row.path,
    startLine,
    endLine,
    ...(content !== undefined && { content }),
    totalLines,
    symbolName,
    symbolKind,
  };
}
