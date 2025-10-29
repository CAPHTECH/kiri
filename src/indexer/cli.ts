import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";

import { DuckDBClient } from "../shared/duckdb.js";

import { analyzeSource, buildFallbackSnippet } from "./codeintel.js";
import { getDefaultBranch, getHeadCommit, gitLsFiles } from "./git.js";
import { detectLanguage } from "./language.js";
import { ensureBaseSchema } from "./schema.js";

interface IndexerOptions {
  repoRoot: string;
  databasePath: string;
  full: boolean;
  since?: string;
}

interface BlobRecord {
  hash: string;
  sizeBytes: number;
  lineCount: number | null;
  content: string | null;
}

interface FileRecord {
  path: string;
  blobHash: string;
  ext: string | null;
  lang: string | null;
  isBinary: boolean;
  mtimeIso: string;
}

interface SymbolRow {
  path: string;
  symbolId: number;
  name: string;
  kind: string;
  rangeStartLine: number;
  rangeEndLine: number;
  signature: string | null;
  doc: string | null;
}

interface SnippetRow {
  path: string;
  snippetId: number;
  startLine: number;
  endLine: number;
  symbolId: number | null;
}

interface DependencyRow {
  srcPath: string;
  dstKind: string;
  dst: string;
  rel: string;
}

const MAX_SAMPLE_BYTES = 32_768;
const MAX_FILE_BYTES = 32 * 1024 * 1024; // 32MB limit to prevent memory exhaustion

function countLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  return content.split(/\r?\n/).length;
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, MAX_SAMPLE_BYTES));
  if (sample.includes(0)) {
    return true;
  }
  const decoded = sample.toString("utf8");
  return decoded.includes("\uFFFD");
}

/**
 * Ensures a repository record exists in the database, creating it if necessary.
 * Uses ON CONFLICT with auto-increment to prevent race conditions in concurrent scenarios.
 *
 * @param db - Database client instance
 * @param repoRoot - Absolute path to the repository root
 * @param defaultBranch - Default branch name (e.g., "main", "master"), or null if unknown
 * @returns The repository ID (auto-generated on first insert, reused thereafter)
 */
async function ensureRepo(
  db: DuckDBClient,
  repoRoot: string,
  defaultBranch: string | null
): Promise<number> {
  // Atomically insert or update using ON CONFLICT to leverage auto-increment
  // This eliminates the TOCTOU race condition present in manual ID generation
  await db.run(
    `INSERT INTO repo (root, default_branch, indexed_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(root) DO UPDATE SET
       default_branch = COALESCE(excluded.default_branch, repo.default_branch)`,
    [repoRoot, defaultBranch]
  );

  // Fetch the ID of the existing or newly created repo
  const rows = await db.all<{ id: number }>("SELECT id FROM repo WHERE root = ?", [repoRoot]);

  if (rows.length === 0) {
    throw new Error(
      "Failed to create or find repository record. Check database constraints and schema."
    );
  }
  const row = rows[0];
  if (!row) {
    throw new Error("Failed to retrieve repository record. Database returned empty result.");
  }
  return row.id;
}

async function persistBlobs(db: DuckDBClient, blobs: Map<string, BlobRecord>): Promise<void> {
  if (blobs.size === 0) return;

  // Use bulk insert for better performance
  const blobArray = Array.from(blobs.values());
  const placeholders = blobArray.map(() => "(?, ?, ?, ?)").join(", ");
  const sql = `INSERT OR REPLACE INTO blob (hash, size_bytes, line_count, content) VALUES ${placeholders}`;

  const params: unknown[] = [];
  for (const blob of blobArray) {
    params.push(blob.hash, blob.sizeBytes, blob.lineCount, blob.content);
  }

  await db.run(sql, params);
}

async function persistTrees(
  db: DuckDBClient,
  repoId: number,
  commitHash: string,
  records: FileRecord[]
): Promise<void> {
  if (records.length === 0) return;

  // Use bulk insert for better performance
  const placeholders = records.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
  const sql = `INSERT OR REPLACE INTO tree (repo_id, commit_hash, path, blob_hash, ext, lang, is_binary, mtime) VALUES ${placeholders}`;

  const params: unknown[] = [];
  for (const record of records) {
    params.push(
      repoId,
      commitHash,
      record.path,
      record.blobHash,
      record.ext,
      record.lang,
      record.isBinary,
      record.mtimeIso
    );
  }

  await db.run(sql, params);
}

async function persistFiles(
  db: DuckDBClient,
  repoId: number,
  records: FileRecord[]
): Promise<void> {
  if (records.length === 0) return;

  // Use bulk insert for better performance
  const placeholders = records.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
  const sql = `INSERT OR REPLACE INTO file (repo_id, path, blob_hash, ext, lang, is_binary, mtime) VALUES ${placeholders}`;

  const params: unknown[] = [];
  for (const record of records) {
    params.push(
      repoId,
      record.path,
      record.blobHash,
      record.ext,
      record.lang,
      record.isBinary,
      record.mtimeIso
    );
  }

  await db.run(sql, params);
}

async function persistSymbols(
  db: DuckDBClient,
  repoId: number,
  records: SymbolRow[]
): Promise<void> {
  if (records.length === 0) return;

  const placeholders = records.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
  const sql = `
    INSERT OR REPLACE INTO symbol (
      repo_id, path, symbol_id, name, kind, range_start_line, range_end_line, signature, doc
    ) VALUES ${placeholders}
  `;

  const params: unknown[] = [];
  for (const record of records) {
    params.push(
      repoId,
      record.path,
      record.symbolId,
      record.name,
      record.kind,
      record.rangeStartLine,
      record.rangeEndLine,
      record.signature,
      record.doc
    );
  }

  await db.run(sql, params);
}

async function persistSnippets(
  db: DuckDBClient,
  repoId: number,
  records: SnippetRow[]
): Promise<void> {
  if (records.length === 0) return;

  const placeholders = records.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
  const sql = `
    INSERT OR REPLACE INTO snippet (
      repo_id, path, snippet_id, start_line, end_line, symbol_id
    ) VALUES ${placeholders}
  `;

  const params: unknown[] = [];
  for (const record of records) {
    params.push(
      repoId,
      record.path,
      record.snippetId,
      record.startLine,
      record.endLine,
      record.symbolId
    );
  }

  await db.run(sql, params);
}

async function persistDependencies(
  db: DuckDBClient,
  repoId: number,
  records: DependencyRow[]
): Promise<void> {
  if (records.length === 0) return;

  const placeholders = records.map(() => "(?, ?, ?, ?, ?)").join(", ");
  const sql = `
    INSERT OR REPLACE INTO dependency (
      repo_id, src_path, dst_kind, dst, rel
    ) VALUES ${placeholders}
  `;

  const params: unknown[] = [];
  for (const record of records) {
    params.push(repoId, record.srcPath, record.dstKind, record.dst, record.rel);
  }

  await db.run(sql, params);
}

function buildCodeIntel(
  files: FileRecord[],
  blobs: Map<string, BlobRecord>
): { symbols: SymbolRow[]; snippets: SnippetRow[]; dependencies: DependencyRow[] } {
  const fileSet = new Set<string>(files.map((file) => file.path));
  const symbols: SymbolRow[] = [];
  const snippets: SnippetRow[] = [];
  const dependencies = new Map<string, DependencyRow>();

  for (const file of files) {
    if (file.isBinary) {
      continue;
    }

    const blob = blobs.get(file.blobHash);
    if (!blob || blob.content === null) {
      continue;
    }

    const analysis = analyzeSource(file.path, file.lang, blob.content, fileSet);

    for (const symbol of analysis.symbols) {
      symbols.push({
        path: file.path,
        symbolId: symbol.symbolId,
        name: symbol.name,
        kind: symbol.kind,
        rangeStartLine: symbol.rangeStartLine,
        rangeEndLine: symbol.rangeEndLine,
        signature: symbol.signature,
        doc: symbol.doc,
      });
    }

    if (analysis.snippets.length > 0) {
      analysis.snippets.forEach((snippet, index) => {
        snippets.push({
          path: file.path,
          snippetId: index + 1,
          startLine: snippet.startLine,
          endLine: snippet.endLine,
          symbolId: snippet.symbolId,
        });
      });
    } else if (blob.lineCount !== null) {
      const fallback = buildFallbackSnippet(blob.lineCount);
      snippets.push({
        path: file.path,
        snippetId: 1,
        startLine: fallback.startLine,
        endLine: fallback.endLine,
        symbolId: fallback.symbolId,
      });
    }

    for (const dependency of analysis.dependencies) {
      const key = `${file.path}::${dependency.dstKind}::${dependency.dst}::${dependency.rel}`;
      if (!dependencies.has(key)) {
        dependencies.set(key, {
          srcPath: file.path,
          dstKind: dependency.dstKind,
          dst: dependency.dst,
          rel: dependency.rel,
        });
      }
    }
  }

  return { symbols, snippets, dependencies: Array.from(dependencies.values()) };
}

async function scanFiles(
  repoRoot: string,
  paths: string[]
): Promise<{ blobs: Map<string, BlobRecord>; files: FileRecord[] }> {
  const blobs = new Map<string, BlobRecord>();
  const files: FileRecord[] = [];

  for (const relativePath of paths) {
    const absolutePath = join(repoRoot, relativePath);
    try {
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) {
        continue;
      }

      // Check file size before reading to prevent memory exhaustion
      if (fileStat.size > MAX_FILE_BYTES) {
        console.warn(
          `File ${relativePath} exceeds size limit (${fileStat.size} bytes). Increase MAX_FILE_BYTES constant to include it.`
        );
        continue;
      }

      const buffer = await readFile(absolutePath);
      const isBinary = isBinaryBuffer(buffer);
      const hash = createHash("sha1").update(buffer).digest("hex");
      const ext = extname(relativePath) || null;
      const lang = ext ? detectLanguage(ext) : null;
      const mtimeIso = fileStat.mtime.toISOString();

      let content: string | null = null;
      let lineCount: number | null = null;
      if (!isBinary) {
        content = buffer.toString("utf8");
        lineCount = countLines(content);
      }

      if (!blobs.has(hash)) {
        blobs.set(hash, {
          hash,
          sizeBytes: buffer.length,
          lineCount,
          content,
        });
      }

      files.push({
        path: relativePath,
        blobHash: hash,
        ext,
        lang,
        isBinary,
        mtimeIso,
      });
    } catch (error) {
      console.warn(
        `Cannot read ${relativePath} due to filesystem error. Fix file permissions or remove the file.`
      );
      console.warn(error);
    }
  }

  return { blobs, files };
}

export async function runIndexer(options: IndexerOptions): Promise<void> {
  if (!options.full && options.since) {
    console.warn("Incremental indexing is not yet supported. Falling back to full reindex.");
  }

  const repoRoot = resolve(options.repoRoot);
  const databasePath = resolve(options.databasePath);

  const [paths, headCommit, defaultBranch] = await Promise.all([
    gitLsFiles(repoRoot),
    getHeadCommit(repoRoot),
    getDefaultBranch(repoRoot),
  ]);

  const { blobs, files } = await scanFiles(repoRoot, paths);
  const codeIntel = buildCodeIntel(files, blobs);

  const db = await DuckDBClient.connect({ databasePath, ensureDirectory: true });
  try {
    await ensureBaseSchema(db);
    const repoId = await ensureRepo(db, repoRoot, defaultBranch);
    await db.transaction(async () => {
      await db.run("DELETE FROM tree WHERE repo_id = ?", [repoId]);
      await db.run("DELETE FROM file WHERE repo_id = ?", [repoId]);
      await db.run("DELETE FROM symbol WHERE repo_id = ?", [repoId]);
      await db.run("DELETE FROM snippet WHERE repo_id = ?", [repoId]);
      await db.run("DELETE FROM dependency WHERE repo_id = ?", [repoId]);
      await persistBlobs(db, blobs);
      await persistTrees(db, repoId, headCommit, files);
      await persistFiles(db, repoId, files);
      await persistSymbols(db, repoId, codeIntel.symbols);
      await persistSnippets(db, repoId, codeIntel.snippets);
      await persistDependencies(db, repoId, codeIntel.dependencies);

      // Update timestamp inside transaction to ensure atomicity
      if (defaultBranch) {
        await db.run(
          "UPDATE repo SET indexed_at = CURRENT_TIMESTAMP, default_branch = ? WHERE id = ?",
          [defaultBranch, repoId]
        );
      } else {
        await db.run("UPDATE repo SET indexed_at = CURRENT_TIMESTAMP WHERE id = ?", [repoId]);
      }
    });
  } finally {
    await db.close();
  }

  console.info(
    `Indexed ${files.length} files for repo ${repoRoot} at ${databasePath} (commit ${headCommit.slice(0, 12)})`
  );
}

function parseArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index >= 0) {
    return process.argv[index + 1];
  }
  return undefined;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const repoRoot = resolve(parseArg("--repo") ?? ".");
  const databasePath = resolve(parseArg("--db") ?? "var/index.duckdb");
  const full = process.argv.includes("--full");
  const since = parseArg("--since");

  const options: IndexerOptions = { repoRoot, databasePath, full: full || !since };
  if (since) {
    options.since = since;
  }

  runIndexer(options).catch((error) => {
    console.error("Failed to index repository. Retry after resolving the logged error.");
    console.error(error);
    process.exitCode = 1;
  });
}
