import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";

import { DuckDBClient } from "../shared/duckdb";

import { getDefaultBranch, getHeadCommit, gitLsFiles } from "./git";
import { detectLanguage } from "./language";
import { ensureBaseSchema } from "./schema";

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

async function ensureRepo(
  db: DuckDBClient,
  repoRoot: string,
  defaultBranch: string | null
): Promise<number> {
  // Check if repo exists first
  const existing = await db.all<{ id: number }>("SELECT id FROM repo WHERE root = ?", [repoRoot]);
  if (existing.length > 0) {
    const repoId = existing[0].id;
    // Update default_branch if provided
    if (defaultBranch) {
      await db.run("UPDATE repo SET default_branch = ? WHERE id = ?", [defaultBranch, repoId]);
    }
    return repoId;
  }

  // Generate next ID atomically using a single query
  // This approach minimizes the race window by using a CTE
  const result = await db.all<{ id: number }>(
    `
    WITH next_id AS (
      SELECT COALESCE(MAX(id), 0) + 1 AS id FROM repo
    )
    INSERT INTO repo (id, root, default_branch, indexed_at)
    SELECT next_id.id, ?, ?, CURRENT_TIMESTAMP FROM next_id
    RETURNING id
    `,
    [repoRoot, defaultBranch]
  );

  if (result.length === 0) {
    throw new Error("Failed to create repository record. Check database constraints.");
  }
  return result[0].id;
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
          `Skipped ${relativePath} as its size (${fileStat.size} bytes) exceeds the ${MAX_FILE_BYTES} byte limit. Configure MAX_FILE_BYTES to adjust this threshold.`
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
        `Skipped ${relativePath} due to read error. Resolve filesystem permissions or remove the file to include it.`
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

  const db = await DuckDBClient.connect({ databasePath, ensureDirectory: true });
  try {
    await ensureBaseSchema(db);
    const repoId = await ensureRepo(db, repoRoot, defaultBranch);
    await db.transaction(async () => {
      await db.run("DELETE FROM tree WHERE repo_id = ?", [repoId]);
      await db.run("DELETE FROM file WHERE repo_id = ?", [repoId]);
      await persistBlobs(db, blobs);
      await persistTrees(db, repoId, headCommit, files);
      await persistFiles(db, repoId, files);

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

  runIndexer({ repoRoot, databasePath, full: full || !since, since }).catch((error) => {
    console.error("Failed to index repository. Retry after resolving the logged error.");
    console.error(error);
    process.exitCode = 1;
  });
}
