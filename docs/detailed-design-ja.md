---
doc_id: "ARCH-008"
title: "詳細設計書"
category: "architecture"
tags:
  - design
  - dcca
  - domain-model
  - architecture
service: "kiri"
---

# 詳細設計書: KIRI - LLM向けコンテキスト抽出プラットフォーム

> DCCA（Domain-Centric Contextual Analysis）による詳細設計

---

## 1. 概要

### 1.1 目的

本設計書は、KIRI（LLM向けコンテキスト抽出プラットフォーム）の詳細設計を記述する。KIRIはGitリポジトリをDuckDBにインデックス化し、MCP（Model Context Protocol）ツールを通じてセマンティックコード検索を提供する。

### 1.2 スコープ

| 対象           | 内容                                                 |
| -------------- | ---------------------------------------------------- |
| インデクサー   | Gitワークツリーの走査、AST解析、DuckDBへの永続化     |
| MCPサーバー    | JSON-RPC 2.0サーバー、検索ツール、ランキングエンジン |
| 共有モジュール | DuckDBクライアント、ユーティリティ                   |
| クライアント   | デーモン、プロキシ                                   |

### 1.3 用語定義（ユビキタス言語）

| 用語                        | 定義                                                         |
| --------------------------- | ------------------------------------------------------------ |
| **Repository (リポジトリ)** | インデックス対象のGitリポジトリ。正規化パスで一意に識別      |
| **Blob (ブロブ)**           | コンテンツアドレス可能なファイル内容。SHA256ハッシュで一意化 |
| **File (ファイル)**         | HEADコミット時点のファイル状態。高速検索用                   |
| **Symbol (シンボル)**       | AST抽出されたコード要素（関数、クラス、メソッド等）          |
| **Snippet (スニペット)**    | シンボル境界に沿って抽出された行範囲のコード断片             |
| **Dependency (依存関係)**   | import/require等の依存関係                                   |
| **ServerContext**           | リクエスト処理のランタイムコンテキスト                       |
| **BoostProfile**            | ファイルタイプ別のスコアリング修正子                         |
| **DegradeMode**             | FTS/VSS拡張なしで動作するフォールバックモード                |
| **MCP Tool**                | Model Context Protocolで公開される検索ツール                 |

---

## 2. 意味グラフ

### 2.1 概念モデル図

```
                                 ┌─────────────────────────────────────┐
                                 │         KIRI Platform               │
                                 └─────────────────────────────────────┘
                                              │
                    ┌─────────────────────────┼─────────────────────────┐
                    │                         │                         │
             ┌──────▼──────┐          ┌───────▼───────┐         ┌───────▼───────┐
             │   Indexer   │          │  MCP Server   │         │    Client     │
             │   Context   │          │    Context    │         │    Context    │
             └──────┬──────┘          └───────┬───────┘         └───────┬───────┘
                    │                         │                         │
        ┌───────────┼───────────┐    ┌────────┼────────┐       ┌────────┼────────┐
        │           │           │    │        │        │       │        │        │
   ┌────▼────┐ ┌────▼────┐ ┌────▼────┐   ┌────▼────┐ ┌────▼────┐   ┌────▼────┐ ┌────▼────┐
   │   Git   │ │CodeIntel│ │ Schema  │   │Handlers │ │Scoring  │   │ Daemon  │ │  Proxy  │
   │ Scanner │ │ Parser  │ │ Manager │   │  (RPC)  │ │ Engine  │   │         │ │         │
   └────┬────┘ └────┬────┘ └────┬────┘   └────┬────┘ └────┬────┘   └────┬────┘ └────┬────┘
        │           │           │             │           │             │           │
        └───────────┴───────────┴─────────────┴───────────┴─────────────┴───────────┘
                                              │
                                    ┌─────────▼─────────┐
                                    │   Shared Context  │
                                    │  (DuckDB, Utils)  │
                                    └───────────────────┘
```

### 2.2 エンティティ定義

#### 2.2.1 Repository (集約ルート)

```typescript
interface Repository {
  id: number; // PRIMARY KEY, AUTO_INCREMENT
  root: string; // ファイルシステムパス
  normalized_root: string; // 正規化パス（UNIQUE）
  default_branch: string | null; // デフォルトブランチ
  indexed_at: Date | null; // 最終インデックス日時
  fts_dirty: boolean; // FTS再構築フラグ
  fts_status: "dirty" | "rebuilding" | "ready";
  fts_generation: number; // FTS世代番号
}

// 不変条件
// - normalized_root はシステム全体で一意
// - fts_dirty が true の場合、fts_status は 'dirty' または 'rebuilding'
// - 子エンティティ（File, Symbol等）は有効な repo_id を参照
```

#### 2.2.2 Blob (値オブジェクト)

```typescript
interface Blob {
  hash: string; // PRIMARY KEY, SHA256
  size_bytes: number;
  line_count: number;
  content: string | null; // バイナリの場合はnull
}

// 不変条件
// - hash は content の SHA256 ハッシュと一致
// - バイナリファイルの場合、content は null
```

#### 2.2.3 File (エンティティ)

```typescript
interface File {
  repo_id: number; // FK -> Repository
  path: string; // リポジトリルートからの相対パス
  blob_hash: string; // FK -> Blob
  ext: string; // 拡張子
  lang: string | null; // 検出された言語
  is_binary: boolean;
  mtime: Date;
}

// 不変条件
// - path はリポジトリ内で一意
// - blob_hash は存在する Blob を参照
```

#### 2.2.4 Symbol (エンティティ)

```typescript
interface Symbol {
  repo_id: number;
  path: string;
  symbol_id: number; // ファイル内連番
  name: string;
  kind: SymbolKind; // function | class | method | interface | enum | ...
  range_start_line: number; // 1-based
  range_end_line: number; // 1-based
  signature: string | null; // 最大200文字
  doc: string | null; // ドキュメントコメント
}

// 不変条件
// - range_start_line <= range_end_line
// - 範囲は対応する Blob の line_count 以内
// - signature の長さは 200 文字以下
```

#### 2.2.5 Snippet (エンティティ)

```typescript
interface Snippet {
  repo_id: number;
  path: string;
  snippet_id: number; // ファイル内連番
  start_line: number; // 1-based
  end_line: number; // 1-based
  symbol_id: number | null; // 関連するシンボル（オプション）
}

// 不変条件
// - start_line <= end_line
// - 同一ファイル内のスニペットは重複しない
// - symbol_id が設定される場合、対応する Symbol が存在
```

### 2.3 関係性定義

| 関係              | カーディナリティ | 説明                                             |
| ----------------- | ---------------- | ------------------------------------------------ |
| Repository → File | 1:N              | リポジトリはN個のファイルを含む                  |
| File → Blob       | N:1              | 複数ファイルが同一内容を共有可能（リネーム対応） |
| File → Symbol     | 1:N              | ファイルはN個のシンボルを定義                    |
| File → Snippet    | 1:N              | ファイルはN個のスニペットに分割                  |
| Symbol → Snippet  | 1:0..1           | シンボルは0または1つのスニペットに対応           |
| File → Dependency | 1:N              | ファイルはN個の依存関係を持つ                    |

### 2.4 コンテキスト境界

#### Indexerコンテキスト

**責務**: Gitワークツリーの走査、コード解析、DuckDBへの永続化

**主要コンポーネント**:

- `cli.ts`: インデクサーエントリポイント
- `git.ts`: Gitコマンド実行
- `codeintel.ts`: 言語解析ファサード
- `schema.ts`: スキーマ管理・マイグレーション
- `graph-metrics.ts`: 依存グラフメトリクス計算
- `cochange.ts`: 共変更分析

**公開インターフェース**:

```typescript
// インデクサー実行
async function runIndexer(options: IndexerOptions): Promise<void>;

// スキーマ確保
async function ensureBaseSchema(db: DuckDBClient): Promise<void>;
```

#### Serverコンテキスト

**責務**: MCP JSON-RPCサーバー、検索処理、ランキング

**主要コンポーネント**:

- `main.ts`: サーバーエントリポイント
- `rpc.ts`: JSON-RPCハンドラー
- `handlers.ts`: MCPツール実装
- `scoring.ts`: スコアリングエンジン
- `boost-profiles.ts`: ブーストプロファイル

**公開インターフェース**:

```typescript
// MCPツール
async function contextBundle(
  ctx: ServerContext,
  params: ContextBundleParams
): Promise<ContextBundleResult>;
async function filesSearch(
  ctx: ServerContext,
  params: FilesSearchParams
): Promise<FilesSearchResult>;
async function snippetsGet(
  ctx: ServerContext,
  params: SnippetsGetParams
): Promise<SnippetsGetResult>;
async function depsClosure(
  ctx: ServerContext,
  params: DepsClosureParams
): Promise<DepsClosureResult>;
async function semanticRerank(
  ctx: ServerContext,
  params: SemanticRerankParams
): Promise<SemanticRerankResult>;
```

#### CodeIntelコンテキスト

**責務**: 言語固有のAST解析、シンボル抽出

**サポート言語**:
| 言語 | パーサー |
|------|----------|
| TypeScript/TSX | TypeScript Compiler API |
| Swift | tree-sitter-swift |
| PHP | tree-sitter-php |
| Java | tree-sitter-java |
| Rust | tree-sitter-rust |
| Dart | Dart Analysis Server |

**公開インターフェース**:

```typescript
interface LanguageAnalyzer {
  readonly language: string;
  analyze(context: AnalysisContext): Promise<AnalysisResult>;
  dispose?(): Promise<void>;
}
```

---

## 3. 機能設計

### 3.1 ユースケース

#### UC-01: リポジトリのインデックス化

**アクター**: 開発者（CLI経由）
**前提条件**: Gitリポジトリが存在
**基本フロー**:

1. ユーザーが `kiri index --repo <path>` を実行
2. インデクサーがGitワークツリーを走査
3. 各ファイルを言語検出・AST解析
4. シンボル・スニペット・依存関係を抽出
5. DuckDBに永続化
6. FTSインデックスを再構築（利用可能な場合）

**代替フロー**:

- 2a. インクリメンタルモード: 変更ファイルのみ再インデックス
- 6a. FTS拡張なし: スキップしてデグレードモードで動作

#### UC-02: コンテキストバンドル取得

**アクター**: LLMエージェント（MCP経由）
**前提条件**: リポジトリがインデックス済み
**基本フロー**:

1. クライアントが `context_bundle` ツールを呼び出し
2. サーバーがgoalパラメータをトークン化
3. キーワード検索・パスマッチングを実行
4. スコアリングウェイトを適用
5. ブーストプロファイルでファイルタイプ調整
6. ランク付けされたスニペットリストを返却

### 3.2 シーケンス図

#### context_bundle 処理フロー

```
┌────────┐     ┌────────┐     ┌─────────┐     ┌─────────┐     ┌────────┐
│ Client │     │  RPC   │     │ Handler │     │ Scoring │     │ DuckDB │
└───┬────┘     └───┬────┘     └────┬────┘     └────┬────┘     └───┬────┘
    │              │               │               │               │
    │ context_bundle(goal, params) │               │               │
    │─────────────>│               │               │               │
    │              │ parse request │               │               │
    │              │───────────────│               │               │
    │              │               │               │               │
    │              │ check degrade │               │               │
    │              │<──────────────│               │               │
    │              │               │               │               │
    │              │ contextBundleImpl()           │               │
    │              │───────────────>│               │               │
    │              │               │ tokenize goal │               │
    │              │               │───────────────│               │
    │              │               │               │               │
    │              │               │ FTS/ILIKE query               │
    │              │               │───────────────────────────────>│
    │              │               │               │ candidates    │
    │              │               │<───────────────────────────────│
    │              │               │               │               │
    │              │               │ loadScoringProfile()          │
    │              │               │──────────────>│               │
    │              │               │               │               │
    │              │               │ calculateScores()             │
    │              │               │──────────────>│               │
    │              │               │    scores     │               │
    │              │               │<──────────────│               │
    │              │               │               │               │
    │              │               │ applyBoostProfile()           │
    │              │               │───────────────│               │
    │              │               │               │               │
    │              │ ranked results│               │               │
    │              │<──────────────│               │               │
    │ response     │               │               │               │
    │<─────────────│               │               │               │
    │              │               │               │               │
```

### 3.3 状態遷移図

#### FTSステータス状態遷移

```
                    ┌─────────┐
                    │  dirty  │◄────────────────┐
                    └────┬────┘                 │
                         │                      │
                    indexer run                 │
                         │                 file changed
                         ▼                      │
                ┌────────────────┐              │
                │  rebuilding    │──────────────┤
                └────────┬───────┘              │
                         │                      │
                    FTS rebuild                 │
                    success                     │
                         │                      │
                         ▼                      │
                    ┌─────────┐                 │
                    │  ready  │─────────────────┘
                    └─────────┘
```

#### デグレードモード状態遷移

```
                    ┌──────────┐
           ┌───────│  Normal  │◄─────────┐
           │       └────┬─────┘          │
           │            │                │
     FTS/VSS            │           extension
     available          │           restored
           │       extension             │
           │       unavailable           │
           │            │                │
           │            ▼                │
           │       ┌──────────┐          │
           └──────>│ Degraded │──────────┘
                   └──────────┘
```

---

## 4. データ設計

### 4.1 エンティティスキーマ

```sql
-- リポジトリ（集約ルート）
CREATE TABLE repo (
  id INTEGER PRIMARY KEY DEFAULT nextval('repo_id_seq'),
  root TEXT NOT NULL UNIQUE,
  normalized_root TEXT UNIQUE,
  default_branch TEXT,
  indexed_at TIMESTAMP,
  fts_last_indexed_at TIMESTAMP,
  fts_dirty BOOLEAN DEFAULT false,
  fts_status TEXT DEFAULT 'dirty',
  fts_generation INTEGER DEFAULT 0
);

-- ブロブ（コンテンツアドレス可能）
CREATE TABLE blob (
  hash TEXT PRIMARY KEY,
  size_bytes INTEGER,
  line_count INTEGER,
  content TEXT
);

-- ツリー（コミット履歴）
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

-- ファイル（HEAD状態）
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

-- シンボル（AST抽出）
CREATE TABLE symbol (
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
);

-- スニペット（コード断片）
CREATE TABLE snippet (
  repo_id INTEGER,
  path TEXT,
  snippet_id BIGINT,
  start_line INTEGER,
  end_line INTEGER,
  symbol_id BIGINT NULL,
  PRIMARY KEY (repo_id, path, snippet_id)
);

-- 依存関係
CREATE TABLE dependency (
  repo_id INTEGER,
  src_path TEXT,
  dst_kind TEXT,
  dst TEXT,
  rel TEXT,
  PRIMARY KEY (repo_id, src_path, dst_kind, dst, rel)
);

-- ドキュメントメタデータ
CREATE TABLE document_metadata (
  repo_id INTEGER,
  path TEXT,
  source TEXT,
  data JSON,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (repo_id, path, source)
);

-- メタデータKV展開
CREATE TABLE document_metadata_kv (
  repo_id INTEGER,
  path TEXT,
  source TEXT,
  key TEXT,
  value TEXT,
  PRIMARY KEY (repo_id, path, source, key, value)
);

-- グラフメトリクス
CREATE TABLE graph_metrics (
  repo_id INTEGER,
  path TEXT,
  inbound_count INTEGER DEFAULT 0,
  outbound_count INTEGER DEFAULT 0,
  importance_score FLOAT DEFAULT 0.0,
  computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (repo_id, path)
);
```

### 4.2 データフロー

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Git Worktree │────>│   Indexer    │────>│    DuckDB    │
└──────────────┘     └──────────────┘     └──────────────┘
                            │                     │
                            │                     │
                     ┌──────▼──────┐              │
                     │  CodeIntel  │              │
                     │   Parser    │              │
                     └──────┬──────┘              │
                            │                     │
         ┌──────────────────┼──────────────────┐  │
         │                  │                  │  │
    ┌────▼────┐       ┌─────▼─────┐      ┌─────▼─────┐
    │ Symbols │       │ Snippets  │      │ Deps      │
    └────┬────┘       └─────┬─────┘      └─────┬─────┘
         │                  │                  │
         └──────────────────┼──────────────────┘
                            │
                            ▼
                     ┌──────────────┐
                     │   DuckDB     │◄──────┐
                     │   Tables     │       │
                     └──────┬───────┘       │
                            │               │
                            │          ┌────┴────┐
                            │          │  MCP    │
                            │          │ Server  │
                            ▼          └────┬────┘
                     ┌──────────────┐       │
                     │  FTS Index   │       │
                     │  (optional)  │◄──────┘
                     └──────────────┘
```

### 4.3 永続化戦略

| 戦略                     | 説明                                             |
| ------------------------ | ------------------------------------------------ |
| **Blob/Tree分離**        | コンテンツハッシュで一意化し、リネームに強い設計 |
| **WALチェックポイント**  | 接続クローズ時にCHECKPOINT実行                   |
| **自動マイグレーション** | 起動時にスキーマ差分を自動適用                   |
| **インクリメンタル更新** | 変更ファイルのみ再インデックス                   |
| **FTS遅延構築**          | インデックス完了後にFTSインデックス再構築        |

---

## 5. インターフェース設計

### 5.1 API定義

#### context_bundle

**目的**: 検索ゴールに最も関連するコードスニペットを取得

```typescript
interface ContextBundleParams {
  goal: string; // 検索ゴール（キーワードリッチ）
  limit?: number; // 最大結果数（デフォルト: 7）
  compact?: boolean; // プレビュー省略（デフォルト: true）
  boost_profile?: BoostProfileName; // ファイルタイプブースト
  profile?: ScoringProfileName; // スコアリングプロファイル
  category?: AdaptiveKCategory; // Adaptive K カテゴリ
  path_prefix?: string; // パスフィルタ
  metadata_filters?: MetadataFilters; // メタデータフィルタ
  artifacts?: {
    editing_path?: string; // 編集中ファイル
    failing_tests?: string[]; // 失敗テスト
    last_diff?: string; // 直近のdiff
  };
}

interface ContextBundleResult {
  context: ContextEntry[];
  tokens_estimate?: number;
  warnings?: string[];
}

interface ContextEntry {
  path: string;
  range: [number, number];
  why: string[];
  score: number;
  preview?: string;
}
```

#### files_search

**目的**: キーワード・パターンでファイルを検索

```typescript
interface FilesSearchParams {
  query?: string; // 検索クエリ
  limit?: number; // 最大結果数（デフォルト: 50）
  compact?: boolean; // プレビュー省略
  boost_profile?: BoostProfileName;
  path_prefix?: string;
  ext?: string; // 拡張子フィルタ
  lang?: string; // 言語フィルタ
  metadata_filters?: MetadataFilters;
}

interface FilesSearchResult {
  files: FileSearchEntry[];
}

interface FileSearchEntry {
  path: string;
  matchLine?: number;
  lang: string | null;
  ext: string;
  score: number;
  preview?: string;
}
```

#### snippets_get

**目的**: 特定ファイルのスニペットを取得

```typescript
interface SnippetsGetParams {
  path: string; // ファイルパス
  start_line?: number; // 開始行
  end_line?: number; // 終了行
  compact?: boolean; // コンテンツ省略
  includeLineNumbers?: boolean; // 行番号プレフィックス
  view?: "auto" | "symbol" | "lines" | "full";
}

interface SnippetsGetResult {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  symbolName?: string;
  symbolKind?: string;
  content?: string;
  truncated?: boolean;
}
```

#### deps_closure

**目的**: 依存関係グラフを走査

```typescript
interface DepsClosureParams {
  path: string; // 起点ファイル
  direction: "outbound" | "inbound";
  max_depth?: number; // 最大深度
  include_packages?: boolean;
}

interface DepsClosureResult {
  root: string;
  direction: string;
  nodes: DepNode[];
  edges: DepEdge[];
}
```

### 5.2 イベント定義

| イベント                | トリガー             | ペイロード                          |
| ----------------------- | -------------------- | ----------------------------------- |
| `indexer.started`       | インデクサー開始     | `{ repoRoot, mode }`                |
| `indexer.completed`     | インデクサー完了     | `{ repoRoot, duration, fileCount }` |
| `fts.rebuild.started`   | FTS再構築開始        | `{ repoId }`                        |
| `fts.rebuild.completed` | FTS再構築完了        | `{ repoId, success }`               |
| `degrade.entered`       | デグレードモード開始 | `{ reason }`                        |
| `degrade.exited`        | デグレードモード終了 | `{}`                                |

### 5.3 外部連携

| 連携先                  | プロトコル                | 用途                 |
| ----------------------- | ------------------------- | -------------------- |
| MCP Client              | JSON-RPC 2.0 (HTTP/stdio) | ツール呼び出し       |
| Git                     | CLI (exec)                | リポジトリ情報取得   |
| DuckDB                  | @duckdb/node-api          | データ永続化・クエリ |
| tree-sitter             | WASM/Native               | AST解析              |
| TypeScript Compiler API | Node.js                   | TS/TSX解析           |
| Dart Analysis Server    | stdio                     | Dart解析             |

---

## 6. 制約と不変条件

### 6.1 ビジネスルール

| ルール | 説明                                                 |
| ------ | ---------------------------------------------------- |
| BR-01  | normalized_root はシステム全体で一意                 |
| BR-02  | シンボル範囲はファイル行数以内                       |
| BR-03  | スニペットは同一ファイル内で重複しない               |
| BR-04  | FTS拡張なしでも基本機能は動作（デグレードモード）    |
| BR-05  | バイナリファイルはインデックスするが内容は保存しない |
| BR-06  | 機密パターン（.env*, *.pem）はフィルタリング         |

### 6.2 バリデーションルール

```typescript
// パスバリデーション
const PATH_PATTERN = /^(?!.*\.\.)[A-Za-z0-9_./\-]+$/;

// シグネチャ長制限
const MAX_SIGNATURE_LENGTH = 200;

// スコアリングウェイト検証
function validateWeights(weights: ScoringWeights): void {
  // 全ウェイトは非負の有限数
  for (const [key, value] of Object.entries(weights)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid weight: ${key}`);
    }
  }
  // ペナルティ乗数は 1.0 以下
  if (weights.docPenaltyMultiplier > 1) throw new Error("Invalid penalty");
  // ブースト乗数は 1.0 以上
  if (weights.implBoostMultiplier < 1) throw new Error("Invalid boost");
}
```

### 6.3 整合性制約

| 制約        | 対象                                      | 説明             |
| ----------- | ----------------------------------------- | ---------------- |
| UNIQUE      | repo.normalized_root                      | 正規化パス一意   |
| PRIMARY KEY | (repo_id, path)                           | ファイル一意識別 |
| PRIMARY KEY | (repo_id, path, symbol_id)                | シンボル一意識別 |
| FK (論理)   | file.blob_hash → blob.hash                | ブロブ参照整合性 |
| CHECK       | symbol.range_start_line <= range_end_line | 範囲妥当性       |

---

## 7. 非機能要件対応

### 7.1 パフォーマンス考慮

| 指標      | 目標    | 対策                                   |
| --------- | ------- | -------------------------------------- |
| P@10      | >= 0.7  | 複合スコアリング、ブーストプロファイル |
| TTFU      | <= 1.0s | FTSインデックス、IDF キャッシュ        |
| Token削減 | >= 40%  | compact モード、スニペット分割         |

**最適化戦略**:

- IDFプロバイダーのメモリキャッシュ
- スコアリングプロファイルの起動時ロード
- WALチェックポイントによる書き込み効率化
- インクリメンタルインデックス

### 7.2 セキュリティ考慮

| リスク              | 対策                                        |
| ------------------- | ------------------------------------------- |
| 機密ファイル露出    | .env*, *.pem, secrets/\*\* パターンフィルタ |
| パス情報漏洩        | `maskValue()` によるレスポンスマスキング    |
| SQLインジェクション | パラメータ化クエリ                          |
| パストラバーサル    | `..` パターン拒否                           |

### 7.3 拡張性考慮

| 拡張ポイント             | 設計                                     |
| ------------------------ | ---------------------------------------- |
| 言語サポート追加         | `LanguageAnalyzer` インターフェース実装  |
| スコアリングカスタマイズ | YAML設定 (`config/scoring-profiles.yml`) |
| ブーストプロファイル追加 | `BOOST_PROFILES` 定数拡張                |
| メトリクス追加           | `MetricsRegistry` 登録                   |

---

## 8. 実装ガイドライン

### 8.1 推奨パターン

#### DuckDBクライアント使用

```typescript
// 推奨: DuckDBClient ラッパー使用
const db = await DuckDBClient.connect({
  databasePath: "var/index.duckdb",
  ensureDirectory: true,
});
try {
  await db.transaction(async () => {
    await db.run("INSERT INTO ...", [params]);
  });
} finally {
  await db.close();
}
```

#### エラーメッセージ形式

```typescript
// 形式: "問題の説明。解決アクション。"
throw new Error(
  "Target repository is missing from DuckDB. Run the indexer before starting the server."
);
```

#### 言語アナライザー実装

```typescript
class MyLanguageAnalyzer implements LanguageAnalyzer {
  readonly language = "MyLang";

  async analyze(context: AnalysisContext): Promise<AnalysisResult> {
    try {
      // 解析処理
      return { symbols, snippets, dependencies };
    } catch {
      // エラー時は空の結果を返す（例外をスローしない）
      return emptyResult();
    }
  }
}
```

### 8.2 アンチパターン（避けるべき実装）

| アンチパターン     | 問題               | 推奨              |
| ------------------ | ------------------ | ----------------- |
| 直接DuckDB接続     | リソースリーク     | DuckDBClient使用  |
| グローバル状態     | テスト困難         | ServerContext注入 |
| 例外スロー（解析） | 部分失敗           | 空結果返却        |
| ハードコード設定   | 柔軟性欠如         | YAML設定ファイル  |
| 同期I/O            | パフォーマンス劣化 | async/await使用   |

### 8.3 テスト戦略

| テストレベル | 対象             | ツール                  |
| ------------ | ---------------- | ----------------------- |
| ユニット     | 個別関数・クラス | Vitest                  |
| 統合         | モジュール間連携 | Vitest + 実DuckDB       |
| 評価         | 検索精度         | Golden Set (P@10, TFFU) |

**テストファイル命名規則**:

```
tests/<module>/<file>.spec.ts
例: tests/server/handlers.spec.ts
```

**カバレッジ基準**:

- ステートメント: >= 80%
- 行: >= 80%
- ミューテーションスコア: >= 60%

---

## 付録

### A. ディレクトリ構造

```
kiri/
├── src/
│   ├── indexer/           # インデクサーモジュール
│   │   ├── cli.ts         # エントリポイント
│   │   ├── schema.ts      # スキーマ管理
│   │   ├── git.ts         # Git操作
│   │   ├── codeintel.ts   # 言語解析ファサード
│   │   ├── codeintel/     # 言語別アナライザー
│   │   │   ├── types.ts   # 共通型定義
│   │   │   ├── typescript/
│   │   │   ├── swift/
│   │   │   ├── php/
│   │   │   ├── java/
│   │   │   ├── rust/
│   │   │   └── dart/
│   │   ├── graph-metrics.ts
│   │   └── cochange.ts
│   ├── server/            # MCPサーバーモジュール
│   │   ├── main.ts        # エントリポイント
│   │   ├── rpc.ts         # JSON-RPCハンドラー
│   │   ├── handlers.ts    # MCPツール実装
│   │   ├── context.ts     # ServerContext
│   │   ├── scoring.ts     # スコアリングエンジン
│   │   ├── boost-profiles.ts
│   │   ├── services/      # サービス層
│   │   └── fallbacks/     # デグレード制御
│   ├── shared/            # 共有モジュール
│   │   ├── duckdb.ts      # DuckDBクライアント
│   │   ├── tokenizer.ts
│   │   ├── embedding.ts
│   │   └── utils/
│   ├── client/            # クライアントモジュール
│   │   └── proxy.ts
│   └── daemon/            # デーモンモジュール
│       └── daemon.ts
├── tests/                 # テストファイル
├── docs/                  # ドキュメント
├── config/                # 設定ファイル
└── sql/                   # SQLスキーマ
```

### B. 設定ファイル

#### scoring-profiles.yml

```yaml
default:
  textMatch: 1.0
  pathMatch: 1.5
  editingPath: 2.0
  dependency: 0.5
  proximity: 0.25
  structural: 0.75
  docPenaltyMultiplier: 0.5
  configPenaltyMultiplier: 0.05
  implBoostMultiplier: 1.3
  graphInbound: 0.5
  graphImportance: 0.3
  graphDecay: 0.5
  graphMaxDepth: 3
  cochange: 0.0

bugfix:
  # バグ修正向け: 依存関係とグラフを重視
  dependency: 0.7
  graphInbound: 0.6
  graphImportance: 0.4

testfail:
  # テスト失敗向け: テストファイルペナルティ緩和
  testPenaltyMultiplier: 0.2
```

### C. 関連ドキュメント

| ドキュメント   | 場所                   | 内容               |
| -------------- | ---------------------- | ------------------ |
| 概要           | docs/overview.md       | システム概要、用語 |
| データモデル   | docs/data-model.md     | DuckDBスキーマ詳細 |
| 検索ランキング | docs/search-ranking.md | スコアリング詳細   |
| Runbook        | docs/runbook.md        | 運用手順           |
| CLAUDE.md      | CLAUDE.md              | 開発ガイドライン   |

---

**更新履歴**

| バージョン | 日付       | 変更内容             |
| ---------- | ---------- | -------------------- |
| 1.0.0      | 2025-12-01 | 初版作成（DCCA適用） |
