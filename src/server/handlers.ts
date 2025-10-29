import { DuckDBClient } from "../shared/duckdb.js";

import { ServerContext } from "./context.js";

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

const DEFAULT_SEARCH_LIMIT = 50;
const DEFAULT_SNIPPET_WINDOW = 150;

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
      throw new Error(
        "Failed to retrieve repository record. Database returned empty result."
      );
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
