import { DuckDBClient } from "../shared/duckdb";

import { ServerContext } from "./context";

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
}

const DEFAULT_SEARCH_LIMIT = 50;
const DEFAULT_SNIPPET_WINDOW = 150;

interface FileRow {
  path: string;
  lang: string | null;
  ext: string | null;
  content: string | null;
}

interface FileWithBinaryRow extends FileRow {
  is_binary: boolean;
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
  const requestedStart = params.start_line ?? 1;
  const requestedEnd =
    params.end_line ?? Math.min(totalLines, requestedStart + DEFAULT_SNIPPET_WINDOW - 1);

  const startLine = Math.max(1, Math.min(totalLines, requestedStart));
  const endLine = Math.max(startLine, Math.min(totalLines, requestedEnd));

  const snippetContent = lines.slice(startLine - 1, endLine).join("\n");

  return {
    path: row.path,
    startLine,
    endLine,
    content: snippetContent,
    totalLines,
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
    return rows[0].id;
  } catch (error) {
    if (error instanceof Error && error.message.includes("Table with name repo")) {
      throw new Error(
        "Target repository is missing from DuckDB. Run the indexer before starting the server."
      );
    }
    throw error;
  }
}
