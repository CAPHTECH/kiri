# KIRI Golden Set Documentation

## Overview

このディレクトリには、KIRI検索精度を測定するための代表的クエリセット（Golden Set）が格納されています。

**目的:**

- P@10 (Precision at K=10) とTFFU (Time To First Useful) の定量評価
- 検索精度の改善追跡
- リグレッション検知

**関連ドキュメント:**

- [docs/overview.md](../../../docs/overview.md): P@10 ≥ 0.7, TTFU ≤ 1.0s の目標定義
- [docs/search-ranking.md](../../../docs/search-ranking.md): スコアリングアルゴリズム詳細

---

## ファイル構成

```
tests/eval/goldens/
├── README.md          # このファイル
├── queries.yaml       # ゴールデンクエリセット（20-30件）
└── baseline.json      # ベースライン測定値とthresholds
```

---

## YAML Schema

### ファイル構造

```yaml
schemaVersion: "1.0.0"
datasetVersion: "v2025-11-11"
description: "Representative queries for KIRI search accuracy evaluation"

# デフォルト実行パラメータ
defaultParams:
  k: 10 # Precision@K の K値
  tool: "context_bundle" # デフォルトMCPツール
  boostProfile: "default" # ファイルタイプブースト
  timeoutMs: 30000 # タイムアウト

# クエリリスト
queries:
  - id: bugfix-001
    query: "authentication error JWT validation"
    tool: "context_bundle" # Optional: override default
    intent: "bugfix" # 開発意図
    category: "bugfix" # カテゴリ (bugfix|feature|refactor|infra|docs)
    expected:
      paths: # 完全一致パス（rank 1-3を期待）
        - "src/auth/jwt.ts"
        - "src/middleware/auth.ts"
      patterns: # Optional: glob patterns for acceptable matches
        - "src/auth/**/*.ts"
    params: # Optional: query-specific parameters
      boostProfile: "balanced"
      k: 10
    tags: ["auth", "security"]
    notes: "Should prioritize implementation over tests"
```

### フィールド定義

#### トップレベル

| Field            | Type   | Required | Description                                       |
| ---------------- | ------ | -------- | ------------------------------------------------- |
| `schemaVersion`  | string | ✅       | スキーマバージョン (セマンティックバージョニング) |
| `datasetVersion` | string | ✅       | データセットバージョン (v{YYYY-MM-DD}形式推奨)    |
| `description`    | string | ✅       | データセットの説明                                |
| `defaultParams`  | object | ✅       | デフォルト実行パラメータ                          |
| `queries`        | array  | ✅       | クエリリスト (20-50件推奨)                        |

#### defaultParams

| Field          | Type   | Default          | Description                                           |
| -------------- | ------ | ---------------- | ----------------------------------------------------- |
| `k`            | number | 10               | Precision@K の K値                                    |
| `tool`         | string | "context_bundle" | MCP tool ("context_bundle" or "files_search")         |
| `boostProfile` | string | "default"        | Boost profile ("default", "docs", "balanced", "none") |
| `timeoutMs`    | number | 30000            | Query timeout in milliseconds                         |

#### queries[i]

| Field               | Type     | Required | Description                                   |
| ------------------- | -------- | -------- | --------------------------------------------- |
| `id`                | string   | ✅       | Unique ID (format: `{category}-{nnn}`)        |
| `query`             | string   | ✅       | Search query (5-100 chars recommended)        |
| `tool`              | string   | ❌       | Override default tool                         |
| `intent`            | string   | ✅       | 開発意図（自由記述）                          |
| `category`          | string   | ✅       | カテゴリ (bugfix/feature/refactor/infra/docs) |
| `expected.paths`    | string[] | ✅       | 期待される完全一致パス（rank 1-3）            |
| `expected.patterns` | string[] | ❌       | 許容されるglobパターン                        |
| `params`            | object   | ❌       | クエリ固有のパラメータ                        |
| `tags`              | string[] | ✅       | タグリスト                                    |
| `notes`             | string   | ❌       | 備考・補足説明                                |

---

## カテゴリ定義

### bugfix (5-10 queries)

**目的:** バグ修正時の調査フロー
**クエリ例:**

- エラーメッセージからの逆引き
- スタックトレースに含まれる関数名
- 既知の問題パターン

**期待動作:**

- 実装ファイルを優先（テストファイルより上位）
- エラーハンドリング箇所が上位にランク

### feature (5-10 queries)

**目的:** 新機能追加時の参照コード検索
**クエリ例:**

- 類似機能の実装パターン
- API設計の参照
- インテグレーションポイント

**期待動作:**

- 主要な実装ファイルが上位
- インターフェース定義が含まれる

### refactor (3-7 queries)

**目的:** リファクタリング対象の特定
**クエリ例:**

- 特定パターンの抽出
- 重複コードの検出
- アーキテクチャ理解

**期待動作:**

- 関連ファイルの網羅的取得
- 構造的類似性が反映される

### infra (3-7 queries)

**目的:** インフラ・設定関連の調査
**クエリ例:**

- ビルド設定
- デプロイメント構成
- 環境変数・シークレット管理

**期待動作:**

- config/ ディレクトリファイルが上位
- 関連スクリプトが含まれる

### docs (3-7 queries)

**目的:** ドキュメント検索
**クエリ例:**

- アーキテクチャ説明
- APIリファレンス
- セットアップガイド

**期待動作:**

- `boost_profile: "docs"` または `"balanced"` 使用推奨
- docs/ ディレクトリが優先される

---

## 期待結果の定義

### paths (完全一致)

検索結果の **rank 1-3 に含まれるべき**ファイルパスを指定します。

**基準:**

- P@10 計算の分子として使用
- 正確なファイルパスを記載（プロジェクトルートからの相対パス）
- 最低1件、最大5件程度を推奨

**例:**

```yaml
expected:
  paths:
    - "src/auth/jwt.ts" # Rank 1-3に期待
    - "src/middleware/auth.ts" # Rank 1-3に期待
```

### patterns (許容マッチ)

完全一致以外の **許容される結果範囲** をglobパターンで指定します（Optional）。

**用途:**

- リファクタリングによるパス変更への対応
- 関連ファイル群の検証
- カテゴリ全体の網羅性チェック

**例:**

```yaml
expected:
  patterns:
    - "src/auth/**/*.ts" # auth配下のTSファイルは許容
    - "src/middleware/**/*.ts" # middleware配下も許容
```

**注意:** `patterns` マッチは precision 計算に含まれますが、ログには区別して出力されます。

---

## タグ一覧

### 機能分類

| Tag        | Description      | Example Queries                     |
| ---------- | ---------------- | ----------------------------------- |
| `auth`     | 認証・認可       | JWT validation, session management  |
| `database` | データベース操作 | Connection pool, query optimization |
| `mcp`      | MCP tool機能     | context_bundle implementation       |
| `indexer`  | インデクサー     | Git scanning, AST extraction        |
| `search`   | 検索ロジック     | Ranking, BM25, semantic rerank      |

### 技術分類

| Tag           | Description          | Example Queries                    |
| ------------- | -------------------- | ---------------------------------- |
| `performance` | パフォーマンス最適化 | Caching, batching, parallelization |
| `security`    | セキュリティ         | Input validation, sanitization     |
| `testing`     | テスト関連           | Test fixtures, mocking             |
| `config`      | 設定管理             | YAML config, environment variables |
| `docs`        | ドキュメント         | README, architecture docs          |

---

## 新しいクエリの追加手順

### 1. クエリの設計

```bash
# 実際にMCP toolを手動実行して結果を確認
tsx src/server/main.ts --port 9999 &
curl -X POST http://localhost:9999 -d '{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "context_bundle",
  "params": {"goal": "your query here", "limit": 10}
}'
```

### 2. 上位10件を確認

- Rank 1-3に期待するファイルがあるか？
- 無関係なファイルが上位に来ていないか？
- 適切な `boost_profile` は？

### 3. YAMLに追加

```yaml
- id: {category}-{次の番号}
  query: "your query"
  intent: "開発意図を記述"
  category: "bugfix|feature|refactor|infra|docs"
  expected:
    paths:
      - "実際にrank 1-3に来たファイル"
      - "期待するもう1つのファイル"
  tags: ["適切なタグ"]
  notes: "必要に応じて補足"
```

### 4. 匿名化チェック

機密情報が含まれていないか確認:

```bash
# denylistパターンとマッチしないか確認
grep -E "secrets/|\.env|\.pem" tests/eval/goldens/queries.yaml
```

**匿名化ガイドライン:**

- ❌ プロジェクト固有の名称 → ⭕ 一般的な用語
- ❌ 顧客名・サービス名 → ⭕ 機能カテゴリ
- ❌ 実際のエラーメッセージ → ⭕ パターン化されたエラー
- ⭕ 技術用語はそのまま保持

**例:**

```
Before: "Fix login failure in ProjectX OAuth handler"
After:  "authentication error OAuth validation"

Before: "CustomerA database timeout in payment service"
After:  "database connection pool timeout"
```

### 5. ベンチマーク実行

```bash
# 追加したクエリが意図通り動作するか確認
pnpm run eval:golden --verbose
```

### 6. 結果の検証

- P@10 が期待値（≥0.7）を満たしているか
- TFFU が目標（≤1000ms）を満たしているか
- 失敗した場合は `expected.paths` を修正

---

## データセットのバージョニング

### バージョン更新タイミング

- クエリの追加・削除・変更時
- スキーマバージョン変更時
- 大規模リファクタリング後のパス更新時

### バージョン形式

```
v{YYYY-MM-DD}

例: v2025-11-11, v2025-12-01
```

### 更新手順

1. `datasetVersion` を更新
2. `tests/eval/results/README.md` に変更ログを追記
3. 新バージョンでベンチマークを実行
4. baseline.json を更新

---

## トラブルシューティング

### Q: P@10が低い（<0.5）

**原因:**

- `expected.paths` が実際の検索結果と合っていない
- クエリが曖昧すぎる
- 適切な `boost_profile` が設定されていない

**対策:**

1. 手動でMCP toolを実行し、実際のrank 1-10を確認
2. `expected.paths` を実際の結果に合わせる
3. `params.boostProfile` を調整（docs検索なら`"docs"`または`"balanced"`）

### Q: TFFUが遅い（>2000ms）

**原因:**

- サーバー起動直後のコールドスタート
- DuckDB初回クエリのオーバーヘッド
- 複雑なクエリ（多数のキーワード）

**対策:**

1. warmup機能が有効か確認（run-golden.ts）
2. クエリを簡潔にする
3. FTS拡張が利用可能か確認

### Q: 特定カテゴリのP@10が著しく低い

**原因:**

- カテゴリ特有の検索パターンに最適化されていない
- サンプル数が少なすぎる

**対策:**

1. そのカテゴリのクエリを5件以上に増やす
2. スコアリングプロファイルを見直し（docs/search-ranking.md参照）

---

## 参考資料

- [Issue #65](https://github.com/CAPHTECH/kiri/issues/65): Golden set導入の背景
- [docs/overview.md](../../../docs/overview.md): P@10/TFFU目標値の定義
- [docs/search-ranking.md](../../../docs/search-ranking.md): スコアリングアルゴリズム
- [src/eval/metrics.ts](../../../src/eval/metrics.ts): メトリクス計算実装
