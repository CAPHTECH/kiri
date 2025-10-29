import { DuckDBClient } from "../shared/duckdb";

export async function ensureBaseSchema(db: DuckDBClient): Promise<void> {
  await db.run(`
    CREATE TABLE IF NOT EXISTS repo (
      id INTEGER PRIMARY KEY,
      root TEXT NOT NULL UNIQUE,
      default_branch TEXT,
      indexed_at TIMESTAMP
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS blob (
      hash TEXT PRIMARY KEY,
      size_bytes INTEGER,
      line_count INTEGER,
      content TEXT
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS tree (
      repo_id INTEGER,
      commit_hash TEXT,
      path TEXT,
      blob_hash TEXT,
      ext TEXT,
      lang TEXT,
      is_binary BOOLEAN,
      mtime TIMESTAMP,
      PRIMARY KEY (repo_id, commit_hash, path)
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS file (
      repo_id INTEGER,
      path TEXT,
      blob_hash TEXT,
      ext TEXT,
      lang TEXT,
      is_binary BOOLEAN,
      mtime TIMESTAMP,
      PRIMARY KEY (repo_id, path)
    )
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_file_lang ON file(repo_id, lang)
  `);
}
