import { DuckDBClient } from "../shared/duckdb.js";
import { normalizeRepoPath } from "../shared/utils/path.js";

export async function ensureBaseSchema(db: DuckDBClient): Promise<void> {
  await db.run(`
    CREATE SEQUENCE IF NOT EXISTS repo_id_seq START 1
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS repo (
      id INTEGER PRIMARY KEY DEFAULT nextval('repo_id_seq'),
      root TEXT NOT NULL UNIQUE,
      normalized_root TEXT,
      default_branch TEXT,
      indexed_at TIMESTAMP,
      fts_last_indexed_at TIMESTAMP,
      fts_dirty BOOLEAN DEFAULT false,
      fts_status TEXT DEFAULT 'dirty',
      fts_generation INTEGER DEFAULT 0
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
     WHERE table_name = 'repo' AND column_name IN ('fts_last_indexed_at', 'fts_dirty', 'fts_status', 'fts_generation')`
  );

  const hasLastIndexedAt = columns.some((c) => c.column_name === "fts_last_indexed_at");
  const hasDirty = columns.some((c) => c.column_name === "fts_dirty");
  const hasStatus = columns.some((c) => c.column_name === "fts_status");
  const hasGeneration = columns.some((c) => c.column_name === "fts_generation");

  // fts_last_indexed_atの追加
  if (!hasLastIndexedAt) {
    await db.run(`ALTER TABLE repo ADD COLUMN fts_last_indexed_at TIMESTAMP`);
  }

  // fts_dirtyの追加
  if (!hasDirty) {
    await db.run(`ALTER TABLE repo ADD COLUMN fts_dirty BOOLEAN DEFAULT false`);
  }

  // fts_statusの追加 (Fix #2: FTS rebuild status tracking)
  if (!hasStatus) {
    await db.run(`ALTER TABLE repo ADD COLUMN fts_status TEXT DEFAULT 'dirty'`);
  }

  // fts_generationの追加 (Fix #3: Lost dirty flags prevention)
  if (!hasGeneration) {
    await db.run(`ALTER TABLE repo ADD COLUMN fts_generation INTEGER DEFAULT 0`);
  }

  // 既存レコードの初期化：常にdirty=trueで初期化
  // (rebuildFTSIfNeededが実際のFTS状態を確認して処理を決定)
  // 理由: multi-repo環境で新規repoが誤ってclean扱いされるのを防ぐため
  await db.run(`
    UPDATE repo
    SET fts_dirty = true,
        fts_status = 'dirty'
    WHERE fts_last_indexed_at IS NULL
  `);
}

/**
 * repoテーブルにnormalized_root列とインデックスを追加（Phase 1: Critical #1）
 * 既存DBとの互換性のため、列が存在しない場合のみ追加
 *
 * @param db - DuckDBクライアント
 * @throws Error if migration fails (except when repo table doesn't exist yet)
 */
export async function ensureNormalizedRootColumn(db: DuckDBClient): Promise<void> {
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
     WHERE table_name = 'repo' AND column_name = 'normalized_root'`
  );

  const hasNormalizedRoot = columns.length > 0;

  // normalized_rootの追加
  if (!hasNormalizedRoot) {
    await db.run(`ALTER TABLE repo ADD COLUMN normalized_root TEXT`);
  }

  // 既存レコードのbackfill（トランザクション内で実行）
  await db.transaction(async () => {
    const needsBackfill = await db.all<{ id: number; root: string }>(
      `SELECT id, root FROM repo WHERE normalized_root IS NULL`
    );

    if (needsBackfill.length > 0) {
      // バッチ更新で高速化
      for (const row of needsBackfill) {
        const normalized = normalizeRepoPath(row.root);
        await db.run(`UPDATE repo SET normalized_root = ? WHERE id = ?`, [normalized, row.id]);
      }
    }
  });

  // インデックスの存在確認
  const indexes = await db.all<{ index_name: string }>(
    `SELECT index_name FROM duckdb_indexes() WHERE index_name = 'repo_normalized_root_idx'`
  );

  // UNIQUE インデックスの作成
  if (indexes.length === 0) {
    // NOTE: UNIQUE制約により、同じ正規化パスを持つ複数のrepoは登録不可
    // 衝突時は既存のrepoを使用するか、mergeLegacyRepoRowsで統合する
    await db.run(`
      CREATE UNIQUE INDEX repo_normalized_root_idx ON repo(normalized_root)
    `);
  }
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
  } catch {
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
  } catch {
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
  } catch {
    // FTS拡張がロードできない、またはスキーマが存在しない
    return false;
  }
}

/**
 * dirty flagに基づいてFTSインデックスを条件付きで再構築（Phase 2+3: インデクサー用）
 *
 * @deprecated The `repoId` parameter is currently ignored due to global FTS architecture.
 * Use `rebuildGlobalFTS()` instead for clearer intent. This signature will be removed in v2.0.
 *
 * NOTE: DuckDB FTS index is GLOBAL (one fts_main_blob schema for entire blob table).
 * We check if ANY repo is dirty to avoid partial corruption in multi-repo environments.
 * Future improvement: migrate to dedicated fts_metadata table (see Codex design proposal).
 *
 * @param db - DuckDBクライアント
 * @param repoId - リポジトリID (⚠️ IGNORED: FTS is global, not per-repo)
 * @param forceFTS - FTS再構築を強制する場合true
 * @returns FTSが利用可能な場合true
 */
export async function rebuildFTSIfNeeded(
  db: DuckDBClient,
  repoId: number,
  forceFTS = false
): Promise<boolean> {
  console.warn(
    "rebuildFTSIfNeeded: repoId parameter is deprecated and ignored (FTS is global). Use rebuildGlobalFTS() instead."
  );
  return rebuildGlobalFTS(db, { forceFTS });
}

/**
 * グローバルFTSインデックスを再構築（Fix #4: New API without misleading repoId parameter）
 *
 * NOTE: DuckDB FTS index is GLOBAL (one fts_main_blob schema for entire blob table).
 * This function rebuilds FTS for all repos in the database, with proper status tracking
 * and generation-based dirty flag management to prevent lost concurrent updates.
 *
 * @param db - DuckDBクライアント
 * @param options - オプション設定
 * @param options.forceFTS - FTS再構築を強制する場合true
 * @returns FTSが利用可能な場合true
 */
export async function rebuildGlobalFTS(
  db: DuckDBClient,
  options: { forceFTS?: boolean } = {}
): Promise<boolean> {
  const forceFTS = options.forceFTS ?? false;

  try {
    // メタデータ列の存在確認と初期化
    await ensureRepoMetaColumns(db);

    // CRITICAL: Check if ANY repo is dirty or rebuilding (FTS is global, not per-repo)
    // This prevents multi-repo corruption where one repo's failure breaks all repos
    const statusCheck = await db.all<{ count: number }>(
      `SELECT COUNT(*) as count FROM repo
       WHERE fts_dirty = true OR fts_status IN ('dirty', 'rebuilding')`
    );
    const needsRebuild = (statusCheck[0]?.count ?? 0) > 0;
    const ftsExists = await checkFTSSchemaExists(db);

    // FTS再構築が必要かチェック
    if (forceFTS || needsRebuild || !ftsExists) {
      // Fix #2: Wrap entire rebuild in transaction with status tracking
      // Fix #3: Capture dirty repos' generations to prevent lost updates
      const dirtyRepos = await db.all<{ id: number; fts_generation: number }>(
        `SELECT id, fts_generation FROM repo WHERE fts_dirty = true`
      );

      if (dirtyRepos.length === 0 && !forceFTS && ftsExists) {
        // No dirty repos and FTS exists - likely another process is rebuilding
        console.info("FTS rebuild already in progress or completed by another process");
        return true;
      }

      // Fix: Wrap metadata updates in transaction for atomicity
      return await db.transaction(async () => {
        // Fix: Set only dirty/dirty-status repos to 'rebuilding' to avoid permanent rebuilding state
        await db.run(
          `UPDATE repo SET fts_status = 'rebuilding'
           WHERE fts_dirty = true OR fts_status = 'dirty'`
        );

        console.info("Rebuilding FTS index...");
        // Note: tryCreateFTSIndex must run inside transaction to ensure metadata consistency
        const success = await tryCreateFTSIndex(db, true);

        if (success) {
          // Fix #3 & #5: Clear dirty flags based on rebuild context using parameterized queries
          const generationTargets = forceFTS
            ? await db.all<{ id: number; fts_generation: number }>(
                `SELECT id, fts_generation FROM repo WHERE fts_status = 'rebuilding'`
              )
            : dirtyRepos;

          if (generationTargets.length > 0) {
            for (const repo of generationTargets) {
              await db.run(
                `UPDATE repo
                 SET fts_dirty = false,
                     fts_status = 'clean',
                     fts_last_indexed_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND fts_generation = ?`,
                [repo.id, repo.fts_generation]
              );
            }
          } else {
            // No dirty repos but rebuild was needed (e.g., fts schema was missing)
            // Only clear rows that are still marked as rebuilding to avoid wiping
            // fresh dirty flags raised during the rebuild window.
            await db.run(
              `UPDATE repo
               SET fts_dirty = false,
                   fts_status = 'clean',
                   fts_last_indexed_at = CURRENT_TIMESTAMP
               WHERE fts_status = 'rebuilding'`
            );
          }

          console.info("✅ FTS index rebuilt successfully");
        } else {
          // Fix #2: On failure, reset status to 'dirty' so next run will retry
          await db.run(`UPDATE repo SET fts_status = 'dirty' WHERE fts_status = 'rebuilding'`);
          console.warn("⚠️  FTS index rebuild failed, will retry on next indexer run");
        }

        return success;
      });
    }

    // 再構築不要
    console.info("FTS index is up to date, skipping rebuild");
    return true;
  } catch (error) {
    // On exception, reset any 'rebuilding' status to 'dirty'
    try {
      await db.run(`UPDATE repo SET fts_status = 'dirty' WHERE fts_status = 'rebuilding'`);
    } catch {
      // Ignore cleanup errors
    }
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

  // Update the dirty flag with generation increment (Fix #3: prevents lost updates)
  // Incrementing generation ensures concurrent setFTSDirty calls aren't lost during rebuild
  await db.run(
    `UPDATE repo
     SET fts_dirty = true,
         fts_status = 'dirty',
         fts_generation = fts_generation + 1
     WHERE id = ?`,
    [repoId]
  );
}
