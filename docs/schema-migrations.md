---
doc_id: "ARCH-006"
title: "DuckDB Schema Migrations"
category: "architecture"
tags:
  - schema
  - migration
  - duckdb
service: "kiri"
---

# DuckDB Schema Migrations

> KIRIは自動スキーママイグレーションを使用します。既存のデータベースに対して新しいテーブルやカラムが自動的に追加されます。

## Overview

KIRIのスキーママイグレーションは以下の特徴を持ちます:

1. **自動実行**: `kiri index` コマンド実行時に自動的にマイグレーションが適用
2. **冪等性**: 何度実行しても同じ結果（既存テーブルは再作成されない）
3. **トランザクション保護**: 失敗時は自動的にロールバック
4. **後方互換性**: 既存データは保持される

## document_metadata Tables (v0.14+)

### テーブル構造

#### document_metadata

ドキュメントのメタデータ（Front Matter、YAML、JSON）を格納:

```sql
CREATE TABLE document_metadata (
  repo_id INTEGER,
  path TEXT,
  source TEXT,              -- 'front_matter' | 'yaml' | 'json' | 'docmeta'
  data JSON,                -- 元の構造化データ
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (repo_id, path, source)
);
```

#### document_metadata_kv

検索用にフラット化されたキー/バリューペア:

```sql
CREATE TABLE document_metadata_kv (
  repo_id INTEGER,
  path TEXT,
  source TEXT,
  key TEXT,
  value TEXT,
  PRIMARY KEY (repo_id, path, source, key, value)
);

CREATE INDEX idx_document_metadata_key
  ON document_metadata_kv(repo_id, key);
```

#### markdown_link

Markdownリンクグラフ:

```sql
CREATE TABLE markdown_link (
  repo_id INTEGER,
  src_path TEXT,
  target TEXT,
  resolved_path TEXT,
  anchor_text TEXT,
  kind TEXT,                -- 'relative' | 'absolute' | 'external' | 'anchor'
  PRIMARY KEY (repo_id, src_path, target, anchor_text)
);

CREATE INDEX idx_markdown_link_target
  ON markdown_link(repo_id, resolved_path);
```

## Migration Procedure

### 自動マイグレーション

通常の使用では、以下のコマンドで自動的にマイグレーションが実行されます:

```bash
# フルインデックス（推奨）
kiri index --repo . --db var/index.duckdb --full

# 増分インデックス
kiri index --repo . --db var/index.duckdb --since <commit>
```

### 手動確認

マイグレーション後、以下のSQLでテーブルの存在を確認できます:

```sql
-- テーブル存在確認
SELECT table_name FROM duckdb_tables()
WHERE table_name IN ('document_metadata', 'document_metadata_kv', 'markdown_link');

-- インデックス存在確認
SELECT index_name FROM duckdb_indexes()
WHERE index_name IN ('idx_document_metadata_key', 'idx_markdown_link_target');

-- データ確認
SELECT COUNT(*) FROM document_metadata;
SELECT COUNT(*) FROM document_metadata_kv;
SELECT COUNT(*) FROM markdown_link;
```

## Rollback Procedure

マイグレーションに問題が発生した場合の手順:

### 1. バックアップからのリストア（推奨）

```bash
# 事前にバックアップを取得
cp var/index.duckdb var/index.duckdb.backup

# 問題発生時にリストア
cp var/index.duckdb.backup var/index.duckdb
```

### 2. 手動ロールバック

バックアップがない場合、以下のSQLでテーブルを削除できます:

```sql
-- 注意: データが失われます
DROP TABLE IF EXISTS document_metadata_kv;
DROP TABLE IF EXISTS document_metadata;
DROP TABLE IF EXISTS markdown_link;

-- インデックスは自動的に削除されます
```

削除後、`kiri index --full` を再実行してテーブルを再作成します。

## Verification Steps

マイグレーション後の検証チェックリスト:

1. **テーブル存在確認**

   ```sql
   SELECT COUNT(*) FROM duckdb_tables()
   WHERE table_name = 'document_metadata';
   -- 結果: 1
   ```

2. **インデックス存在確認**

   ```sql
   SELECT COUNT(*) FROM duckdb_indexes()
   WHERE index_name = 'idx_document_metadata_key';
   -- 結果: 1
   ```

3. **データ整合性確認**

   ```sql
   -- Front Matterを持つファイルの確認
   SELECT path, source FROM document_metadata
   WHERE source = 'front_matter' LIMIT 5;

   -- メタデータキーの分布確認
   SELECT key, COUNT(*) as cnt FROM document_metadata_kv
   GROUP BY key ORDER BY cnt DESC LIMIT 10;

   -- リンクグラフの確認
   SELECT kind, COUNT(*) as cnt FROM markdown_link
   GROUP BY kind;
   ```

4. **検索動作確認**
   ```bash
   # metadata_filtersを使用した検索テスト
   # MCP経由で以下のようなクエリを実行
   # files_search({ query: "", metadata_filters: { tags: ["example"] } })
   ```

## Compatibility Notes

- **v0.13以前からのアップグレード**: テーブルが自動的に追加されます。既存のファイルインデックスは保持されます。
- **マイグレーション中のデータ**: マイグレーションはトランザクション内で実行されるため、失敗時は中間状態が残りません。
- **再インデックス推奨**: スキーマ変更後は `kiri index --full` での完全再インデックスを推奨します。これによりすべてのファイルのメタデータが抽出されます。

## Troubleshooting

### テーブルが作成されない

1. DuckDBのバージョンを確認（v0.9.0以上推奨）
2. データベースファイルの書き込み権限を確認
3. `--full` オプションでの再インデックスを試行

### インデックスエラー

```
Error: Index 'idx_document_metadata_key' already exists
```

これは通常発生しませんが、発生した場合:

```sql
DROP INDEX IF EXISTS idx_document_metadata_key;
```

その後、`kiri index --full` を再実行します。

### メタデータが抽出されない

1. ファイルがYAML/JSON/Markdownとして認識されているか確認
2. Front Matterの形式が正しいか確認（`---` で囲まれている）
3. ファイルサイズが制限（2MB）を超えていないか確認
