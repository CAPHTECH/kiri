# データモデル（DuckDB スキーマ）

> ポイント: **blob/tree 分離**でリネームに強く重複本文を排除。VSS/FTS はオプションで、Degrade 運転時は無効でも成立する設計とする。

```sql
-- レポ
CREATE TABLE repo (
  id INTEGER PRIMARY KEY,
  root TEXT NOT NULL,
  default_branch TEXT,
  indexed_at TIMESTAMP
);

-- コミット
CREATE TABLE commit (
  repo_id INTEGER,
  hash TEXT,
  author_name TEXT, author_email TEXT, authored_at TIMESTAMP,
  committer_name TEXT, committer_email TEXT, committed_at TIMESTAMP,
  message TEXT,
  PRIMARY KEY (repo_id, hash)
);

-- blob: 内容を内容ハッシュで一意化
CREATE TABLE blob (
  hash TEXT PRIMARY KEY,     -- e.g. sha1/sha256
  size_bytes INTEGER,
  line_count INTEGER,
  content TEXT               -- 機密対策: 後述のフィルタで格納可否やマスキング
);

-- tree: ある commit における path -> blob
CREATE TABLE tree (
  repo_id INTEGER,
  commit_hash TEXT,
  path TEXT,
  blob_hash TEXT,
  ext TEXT,
  lang TEXT,
  is_binary BOOLEAN,
  mtime TIMESTAMP,
  PRIMARY KEY (repo_id, commit_hash, path)
);

-- HEAD 時点の便宜表（高速検索用）
CREATE TABLE file (
  repo_id INTEGER,
  path TEXT,
  blob_hash TEXT,
  ext TEXT,
  lang TEXT,
  is_binary BOOLEAN,
  mtime TIMESTAMP,
  PRIMARY KEY (repo_id, path)
);

-- シンボル（tree-sitter 推奨）
CREATE TABLE symbol (
  repo_id INTEGER,
  path TEXT,
  symbol_id BIGINT,               -- 内部ID
  name TEXT,
  kind TEXT,                      -- function/class/method/var/type/...
  range_start_line INTEGER,
  range_end_line INTEGER,
  signature TEXT,
  doc TEXT,
  PRIMARY KEY (repo_id, path, symbol_id)
);

-- 依存（import/require/include などの解決結果）
CREATE TABLE dependency (
  repo_id INTEGER,
  src_path TEXT,
  dst_kind TEXT,                  -- "path" | "package" | "module"
  dst TEXT,                       -- 正規化された参照（具象パス or パッケージ名）
  rel TEXT,                       -- "import" | "require" | "include" | ...
  PRIMARY KEY (repo_id, src_path, dst_kind, dst, rel)
);

-- 変更履歴（ファイル単位）
CREATE TABLE file_change (
  repo_id INTEGER,
  path TEXT,
  commit_hash TEXT,
  added_lines INTEGER,
  deleted_lines INTEGER,
  PRIMARY KEY (repo_id, path, commit_hash)
);

-- blame（集約）
CREATE TABLE blame_summary (
  repo_id INTEGER,
  path TEXT,
  author_email TEXT,
  lines INTEGER,
  last_touched TIMESTAMP,
  PRIMARY KEY (repo_id, path, author_email)
);

-- 断片（snippet）: シンボル境界をベースにチャンク化
CREATE TABLE snippet (
  repo_id INTEGER,
  path TEXT,
  snippet_id BIGINT,
  start_line INTEGER,
  end_line INTEGER,
  symbol_id BIGINT NULL,          -- 紐付けできる場合のみ
  PRIMARY KEY (repo_id, path, snippet_id)
);

-- 埋め込み（オプション: vss 拡張）
CREATE TABLE snippet_embedding (
  repo_id INTEGER,
  path TEXT,
  snippet_id BIGINT,
  dim INTEGER,
  vec FLOAT[],
  PRIMARY KEY (repo_id, path, snippet_id)
);

-- 補助 Index
CREATE INDEX idx_file_lang ON file(repo_id, lang);
CREATE INDEX idx_symbol_name ON symbol(repo_id, name);
CREATE INDEX idx_dep_src ON dependency(repo_id, src_path);
CREATE INDEX idx_blame_last ON blame_summary(repo_id, path, last_touched);
```
