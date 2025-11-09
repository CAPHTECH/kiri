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
      indexed_at TIMESTAMP,
      fts_last_indexed_at TIMESTAMP,
      fts_dirty BOOLEAN DEFAULT false
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
 * repoテーブルにFTSメタデータ列を追加（Phase 3マイグレーション）
 * 既存DBとの互換性のため、列が存在しない場合のみ追加
 * @param db - DuckDBクライアント
 * @throws Error if migration fails (except when repo table doesn't exist yet)
 */
export async function ensureRepoMetaColumns(db: DuckDBClient): Promise<void> {
  // Check if repo table exists first
  const tables = await db.all<{ table_name: string }>(
    `SELECT table_name FROM duckdb_tables() WHERE table_name = 'repo'`
  );

  if (tables.length === 0) {
    // repo table doesn't exist yet - will be created by ensureBaseSchema()
    return;
  }

  // 列の存在確認
  const columns = await db.all<{ column_name: string }>(
    `SELECT column_name FROM duckdb_columns()
     WHERE table_name = 'repo' AND column_name IN ('fts_last_indexed_at', 'fts_dirty')`
  );

  const hasLastIndexedAt = columns.some((c) => c.column_name === "fts_last_indexed_at");
  const hasDirty = columns.some((c) => c.column_name === "fts_dirty");

  // fts_last_indexed_atの追加
  if (!hasLastIndexedAt) {
    await db.run(`ALTER TABLE repo ADD COLUMN fts_last_indexed_at TIMESTAMP`);
  }

  // fts_dirtyの追加
  if (!hasDirty) {
    await db.run(`ALTER TABLE repo ADD COLUMN fts_dirty BOOLEAN DEFAULT false`);
  }

  // 既存レコードの初期化：常にdirty=trueで初期化
  // (rebuildFTSIfNeededが実際のFTS状態を確認して処理を決定)
  // 理由: multi-repo環境で新規repoが誤ってclean扱いされるのを防ぐため
  await db.run(`
    UPDATE repo
    SET fts_dirty = true
    WHERE fts_last_indexed_at IS NULL
  `);
}

/**
 * FTS（全文検索）インデックスの作成を試行
 * @param db - DuckDBクライアント
 * @param forceRebuild - 強制的に再構築する場合true
 * @returns FTS拡張が利用可能な場合true、それ以外false
 */
export async function tryCreateFTSIndex(db: DuckDBClient, forceRebuild = false): Promise<boolean> {
  try {
    // FTS拡張の利用可能性を確認
    await db.run(`
      INSTALL fts;
      LOAD fts;
    `);

    // forceRebuildが指定されていない場合は既存インデックスを確認
    if (!forceRebuild) {
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
    }

    // blob.content に FTS インデックスを作成
    // Phase 2: インデクサー内での利用を想定し、overwrite=1で常に再構築
    // （dirty flag管理により、実際の呼び出しは必要時のみ）
    await db.run(`
      PRAGMA create_fts_index('blob', 'hash', 'content', overwrite=1);
    `);

    return true;
  } catch (error) {
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
export async function checkFTSSchemaExists(db: DuckDBClient): Promise<boolean> {
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

/**
 * FTS拡張の利用可能性のみをチェック（Phase 2: サーバー起動時用）
 * インデックスの作成は行わず、存在確認のみ
 * @param db - DuckDBクライアント
 * @returns FTS拡張がロード可能でインデックスが存在する場合true
 */
export async function checkFTSAvailability(db: DuckDBClient): Promise<boolean> {
  try {
    // FTS拡張のロードを試行
    await db.run(`LOAD fts;`);

    // FTSスキーマの存在確認
    return await checkFTSSchemaExists(db);
  } catch (error) {
    // FTS拡張がロードできない、またはスキーマが存在しない
    return false;
  }
}

/**
 * dirty flagに基づいてFTSインデックスを条件付きで再構築（Phase 2+3: インデクサー用）
 * @param db - DuckDBクライアント
 * @param repoId - リポジトリID
 * @param forceFTS - FTS再構築を強制する場合true
 * @returns FTSが利用可能な場合true
 */
export async function rebuildFTSIfNeeded(
  db: DuckDBClient,
  repoId: number,
  forceFTS = false
): Promise<boolean> {
  try {
    // メタデータ列の存在確認と初期化
    await ensureRepoMetaColumns(db);

    // dirty flagまたはFTS不在を確認
    const rows = await db.all<{ fts_dirty: boolean }>(`SELECT fts_dirty FROM repo WHERE id = ?`, [
      repoId,
    ]);

    const row = rows[0];
    const isDirty = row?.fts_dirty ?? true;
    const ftsExists = await checkFTSSchemaExists(db);

    // FTS再構築が必要かチェック
    if (forceFTS || isDirty || !ftsExists) {
      console.info("Rebuilding FTS index...");
      const success = await tryCreateFTSIndex(db, true);

      if (success) {
        // 成功時はdirty=false, last_indexed_at=nowを設定
        await db.run(
          `UPDATE repo
           SET fts_dirty = false,
               fts_last_indexed_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [repoId]
        );
        console.info("✅ FTS index rebuilt successfully");
      } else {
        // 失敗時はdirtyを維持
        console.warn("⚠️  FTS index rebuild failed, will retry on next indexer run");
      }

      return success;
    }

    // 再構築不要
    console.info("FTS index is up to date, skipping rebuild");
    return true;
  } catch (error) {
    console.warn("Failed to rebuild FTS index:", error);
    return false;
  }
}

/**
 * FTS dirty flagを設定（Phase 3: ウォッチモード用）
 * Note: 現在は rebuildFTSIfNeeded() の使用を推奨。この関数は将来のウォッチモード実装用に保持。
 * @param db - DuckDBクライアント
 * @param repoId - リポジトリID
 * @throws Error if database update fails
 */
export async function setFTSDirty(db: DuckDBClient, repoId: number): Promise<void> {
  // Ensure the fts_dirty column exists before trying to update it
  await ensureRepoMetaColumns(db);

  // Update the dirty flag (errors are propagated to caller)
  await db.run(`UPDATE repo SET fts_dirty = true WHERE id = ?`, [repoId]);
}
