import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";

import { DuckDBClient } from "../shared/duckdb.js";
import { generateEmbedding } from "../shared/embedding.js";
import { acquireLock, releaseLock, LockfileError, getLockOwner } from "../shared/utils/lockfile.js";
import {
  normalizeDbPath,
  normalizeRepoPath,
  ensureDbParentDir,
  getRepoPathCandidates,
} from "../shared/utils/path.js";

import { analyzeSource, buildFallbackSnippet } from "./codeintel.js";
import { getDefaultBranch, getHeadCommit, gitLsFiles, gitDiffNameOnly } from "./git.js";
import { detectLanguage } from "./language.js";
import { getIndexerQueue } from "./queue.js";
import {
  ensureBaseSchema,
  ensureNormalizedRootColumn,
  ensureRepoMetaColumns,
  rebuildFTSIfNeeded,
} from "./schema.js";
import { IndexWatcher } from "./watch.js";

interface IndexerOptions {
  repoRoot: string;
  databasePath: string;
  full: boolean;
  since?: string;
  changedPaths?: string[]; // For incremental indexing: only reindex these files
  skipLocking?: boolean; // Fix #1: Internal use only - allows caller (e.g., watcher) to manage lock
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

interface EmbeddingRow {
  path: string;
  dims: number;
  vector: number[];
}

const MAX_SAMPLE_BYTES = 32_768;
const MAX_FILE_BYTES = 32 * 1024 * 1024; // 32MB limit to prevent memory exhaustion
const SCAN_BATCH_SIZE = 100; // Process files in batches to limit memory usage

/**
 * Maximum number of SQL placeholders per INSERT statement.
 *
 * DuckDB's internal limit is 65535 placeholders, but we use a conservative value of 30000 for:
 * 1. Safety margin: Prevents stack overflow when building large SQL strings in JavaScript
 * 2. Performance: Smaller batches reduce memory pressure and provide better error granularity
 * 3. Compatibility: Works safely across different DuckDB versions and system configurations
 *
 * This value has been validated with real-world testing:
 * - Successfully handles 10000+ files in batch-processing.spec.ts
 * - Prevents "Maximum call stack size exceeded" errors (Issue #39)
 * - Balances transaction throughput vs. individual batch size
 *
 * Example batch sizes with this limit:
 * - 4-column table (blob): 7500 records per batch
 * - 5-column table (dependency): 6000 records per batch
 * - 9-column table (symbol): 3333 records per batch
 */
const MAX_SQL_PLACEHOLDERS = 30000;

/**
 * Calculate safe batch size for SQL INSERT operations based on columns per record.
 * Ensures total placeholders per statement stays under MAX_SQL_PLACEHOLDERS.
 *
 * @param columnsPerRecord - Number of columns in the INSERT statement (must be positive)
 * @returns Safe batch size that won't exceed placeholder limit
 * @throws {Error} If columnsPerRecord is not a positive integer
 */
function calculateBatchSize(columnsPerRecord: number): number {
  if (columnsPerRecord <= 0 || !Number.isInteger(columnsPerRecord)) {
    throw new Error(`columnsPerRecord must be a positive integer, got: ${columnsPerRecord}`);
  }
  return Math.floor(MAX_SQL_PLACEHOLDERS / columnsPerRecord);
}

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
async function mergeLegacyRepoRows(
  db: DuckDBClient,
  canonicalRepoId: number,
  legacyRepoIds: number[]
): Promise<void> {
  if (legacyRepoIds.length === 0) {
    return;
  }

  const referencingTables = await db.all<{ table_name: string }>(
    `SELECT DISTINCT c.table_name
       FROM duckdb_columns() AS c
       JOIN duckdb_tables() AS t
         ON c.database_name = t.database_name
        AND c.schema_name = t.schema_name
        AND c.table_name = t.table_name
      WHERE c.column_name = 'repo_id'
        AND c.table_name <> 'repo'
        AND t.table_type = 'BASE TABLE'`
  );

  const safeTables = referencingTables
    .map((row) => row.table_name)
    .filter((name) => /^[A-Za-z0-9_]+$/.test(name));

  await db.transaction(async () => {
    for (const legacyRepoId of legacyRepoIds) {
      for (const tableName of safeTables) {
        await db.run(`UPDATE ${tableName} SET repo_id = ? WHERE repo_id = ?`, [
          canonicalRepoId,
          legacyRepoId,
        ]);
      }
      await db.run("DELETE FROM repo WHERE id = ?", [legacyRepoId]);
    }
  });
}

async function ensureRepo(
  db: DuckDBClient,
  repoRoot: string,
  defaultBranch: string | null,
  candidateRoots: string[]
): Promise<number> {
  const searchRoots = Array.from(new Set([repoRoot, ...(candidateRoots ?? [])]));
  const placeholders = searchRoots.map(() => "?").join(", ");

  let rows = await db.all<{ id: number; root: string }>(
    `SELECT id, root FROM repo WHERE root IN (${placeholders})`,
    searchRoots
  );

  if (rows.length === 0) {
    const normalized = normalizeRepoPath(repoRoot);
    await db.run(
      `INSERT INTO repo (root, normalized_root, default_branch, indexed_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(root) DO UPDATE SET
         normalized_root = excluded.normalized_root,
         default_branch = COALESCE(excluded.default_branch, repo.default_branch)`,
      [repoRoot, normalized, defaultBranch]
    );

    rows = await db.all<{ id: number; root: string }>(
      `SELECT id, root FROM repo WHERE root IN (${placeholders})`,
      searchRoots
    );
  }

  if (rows.length === 0) {
    throw new Error(
      "Failed to create or find repository record. Check database constraints and schema."
    );
  }

  let canonicalRow = rows.find((row) => row.root === repoRoot) ?? rows[0];
  if (!canonicalRow) {
    throw new Error("Failed to retrieve repository record. Database returned empty result.");
  }

  if (canonicalRow.root !== repoRoot) {
    await db.run("UPDATE repo SET root = ? WHERE id = ?", [repoRoot, canonicalRow.id]);
    canonicalRow = { ...canonicalRow, root: repoRoot };
  }

  const legacyIds = rows.filter((row) => row.id !== canonicalRow.id).map((row) => row.id);
  await mergeLegacyRepoRows(db, canonicalRow.id, legacyIds);

  return canonicalRow.id;
}

/**
 * Generic helper function to persist records in batches to prevent stack overflow.
 * Splits large datasets into smaller batches and executes INSERT statements sequentially.
 *
 * IMPORTANT: This function must be called within an active database transaction.
 * See runIndexer() for transaction management context.
 *
 * @param db - Database client (must be within an active transaction)
 * @param records - Array of records to persist
 * @param batchSize - Maximum number of records per INSERT statement
 * @param buildInsert - Function that builds SQL and params for a batch
 */
async function persistInBatches<T>(
  db: DuckDBClient,
  records: T[],
  batchSize: number,
  buildInsert: (batch: T[]) => { sql: string; params: unknown[] }
): Promise<void> {
  if (records.length === 0) return;

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const { sql, params } = buildInsert(batch);

    try {
      await db.run(sql, params);
    } catch (error) {
      // バッチインデックスとサイズを含むエラーメッセージ（0-indexedの正確な範囲）
      const batchInfo = `Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(records.length / batchSize)} (records ${i}-${i + batch.length - 1})`;
      throw new Error(
        `Failed to persist batch: ${batchInfo}. Original error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

/**
 * Persist blob records to database in batches to prevent stack overflow.
 *
 * IMPORTANT: This function must be called within an active database transaction.
 * See runIndexer() for transaction management context.
 *
 * @param db - Database client (must be within an active transaction)
 * @param blobs - Map of blob records to persist
 */
async function persistBlobs(db: DuckDBClient, blobs: Map<string, BlobRecord>): Promise<void> {
  const blobArray = Array.from(blobs.values());
  const BATCH_SIZE = calculateBatchSize(4); // blob table has 4 columns

  await persistInBatches(db, blobArray, BATCH_SIZE, (batch) => ({
    sql: `INSERT OR REPLACE INTO blob (hash, size_bytes, line_count, content) VALUES ${batch.map(() => "(?, ?, ?, ?)").join(", ")}`,
    params: batch.flatMap((blob) => [blob.hash, blob.sizeBytes, blob.lineCount, blob.content]),
  }));
}

/**
 * Persist tree records to database in batches to prevent stack overflow.
 *
 * IMPORTANT: This function must be called within an active database transaction.
 * See runIndexer() for transaction management context.
 *
 * @param db - Database client (must be within an active transaction)
 * @param repoId - Repository ID
 * @param commitHash - Git commit hash
 * @param records - File records to persist
 */
async function persistTrees(
  db: DuckDBClient,
  repoId: number,
  commitHash: string,
  records: FileRecord[]
): Promise<void> {
  const BATCH_SIZE = calculateBatchSize(8); // tree table has 8 columns

  await persistInBatches(db, records, BATCH_SIZE, (batch) => ({
    sql: `INSERT OR REPLACE INTO tree (repo_id, commit_hash, path, blob_hash, ext, lang, is_binary, mtime) VALUES ${batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}`,
    params: batch.flatMap((record) => [
      repoId,
      commitHash,
      record.path,
      record.blobHash,
      record.ext,
      record.lang,
      record.isBinary,
      record.mtimeIso,
    ]),
  }));
}

/**
 * Persist file records to database in batches to prevent stack overflow.
 *
 * IMPORTANT: This function must be called within an active database transaction.
 * See runIndexer() for transaction management context.
 *
 * @param db - Database client (must be within an active transaction)
 * @param repoId - Repository ID
 * @param records - File records to persist
 */
async function persistFiles(
  db: DuckDBClient,
  repoId: number,
  records: FileRecord[]
): Promise<void> {
  const BATCH_SIZE = calculateBatchSize(7); // file table has 7 columns

  await persistInBatches(db, records, BATCH_SIZE, (batch) => ({
    sql: `INSERT OR REPLACE INTO file (repo_id, path, blob_hash, ext, lang, is_binary, mtime) VALUES ${batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ")}`,
    params: batch.flatMap((record) => [
      repoId,
      record.path,
      record.blobHash,
      record.ext,
      record.lang,
      record.isBinary,
      record.mtimeIso,
    ]),
  }));
}

/**
 * Persist symbol records to database in batches to prevent stack overflow.
 *
 * IMPORTANT: This function must be called within an active database transaction.
 * See runIndexer() for transaction management context.
 *
 * @param db - Database client (must be within an active transaction)
 * @param repoId - Repository ID
 * @param records - Symbol records to persist
 */
async function persistSymbols(
  db: DuckDBClient,
  repoId: number,
  records: SymbolRow[]
): Promise<void> {
  const BATCH_SIZE = calculateBatchSize(9); // symbol table has 9 columns

  await persistInBatches(db, records, BATCH_SIZE, (batch) => ({
    sql: `INSERT OR REPLACE INTO symbol (repo_id, path, symbol_id, name, kind, range_start_line, range_end_line, signature, doc) VALUES ${batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}`,
    params: batch.flatMap((r) => [
      repoId,
      r.path,
      r.symbolId,
      r.name,
      r.kind,
      r.rangeStartLine,
      r.rangeEndLine,
      r.signature,
      r.doc,
    ]),
  }));
}

/**
 * Persist snippet records to database in batches to prevent stack overflow.
 *
 * IMPORTANT: This function must be called within an active database transaction.
 * See runIndexer() for transaction management context.
 *
 * @param db - Database client (must be within an active transaction)
 * @param repoId - Repository ID
 * @param records - Snippet records to persist
 */
async function persistSnippets(
  db: DuckDBClient,
  repoId: number,
  records: SnippetRow[]
): Promise<void> {
  const BATCH_SIZE = calculateBatchSize(6); // snippet table has 6 columns

  await persistInBatches(db, records, BATCH_SIZE, (batch) => ({
    sql: `INSERT OR REPLACE INTO snippet (repo_id, path, snippet_id, start_line, end_line, symbol_id) VALUES ${batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}`,
    params: batch.flatMap((r) => [repoId, r.path, r.snippetId, r.startLine, r.endLine, r.symbolId]),
  }));
}

/**
 * Persist file dependency records to database in batches to prevent stack overflow.
 *
 * MUST be called within a transaction.
 * Batch size is dynamically calculated based on MAX_SQL_PLACEHOLDERS.
 */
async function persistDependencies(
  db: DuckDBClient,
  repoId: number,
  records: DependencyRow[]
): Promise<void> {
  const BATCH_SIZE = calculateBatchSize(5); // dependency table has 5 columns

  await persistInBatches(db, records, BATCH_SIZE, (batch) => ({
    sql: `INSERT OR REPLACE INTO dependency (repo_id, src_path, dst_kind, dst, rel) VALUES ${batch.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
    params: batch.flatMap((r) => [repoId, r.srcPath, r.dstKind, r.dst, r.rel]),
  }));
}

/**
 * Persist file embedding records to database in batches to prevent stack overflow.
 *
 * IMPORTANT: This function must be called within an active database transaction.
 * See runIndexer() for transaction management context.
 *
 * @param db - Database client (must be within an active transaction)
 * @param repoId - Repository ID
 * @param records - Embedding records to persist
 */
async function persistEmbeddings(
  db: DuckDBClient,
  repoId: number,
  records: EmbeddingRow[]
): Promise<void> {
  const BATCH_SIZE = calculateBatchSize(4); // file_embedding table has 4 parameterized columns

  await persistInBatches(db, records, BATCH_SIZE, (batch) => ({
    sql: `INSERT OR REPLACE INTO file_embedding (repo_id, path, dims, vector_json, updated_at) VALUES ${batch.map(() => "(?, ?, ?, ?, CURRENT_TIMESTAMP)").join(", ")}`,
    params: batch.flatMap((record) => [
      repoId,
      record.path,
      record.dims,
      JSON.stringify(record.vector),
    ]),
  }));
}

async function buildCodeIntel(
  files: FileRecord[],
  blobs: Map<string, BlobRecord>,
  workspaceRoot: string
): Promise<{ symbols: SymbolRow[]; snippets: SnippetRow[]; dependencies: DependencyRow[] }> {
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

    const analysis = await analyzeSource(
      file.path,
      file.lang,
      blob.content,
      fileSet,
      workspaceRoot
    );

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

/**
 * scanFilesのバッチ処理版
 * メモリ枯渇を防ぐため、ファイルをバッチで処理する
 */
async function scanFilesInBatches(
  repoRoot: string,
  paths: string[]
): Promise<{
  blobs: Map<string, BlobRecord>;
  files: FileRecord[];
  embeddings: EmbeddingRow[];
  missingPaths: string[];
}> {
  const allBlobs = new Map<string, BlobRecord>();
  const allFiles: FileRecord[] = [];
  const allEmbeddings: EmbeddingRow[] = [];
  const allMissingPaths: string[] = [];

  for (let i = 0; i < paths.length; i += SCAN_BATCH_SIZE) {
    const batch = paths.slice(i, i + SCAN_BATCH_SIZE);
    const { blobs, files, embeddings, missingPaths } = await scanFiles(repoRoot, batch);

    // マージ: blobはhashでユニークなので重複排除
    for (const [hash, blob] of blobs) {
      if (!allBlobs.has(hash)) {
        allBlobs.set(hash, blob);
      }
    }
    allFiles.push(...files);
    allEmbeddings.push(...embeddings);
    allMissingPaths.push(...missingPaths);

    // バッチデータを明示的にクリアしてGCを促す
    blobs.clear();
  }

  return {
    blobs: allBlobs,
    files: allFiles,
    embeddings: allEmbeddings,
    missingPaths: allMissingPaths,
  };
}

async function scanFiles(
  repoRoot: string,
  paths: string[]
): Promise<{
  blobs: Map<string, BlobRecord>;
  files: FileRecord[];
  embeddings: EmbeddingRow[];
  missingPaths: string[];
}> {
  const blobs = new Map<string, BlobRecord>();
  const files: FileRecord[] = [];
  const embeddings: EmbeddingRow[] = [];
  const missingPaths: string[] = [];

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

      if (!isBinary && content) {
        const embedding = generateEmbedding(content);
        if (embedding) {
          embeddings.push({ path: relativePath, dims: embedding.dims, vector: embedding.values });
        }
      }
    } catch (error) {
      // Fix #4: Track deleted files (ENOENT) for database cleanup
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        missingPaths.push(relativePath);
        continue;
      }

      // Other errors (permissions, etc.) - log and skip
      console.warn(
        `Cannot read ${relativePath} due to filesystem error. Fix file permissions or remove the file.`
      );
      console.warn(error);
    }
  }

  return { blobs, files, embeddings, missingPaths };
}

/**
 * 既存のファイルハッシュをDBから取得する（インクリメンタルインデックス用）
 * Fetches existing file hashes from database for incremental indexing
 */
async function getExistingFileHashes(
  db: DuckDBClient,
  repoId: number
): Promise<Map<string, string>> {
  const rows = await db.all<{ path: string; blob_hash: string }>(
    "SELECT path, blob_hash FROM file WHERE repo_id = ?",
    [repoId]
  );
  const hashMap = new Map<string, string>();
  for (const row of rows) {
    hashMap.set(row.path, row.blob_hash);
  }
  return hashMap;
}

/**
 * 削除されたファイルをDBから検出・削除する（インクリメンタルインデックス用）
 * Reconcile deleted files by comparing git tree with database records
 *
 * This function detects files that exist in the database but no longer exist
 * in the git tree (deleted or renamed files) and removes their records.
 *
 * @param db - Database client
 * @param repoId - Repository ID
 * @param repoRoot - Repository root path
 * @returns Array of deleted file paths
 */
async function reconcileDeletedFiles(
  db: DuckDBClient,
  repoId: number,
  repoRoot: string
): Promise<string[]> {
  // Get all current files from git tree
  const currentFiles = new Set(await gitLsFiles(repoRoot));

  // Get all indexed files from database
  const indexedFiles = await db.all<{ path: string }>("SELECT path FROM file WHERE repo_id = ?", [
    repoId,
  ]);

  // Find files that are in DB but not in git tree (deleted/renamed)
  const deletedPaths: string[] = [];
  for (const row of indexedFiles) {
    if (!currentFiles.has(row.path)) {
      deletedPaths.push(row.path);
    }
  }

  // Delete all records for removed files in a single transaction
  if (deletedPaths.length > 0) {
    await db.transaction(async () => {
      for (const path of deletedPaths) {
        await db.run("DELETE FROM symbol WHERE repo_id = ? AND path = ?", [repoId, path]);
        await db.run("DELETE FROM snippet WHERE repo_id = ? AND path = ?", [repoId, path]);
        await db.run("DELETE FROM dependency WHERE repo_id = ? AND src_path = ?", [repoId, path]);
        await db.run("DELETE FROM file_embedding WHERE repo_id = ? AND path = ?", [repoId, path]);
        await db.run("DELETE FROM tree WHERE repo_id = ? AND path = ?", [repoId, path]);
        await db.run("DELETE FROM file WHERE repo_id = ? AND path = ?", [repoId, path]);
      }
    });
  }

  return deletedPaths;
}

/**
 * 単一ファイルのレコードを削除する（トランザクション内で使用）
 * Delete all records for a single file (must be called within a transaction)
 *
 * @param db - Database client (must be within an active transaction)
 * @param repoId - Repository ID
 * @param headCommit - Current HEAD commit hash
 * @param path - File path to delete
 */
async function deleteFileRecords(
  db: DuckDBClient,
  repoId: number,
  headCommit: string,
  path: string
): Promise<void> {
  await db.run("DELETE FROM symbol WHERE repo_id = ? AND path = ?", [repoId, path]);
  await db.run("DELETE FROM snippet WHERE repo_id = ? AND path = ?", [repoId, path]);
  await db.run("DELETE FROM dependency WHERE repo_id = ? AND src_path = ?", [repoId, path]);
  await db.run("DELETE FROM file_embedding WHERE repo_id = ? AND path = ?", [repoId, path]);
  await db.run("DELETE FROM tree WHERE repo_id = ? AND commit_hash = ? AND path = ?", [
    repoId,
    headCommit,
    path,
  ]);
  await db.run("DELETE FROM file WHERE repo_id = ? AND path = ?", [repoId, path]);
}

export async function runIndexer(options: IndexerOptions): Promise<void> {
  const repoPathCandidates = getRepoPathCandidates(options.repoRoot);
  const repoRoot = repoPathCandidates[0];
  if (!repoRoot) {
    throw new Error(`Unable to resolve repository root for ${options.repoRoot}`);
  }
  let databasePath: string;

  // Fix #2: Ensure parent directory exists BEFORE normalization
  // This guarantees consistent path normalization on first and subsequent runs
  await ensureDbParentDir(options.databasePath);

  // Critical: Use normalizeDbPath to ensure consistent path across runs
  // This prevents lock file and queue key bypass when DB is accessed via symlink
  databasePath = normalizeDbPath(options.databasePath);

  // DuckDB single-writer制約対応: 同じdatabasePathへの並列書き込みを防ぐため、
  // databasePathごとのキューで直列化する
  return getIndexerQueue(databasePath).add(async () => {
    // Fix #1 & #2: Add file lock for multi-process safety (unless caller already holds lock)
    const lockfilePath = `${databasePath}.lock`;
    let lockAcquired = false;

    if (!options.skipLocking) {
      try {
        acquireLock(lockfilePath);
        lockAcquired = true;
      } catch (error) {
        if (error instanceof LockfileError) {
          const ownerPid = error.ownerPid ?? getLockOwner(lockfilePath);
          const ownerInfo = ownerPid ? ` (PID: ${ownerPid})` : "";
          throw new Error(
            `Another indexing process${ownerInfo} holds the lock for ${databasePath}. Please wait for it to complete.`
          );
        }
        throw error;
      }
    }

    let db: DuckDBClient | null = null;
    try {
      const dbClient = await DuckDBClient.connect({ databasePath, ensureDirectory: true });
      db = dbClient;
      await ensureBaseSchema(dbClient);
      // Phase 1: Ensure normalized_root column exists (Critical #1)
      await ensureNormalizedRootColumn(dbClient);
      // Phase 3: Ensure FTS metadata columns exist for existing DBs (migration)
      await ensureRepoMetaColumns(dbClient);

      const [headCommit, defaultBranch] = await Promise.all([
        getHeadCommit(repoRoot),
        getDefaultBranch(repoRoot),
      ]);

      const repoId = await ensureRepo(dbClient, repoRoot, defaultBranch, repoPathCandidates);

      // Incremental mode: only reindex files in changedPaths (empty array means no-op)
      if (options.changedPaths) {
        // First, reconcile deleted files (handle renames/deletions)
        const deletedPaths = await reconcileDeletedFiles(dbClient, repoId, repoRoot);
        if (deletedPaths.length > 0) {
          console.info(`Removed ${deletedPaths.length} deleted file(s) from index.`);
        }

        const existingHashes = await getExistingFileHashes(dbClient, repoId);
        const { blobs, files, embeddings, missingPaths } = await scanFilesInBatches(
          repoRoot,
          options.changedPaths
        );

        // Filter out files that haven't actually changed (same hash)
        const changedFiles: FileRecord[] = [];
        const changedBlobs = new Map<string, BlobRecord>();

        for (const file of files) {
          const existingHash = existingHashes.get(file.path);
          if (existingHash !== file.blobHash) {
            changedFiles.push(file);
            const blob = blobs.get(file.blobHash);
            if (blob) {
              changedBlobs.set(blob.hash, blob);
            }
          }
        }

        if (changedFiles.length === 0 && missingPaths.length === 0) {
          console.info(
            `No actual changes detected in ${options.changedPaths.length} file(s). Skipping reindex.`
          );

          // Fix #3 & #4: If files were deleted (git or watch mode), still need to dirty FTS and rebuild
          if (deletedPaths.length > 0) {
            console.info(`${deletedPaths.length} file(s) deleted (git) - marking FTS dirty`);

            if (defaultBranch) {
              await dbClient.run(
                "UPDATE repo SET indexed_at = CURRENT_TIMESTAMP, default_branch = ?, fts_dirty = true, fts_generation = fts_generation + 1 WHERE id = ?",
                [defaultBranch, repoId]
              );
            } else {
              await dbClient.run(
                "UPDATE repo SET indexed_at = CURRENT_TIMESTAMP, fts_dirty = true, fts_generation = fts_generation + 1 WHERE id = ?",
                [repoId]
              );
            }

            await rebuildFTSIfNeeded(dbClient, repoId);
          } else {
            // No deletions either - just update timestamp
            if (defaultBranch) {
              await dbClient.run(
                "UPDATE repo SET indexed_at = CURRENT_TIMESTAMP, default_branch = ? WHERE id = ?",
                [defaultBranch, repoId]
              );
            } else {
              await dbClient.run("UPDATE repo SET indexed_at = CURRENT_TIMESTAMP WHERE id = ?", [
                repoId,
              ]);
            }
          }

          return;
        }

        // Process all changed files in a single transaction for atomicity
        const fileSet = new Set<string>(files.map((f) => f.path));
        const embeddingMap = new Map<string, EmbeddingRow>();
        for (const embedding of embeddings) {
          embeddingMap.set(embedding.path, embedding);
        }
        let processedCount = 0;

        await dbClient.transaction(async () => {
          // Fix #5: Handle deleted files from watch mode (uncommitted deletions) INSIDE transaction
          // This ensures deletion + FTS dirty flag update are atomic
          if (missingPaths.length > 0) {
            // Loop through each missing file and delete with headCommit
            for (const path of missingPaths) {
              await deleteFileRecords(dbClient, repoId, headCommit, path);
            }
            console.info(
              `Removed ${missingPaths.length} missing file(s) from index (watch mode deletion).`
            );
          }

          // Process changed files
          for (const file of changedFiles) {
            const blob = changedBlobs.get(file.blobHash);
            if (!blob) continue;

            // Build code intelligence for this file
            const fileSymbols: SymbolRow[] = [];
            const fileSnippets: SnippetRow[] = [];
            const fileDependencies: DependencyRow[] = [];

            if (!file.isBinary && blob.content) {
              const analysis = await analyzeSource(
                file.path,
                file.lang,
                blob.content,
                fileSet,
                repoRoot
              );
              for (const symbol of analysis.symbols) {
                fileSymbols.push({
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
              for (const snippet of analysis.snippets) {
                fileSnippets.push({
                  path: file.path,
                  snippetId: snippet.startLine,
                  startLine: snippet.startLine,
                  endLine: snippet.endLine,
                  symbolId: snippet.symbolId,
                });
              }
              for (const dep of analysis.dependencies) {
                fileDependencies.push({
                  srcPath: file.path,
                  dstKind: dep.dstKind,
                  dst: dep.dst,
                  rel: dep.rel,
                });
              }
            } else {
              // Binary or no content: add fallback snippet
              const fallback = buildFallbackSnippet(blob.lineCount ?? 1);
              fileSnippets.push({
                path: file.path,
                snippetId: fallback.startLine,
                startLine: fallback.startLine,
                endLine: fallback.endLine,
                symbolId: fallback.symbolId,
              });
            }

            const fileEmbedding = embeddingMap.get(file.path) ?? null;

            // Delete old records for this file (within main transaction)
            await deleteFileRecords(dbClient, repoId, headCommit, file.path);

            // Insert new records (within main transaction)
            await persistBlobs(dbClient, new Map([[blob.hash, blob]]));
            await persistTrees(dbClient, repoId, headCommit, [file]);
            await persistFiles(dbClient, repoId, [file]);
            await persistSymbols(dbClient, repoId, fileSymbols);
            await persistSnippets(dbClient, repoId, fileSnippets);
            await persistDependencies(dbClient, repoId, fileDependencies);
            if (fileEmbedding) {
              await persistEmbeddings(dbClient, repoId, [fileEmbedding]);
            }

            processedCount++;
          }

          // Update timestamp and mark FTS dirty inside transaction for atomicity
          // Fix: Increment fts_generation to prevent lost updates during concurrent rebuilds
          if (defaultBranch) {
            await dbClient.run(
              "UPDATE repo SET indexed_at = CURRENT_TIMESTAMP, default_branch = ?, fts_dirty = true, fts_generation = fts_generation + 1 WHERE id = ?",
              [defaultBranch, repoId]
            );
          } else {
            await dbClient.run(
              "UPDATE repo SET indexed_at = CURRENT_TIMESTAMP, fts_dirty = true, fts_generation = fts_generation + 1 WHERE id = ?",
              [repoId]
            );
          }
        });

        console.info(
          `Incrementally indexed ${processedCount} changed file(s) for repo ${repoRoot} at ${databasePath} (commit ${headCommit.slice(0, 12)})`
        );

        // Phase 2+3: Rebuild FTS index after incremental updates (dirty=true triggers rebuild)
        await rebuildFTSIfNeeded(dbClient, repoId);
        return;
      }

      // Full mode: reindex entire repository
      const paths = await gitLsFiles(repoRoot);
      const { blobs, files, embeddings, missingPaths } = await scanFilesInBatches(repoRoot, paths);

      // In full mode, missingPaths should be rare (git ls-files returns existing files)
      // But log them if they occur (race condition: file deleted between ls-files and scan)
      if (missingPaths.length > 0) {
        console.warn(
          `${missingPaths.length} file(s) disappeared during full reindex (race condition)`
        );
      }

      const codeIntel = await buildCodeIntel(files, blobs, repoRoot);

      await dbClient.transaction(async () => {
        await dbClient.run("DELETE FROM tree WHERE repo_id = ?", [repoId]);
        await dbClient.run("DELETE FROM file WHERE repo_id = ?", [repoId]);
        await dbClient.run("DELETE FROM symbol WHERE repo_id = ?", [repoId]);
        await dbClient.run("DELETE FROM snippet WHERE repo_id = ?", [repoId]);
        await dbClient.run("DELETE FROM dependency WHERE repo_id = ?", [repoId]);
        await dbClient.run("DELETE FROM file_embedding WHERE repo_id = ?", [repoId]);
        await persistBlobs(dbClient, blobs);
        await persistTrees(dbClient, repoId, headCommit, files);
        await persistFiles(dbClient, repoId, files);
        await persistSymbols(dbClient, repoId, codeIntel.symbols);
        await persistSnippets(dbClient, repoId, codeIntel.snippets);
        await persistDependencies(dbClient, repoId, codeIntel.dependencies);
        await persistEmbeddings(dbClient, repoId, embeddings);

        // Update timestamp and mark FTS dirty inside transaction to ensure atomicity
        // Fix: Increment fts_generation to prevent lost updates during concurrent rebuilds
        if (defaultBranch) {
          await dbClient.run(
            "UPDATE repo SET indexed_at = CURRENT_TIMESTAMP, default_branch = ?, fts_dirty = true, fts_generation = fts_generation + 1 WHERE id = ?",
            [defaultBranch, repoId]
          );
        } else {
          await dbClient.run(
            "UPDATE repo SET indexed_at = CURRENT_TIMESTAMP, fts_dirty = true, fts_generation = fts_generation + 1 WHERE id = ?",
            [repoId]
          );
        }
      });

      console.info(
        `Indexed ${files.length} files for repo ${repoRoot} at ${databasePath} (commit ${headCommit.slice(0, 12)})`
      );

      // Phase 2+3: Force rebuild FTS index after full reindex
      await rebuildFTSIfNeeded(dbClient, repoId, true);
    } finally {
      // Fix #2: Ensure lock is released even if DB connection fails
      if (db) {
        await db.close();
      }
      if (lockAcquired) {
        releaseLock(lockfilePath);
      }
    }
  });
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
  const watch = process.argv.includes("--watch");
  const debounceMs = parseInt(parseArg("--debounce") ?? "500", 10);

  const options: IndexerOptions = { repoRoot, databasePath, full: full || !since };

  const main = async (): Promise<void> => {
    if (since) {
      options.since = since;
      if (!options.full) {
        const diffPaths = await gitDiffNameOnly(repoRoot, since);
        options.changedPaths = diffPaths;

        if (diffPaths.length === 0) {
          console.info(`No tracked changes since ${since}. Skipping incremental scan.`);
        }
      }
    }

    const dbMissing = !existsSync(databasePath);
    const shouldIndex =
      options.full || !options.changedPaths || options.changedPaths.length > 0 || dbMissing;

    if (shouldIndex) {
      await runIndexer(options);
    } else {
      // No diff results and not running full indexing: keep metadata fresh without DB writes
      console.info("No files to reindex. Database remains unchanged.");
    }

    if (watch) {
      // Start watch mode after initial indexing completes
      const abortController = new AbortController();
      const watcher = new IndexWatcher({
        repoRoot,
        databasePath,
        debounceMs,
        signal: abortController.signal,
      });

      // Handle graceful shutdown on SIGINT/SIGTERM
      const shutdownHandler = () => {
        process.stderr.write("\n🛑 Received shutdown signal. Stopping watch mode...\n");
        abortController.abort();
      };
      process.on("SIGINT", shutdownHandler);
      process.on("SIGTERM", shutdownHandler);

      await watcher.start();
    }
  };

  main().catch((error) => {
    console.error("Failed to index repository. Retry after resolving the logged error.");
    console.error(error);
    process.exitCode = 1;
  });
}
