import { DuckDBClient } from "../shared/duckdb.js";

export async function ensureBaseSchema(db: DuckDBClient): Promise<void> {
  await db.run(`
    CREATE SEQUENCE IF NOT EXISTS repo_id_seq START 1
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS repo (
      id INTEGER PRIMARY KEY DEFAULT nextval('repo_id_seq'),
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

  await db.run(`
    CREATE TABLE IF NOT EXISTS symbol (
      repo_id INTEGER,
      path TEXT,
      symbol_id BIGINT,
      name TEXT,
      kind TEXT,
      range_start_line INTEGER,
      range_end_line INTEGER,
      signature TEXT,
      doc TEXT,
      PRIMARY KEY (repo_id, path, symbol_id)
    )
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_symbol_name ON symbol(repo_id, name)
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS snippet (
      repo_id INTEGER,
      path TEXT,
      snippet_id BIGINT,
      start_line INTEGER,
      end_line INTEGER,
      symbol_id BIGINT NULL,
      PRIMARY KEY (repo_id, path, snippet_id)
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS dependency (
      repo_id INTEGER,
      src_path TEXT,
      dst_kind TEXT,
      dst TEXT,
      rel TEXT,
      PRIMARY KEY (repo_id, src_path, dst_kind, dst, rel)
    )
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_dep_src ON dependency(repo_id, src_path)
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS file_embedding (
      repo_id INTEGER,
      path TEXT,
      dims INTEGER NOT NULL,
      vector_json TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (repo_id, path)
    )
  `);
}

/**
 * FTS（全文検索）インデックスの作成を試行
 * @param db - DuckDBクライアント
 * @returns FTS拡張が利用可能な場合true、それ以外false
 */
export async function tryCreateFTSIndex(db: DuckDBClient): Promise<boolean> {
  try {
    // FTS拡張の利用可能性を確認
    await db.run(`
      INSTALL fts;
      LOAD fts;
    `);

    // 既存のFTSインデックスを確認
    const schemaExists = await checkFTSSchemaExists(db);
    if (schemaExists) {
      // インデックスの整合性を検証
      const isValid = await verifyFTSIntegrity(db);
      if (isValid) {
        // 既存の有効なインデックスがあるのでスキップ
        return true;
      }
      // 整合性検証失敗 - 再作成が必要
      console.warn("FTS index integrity check failed, recreating index...");
    }

    // blob.content に FTS インデックスを作成
    // overwrite=0 でrace conditionに対応（既存があればエラー）
    await db.run(`
      PRAGMA create_fts_index('blob', 'hash', 'content', overwrite=0);
    `);

    return true;
  } catch (error) {
    // Race condition: 別プロセスが既にインデックスを作成した場合
    if (error instanceof Error && error.message.includes("already exists")) {
      return true;
    }

    // FTS拡張が利用できない場合は警告を出してfalseを返す
    console.warn("FTS extension unavailable, using ILIKE fallback:", error);
    return false;
  }
}

/**
 * FTSスキーマの存在を確認
 * @param db - DuckDBクライアント
 * @returns スキーマが存在する場合true
 */
async function checkFTSSchemaExists(db: DuckDBClient): Promise<boolean> {
  try {
    const schemas = await db.all<{ schema_name: string }>(
      `SELECT schema_name FROM duckdb_schemas() WHERE schema_name = 'fts_main_blob'`
    );
    return schemas.length > 0;
  } catch (error) {
    // クエリ失敗時は存在しないと判断
    return false;
  }
}

/**
 * FTSインデックスの整合性を検証
 * @param db - DuckDBクライアント
 * @returns インデックスが有効な場合true
 */
async function verifyFTSIntegrity(db: DuckDBClient): Promise<boolean> {
  try {
    // 必須テーブル（docs, terms）の存在を確認
    const tables = await db.all<{ table_name: string }>(
      `SELECT table_name FROM duckdb_tables()
       WHERE schema_name = 'fts_main_blob' AND table_name IN ('docs', 'terms')`
    );

    if (tables.length < 2) {
      return false;
    }

    // 実際にクエリを実行して動作確認（軽量チェック）
    // Note: MATCH構文を使用するため、FTS拡張が正しくロードされている必要がある
    await db.all(`SELECT docid FROM fts_main_blob.docs WHERE docs MATCH 'test' LIMIT 1`);

    return true;
  } catch (error) {
    // クエリ失敗 = インデックスが破損または不完全
    return false;
  }
}
