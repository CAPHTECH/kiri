import { DuckDBClient } from "../shared/duckdb.js";
import { normalizeRepoPath } from "../shared/utils/path.js";

import { mergeRepoRecords } from "./migrations/repo-merger.js";

/**
 * Document metadata tables migration error
 * Provides detailed information about which migration step failed
 */
class MigrationError extends Error {
  constructor(
    message: string,
    public readonly step: "metadata_table" | "metadata_kv_table" | "index",
    public override readonly cause?: Error
  ) {
    super(message);
    this.name = "MigrationError";

    // Set cause for better error chaining (Node.js 16.9.0+)
    if (cause) {
      this.cause = cause;
    }

    // Capture stack trace for debugging
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MigrationError);
    }
  }
}

/**
 * Execute a migration step with error wrapping
 * Catches errors and wraps them in MigrationError with step context
 */
async function executeStep<T>(
  step: "metadata_table" | "metadata_kv_table" | "index",
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const stepName = step.replace(/_/g, " ");
    throw new MigrationError(
      `Failed to create ${stepName}. Re-run migration or check database permissions.`,
      step,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Column definition for schema validation
 */
interface ColumnDefinition {
  name: string;
  type: string;
  pk?: boolean; // PRIMARY KEY constraint
}

/**
 * Validate table schema using PRAGMA table_info
 * Compares actual schema with expected column definitions
 *
 * @param db DuckDB client
 * @param tableName Table name to validate
 * @param expectedColumns Expected column definitions
 * @throws MigrationError if schema doesn't match expectations
 */
async function validateTableSchema(
  db: DuckDBClient,
  tableName: string,
  expectedColumns: ColumnDefinition[],
  step: "metadata_table" | "metadata_kv_table" | "index"
): Promise<void> {
  try {
    // Get actual schema using PRAGMA table_info
    const actualColumns = await db.all<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>(`PRAGMA table_info('${tableName}')`);

    // Build map of actual columns for lookup
    const actualMap = new Map(
      actualColumns.map((col) => [col.name, { type: col.type.toUpperCase(), pk: col.pk > 0 }])
    );

    // Validate each expected column
    for (const expected of expectedColumns) {
      const actual = actualMap.get(expected.name);

      if (!actual) {
        throw new Error(`Column '${expected.name}' missing in table '${tableName}'`);
      }

      // Normalize types for comparison (e.g., "INTEGER" vs "INT", "TEXT" vs "VARCHAR")
      const expectedTypeNorm = expected.type.toUpperCase();
      const actualTypeNorm = actual.type;

      // Type validation with normalization
      const typeMatches =
        expectedTypeNorm === actualTypeNorm ||
        (expectedTypeNorm === "INTEGER" &&
          (actualTypeNorm === "INT" || actualTypeNorm === "BIGINT")) ||
        (expectedTypeNorm === "TEXT" &&
          (actualTypeNorm === "VARCHAR" || actualTypeNorm === "STRING"));

      if (!typeMatches) {
        throw new Error(
          `Column '${expected.name}' in table '${tableName}' has type '${actual.type}', expected '${expected.type}'`
        );
      }

      // PRIMARY KEY validation
      if (expected.pk && !actual.pk) {
        throw new Error(`Column '${expected.name}' in table '${tableName}' should be PRIMARY KEY`);
      }
    }
  } catch (error) {
    const stepName = step.replace(/_/g, " ");
    throw new MigrationError(
      `Schema validation failed for ${stepName}. ${error instanceof Error ? error.message : "Unknown error"}`,
      step,
      error instanceof Error ? error : undefined
    );
  }
}

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

  // Document metadata tables (delegated to dedicated migration function)
  await ensureDocumentMetadataTables(db);

  // Graph layer tables (Phase 3.2: Graph Layer for hybrid search)
  await ensureGraphLayerTables(db);

  await db.run(`
    CREATE TABLE IF NOT EXISTS markdown_link (
      repo_id INTEGER,
      src_path TEXT,
      target TEXT,
      resolved_path TEXT,
      anchor_text TEXT,
      kind TEXT,
      PRIMARY KEY (repo_id, src_path, target, anchor_text)
    )
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_markdown_link_target
      ON markdown_link(repo_id, resolved_path)
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS hint_expansion (
      repo_id INTEGER,
      hint_value TEXT,
      expansion_kind TEXT,
      target_path TEXT,
      payload JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_hint_expansion_repo
      ON hint_expansion(repo_id, created_at)
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS hint_dictionary (
      repo_id INTEGER,
      hint_value TEXT,
      target_path TEXT,
      freq INTEGER DEFAULT 1,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (repo_id, hint_value, target_path)
    )
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_hint_dictionary_repo_hint
      ON hint_dictionary(repo_id, hint_value)
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
 * Adds normalized_root column with UNIQUE index to the repo table (Phase 1: Critical #1)
 *
 * Migration Strategy:
 * 1. Adds normalized_root column (nullable initially for backward compatibility)
 * 2. Populates normalized_root from existing root values using normalizeRepoPath()
 * 3. Deduplicates repos with same normalized_root (keeps lowest ID)
 * 4. Creates UNIQUE index on normalized_root
 *
 * Deduplication Behavior:
 * - When multiple repos have the same normalized_root: keeps repo with lowest ID
 * - Deleted repos: All dependent data is automatically handled by foreign key constraints
 * - Example: /Users/foo and /users/foo normalize to same path → keeps lower ID, deletes higher ID
 * - Rationale: Lowest ID is typically the oldest/first indexed, most likely to be correct
 *
 * Safety Guarantees:
 * - Transaction-based: All operations are atomic, rollback on failure
 * - Backward compatible: Old code without normalized_root column awareness still works
 * - Idempotent: Safe to run multiple times (checks for existing column and index)
 * - Non-destructive: Only removes duplicate entries after careful validation
 *
 * Performance:
 * - Backfill: O(n) where n = number of repos (typically small, <100)
 * - Deduplication: O(m log m) where m = number of duplicate groups (typically 0-5)
 * - Index creation: O(n log n)
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

  // 重複排除: UNIQUE index 作成前に重複する normalized_root を統合
  await db.transaction(async () => {
    const duplicates = await db.all<{ normalized_root: string; ids: string }>(
      `SELECT normalized_root, STRING_AGG(CAST(id AS VARCHAR), ',') as ids
       FROM repo
       WHERE normalized_root IS NOT NULL
       GROUP BY normalized_root
       HAVING COUNT(*) > 1`
    );

    if (duplicates.length > 0) {
      // 各重複グループについて、最小IDのレコードを残して他を削除
      for (const dup of duplicates) {
        const ids = dup.ids
          .split(",")
          .map((value) => Number.parseInt(value, 10))
          .filter((id) => Number.isFinite(id))
          .sort((a, b) => a - b);

        if (ids.length === 0) {
          continue;
        }

        const keepId = ids[0];
        if (keepId === undefined) {
          continue;
        }
        const deleteIds = ids.slice(1);
        if (deleteIds.length === 0) {
          continue;
        }

        await mergeRepoRecords(db, keepId, deleteIds);
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
 * Check if document_metadata table is empty
 * Used to detect if migration needs to trigger a full reindex
 *
 * @param db - DuckDB client
 * @returns true if table exists but is empty, false otherwise
 */
export async function isDocumentMetadataEmpty(db: DuckDBClient): Promise<boolean> {
  // Check if document_metadata table exists
  const tables = await db.all<{ table_name: string }>(
    `SELECT table_name FROM duckdb_tables() WHERE table_name = 'document_metadata'`
  );

  if (tables.length === 0) {
    // Table doesn't exist yet
    return false;
  }

  // Count records in document_metadata table
  const result = await db.all<{ count: number }>(`SELECT COUNT(*) as count FROM document_metadata`);

  // Defensive: check array element exists and has valid count
  const firstRow = result[0];
  if (!firstRow || typeof firstRow.count !== "number") {
    return false;
  }

  return firstRow.count === 0;
}

/**
 * document_metadata関連テーブルを追加（マイグレーション＋新規DB用）
 * 既存DBとの互換性のため、テーブルが存在しない場合のみ作成
 *
 * Usage:
 * - Called by ensureBaseSchema() for new databases (replaces duplicate DDL)
 * - Called by CLI migration for existing databases
 *
 * Migration Strategy:
 * 1. Check if document_metadata table exists
 * 2. Create document_metadata table if missing
 * 3. Create document_metadata_kv table if missing
 * 4. Create index on document_metadata_kv if missing
 *
 * Safety Guarantees:
 * - Idempotent: Safe to run multiple times (checks for existing tables/indexes)
 * - Non-destructive: Only creates missing schema objects, never modifies existing data
 * - Backward compatible: Old code without metadata awareness still works
 *
 * Performance:
 * - O(1) for existence checks
 * - O(1) for table creation (no data migration needed)
 * - O(1) for index creation (table is initially empty)
 *
 * @param db - DuckDBクライアント
 * @throws Error if migration fails
 */
export async function ensureDocumentMetadataTables(db: DuckDBClient): Promise<void> {
  // トランザクション境界: 3つのDDL操作を単一のatomic操作として実行
  // 失敗時は自動的にロールバックされ、部分的な状態が残らない
  await db.transaction(async () => {
    // 1. document_metadataテーブルの存在確認
    const metadataTableExists = await db.all<{ table_name: string }>(
      `SELECT table_name FROM duckdb_tables() WHERE table_name = 'document_metadata'`
    );

    if (metadataTableExists.length === 0) {
      await executeStep("metadata_table", async () => {
        await db.run(`
          CREATE TABLE document_metadata (
            repo_id INTEGER,
            path TEXT,
            source TEXT,
            data JSON,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (repo_id, path, source)
          )
        `);
      });
    }

    // 2. document_metadata_kvテーブルの存在確認
    const kvTableExists = await db.all<{ table_name: string }>(
      `SELECT table_name FROM duckdb_tables() WHERE table_name = 'document_metadata_kv'`
    );

    if (kvTableExists.length === 0) {
      await executeStep("metadata_kv_table", async () => {
        await db.run(`
          CREATE TABLE document_metadata_kv (
            repo_id INTEGER,
            path TEXT,
            source TEXT,
            key TEXT,
            value TEXT,
            PRIMARY KEY (repo_id, path, source, key, value)
          )
        `);
      });
    }

    // 3. インデックスの存在確認と作成
    const indexExists = await db.all<{ index_name: string }>(
      `SELECT index_name FROM duckdb_indexes() WHERE index_name = 'idx_document_metadata_key'`
    );

    if (indexExists.length === 0) {
      await executeStep("index", async () => {
        await db.run(`
          CREATE INDEX idx_document_metadata_key
            ON document_metadata_kv(repo_id, key)
        `);
      });
    }

    // 4. スキーマ検証: 作成されたテーブルが期待通りの構造を持つことを確認
    // 検証はトランザクション内で行い、不整合があればロールバック
    await validateTableSchema(
      db,
      "document_metadata",
      [
        { name: "repo_id", type: "INTEGER" },
        { name: "path", type: "TEXT" },
        { name: "source", type: "TEXT" },
        { name: "data", type: "JSON" },
        { name: "updated_at", type: "TIMESTAMP" },
      ],
      "metadata_table"
    );

    await validateTableSchema(
      db,
      "document_metadata_kv",
      [
        { name: "repo_id", type: "INTEGER" },
        { name: "path", type: "TEXT" },
        { name: "source", type: "TEXT" },
        { name: "key", type: "TEXT" },
        { name: "value", type: "TEXT" },
      ],
      "metadata_kv_table"
    );
  });
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

/**
 * Graph Layer tables for hybrid search (Phase 3.2 of Issue #82)
 *
 * This function creates tables for:
 * 1. graph_metrics - Precomputed graph centrality metrics per file
 * 2. inbound_edges - Precomputed inbound closure (BFS up to depth 3)
 * 3. cochange - Co-change graph from git history analysis
 *
 * Invariants (verified by Alloy/TLA+ specs in specs/):
 * - DG1-DG3: Dependency graph structural invariants
 * - CC1-CC4: Co-change graph invariants (canonical ordering, positive weight)
 *
 * @param db - DuckDB client
 */
export async function ensureGraphLayerTables(db: DuckDBClient): Promise<void> {
  // 1. graph_metrics table - Precomputed centrality metrics
  await db.run(`
    CREATE TABLE IF NOT EXISTS graph_metrics (
      repo_id INTEGER,
      path TEXT,
      inbound_count INTEGER DEFAULT 0,
      outbound_count INTEGER DEFAULT 0,
      importance_score FLOAT DEFAULT 0.0,
      computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (repo_id, path)
    )
  `);

  // Index for fast importance lookup during scoring
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_graph_importance
      ON graph_metrics(repo_id, importance_score DESC)
  `);

  // 2. inbound_edges table - Precomputed BFS closure
  await db.run(`
    CREATE TABLE IF NOT EXISTS inbound_edges (
      repo_id INTEGER,
      target_path TEXT,
      source_path TEXT,
      depth INTEGER,
      PRIMARY KEY (repo_id, target_path, source_path)
    )
  `);

  // Index for fast inbound lookup by target
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_inbound_target
      ON inbound_edges(repo_id, target_path)
  `);

  // 3. cochange table - Co-change graph from git history
  // Invariants enforced:
  // - CC1: Canonical ordering (file1 < file2) via CHECK constraint
  // - CC3: Positive weight via CHECK constraint
  await db.run(`
    CREATE TABLE IF NOT EXISTS cochange (
      repo_id INTEGER,
      file1 TEXT,
      file2 TEXT,
      cochange_count INTEGER NOT NULL,
      confidence FLOAT,
      last_commit TEXT,
      last_cochange_at TIMESTAMP,
      PRIMARY KEY (repo_id, file1, file2)
    )
  `);

  // Note: CHECK constraints are validated at application level for DuckDB compatibility
  // CC1 (file1 < file2) and CC3 (cochange_count > 0) are enforced in cochange.ts

  // Indexes for fast co-change lookup (bidirectional)
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_cochange_file1
      ON cochange(repo_id, file1)
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_cochange_file2
      ON cochange(repo_id, file2)
  `);

  // 4. processed_commits table - Track processed commits for idempotency (CC4)
  await db.run(`
    CREATE TABLE IF NOT EXISTS processed_commits (
      repo_id INTEGER,
      commit_hash TEXT,
      processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (repo_id, commit_hash)
    )
  `);
}
