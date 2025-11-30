---
doc_id: "TEST-001"
title: "テストと評価"
category: "testing"
tags:
  - testing
  - evaluation
  - docs
  - golden-set
service: "kiri"
---

# テストと評価

> 関連: [検索とランキング](./search-ranking.md#検索とランキング) / [運用 Runbook](./runbook.md#運用-runbook)

## テスト戦略

- **データ駆動テスト**: 過去バグ修正コミットを再現し、正解断片をラベル化してリグレッションを確認する。
- **A/B 比較**
  - VSS なし vs あり（rerank）で P@k / TTFU を比較。
  - 固定 150 行 vs シンボル境界チャンクを比較。
  - recentness 重みを 0→0.2→0.4… と変化させ効果を測定。
- **負荷試験**: 10 万ファイル規模のモックで `context_bundle` の P95 レイテンシを計測する。

## カバレッジと品質指標

- Pull Request ごとに 80% 以上のステートメントカバレッジを目標とする。
- 検索品質は P@k / TFFU / Token 削減率で報告する。
- 評価データは `tests/eval/` にゴールデンデータとして保存し、JSON ベースで比較する。

## ゴールデンセット評価システム

### 概要

KIRI は代表的クエリセット（Golden Set）を使用した検索精度の定量評価システムを提供します。

**メトリクス:**

- **P@10** (Precision at K=10): 上位10件中の関連結果の割合（目標: ≥0.70）
- **TFFU** (Time To First Useful): 最初の関連結果が返されるまでの時間（目標: ≤1000ms）

**現在の制約 (v0.9.10):**

- クエリ数: 5件（カテゴリごとに1件）
- 推奨: 20-50件（カテゴリごとに3-10件）
- 今後の計画: v1.0.0までに20件以上に拡充予定

現在のクエリ数は統計的な信頼性が限定的です。より正確な評価のため、今後クエリセットを段階的に拡充していきます。

### 実行方法

```bash
# ベンチマーク実行（ローカルのみ、CI除外）
pnpm run eval:golden

# 詳細ログ付き実行
pnpm run eval:golden:verbose

# カスタムパラメータ
tsx scripts/eval/run-golden.ts --k 10 --warmup 3 --verbose
```

### ファイル構成

```
tests/eval/
├── goldens/
│   ├── README.md           # スキーマ定義、クエリ追加ガイド
│   ├── queries.yaml        # 代表クエリセット（20-50件）
│   └── baseline.json       # ベースライン測定値とthresholds
├── results/
│   ├── README.md           # 結果記録ワークフロー
│   └── YYYY-MM-DD-*.md     # 個別ベンチマーク結果
└── metrics.spec.ts         # メトリクス計算のユニットテスト

scripts/eval/
└── run-golden.ts           # ベンチマーク実行スクリプト
```

### クエリカテゴリ

1. **bugfix** (5-10 queries): バグ修正時の調査フロー
2. **feature** (5-10 queries): 新機能追加時の参照コード検索
3. **refactor** (3-7 queries): リファクタリング対象の特定
4. **infra** (3-7 queries): インフラ・設定関連の調査
5. **docs** (3-7 queries): ドキュメント検索

### ベンチマーク機能

- **Warmup**: 2回のwarmup実行でキャッシュを安定化
- **リトライ**: 失敗時に最大2回リトライ（exponential backoff）
- **ベースライン比較**: `baseline.json` と比較してリグレッション検知
- **CI Guard**: `process.env.CI` チェックで本番CI除外
- **高精度計測**: `process.hrtime.bigint()` による正確なタイミング測定

### 結果出力

**JSON形式** (`var/eval/latest.json`):

```json
{
  "timestamp": "2025-11-11T12:00:00Z",
  "version": "0.9.10",
  "overall": {
    "precisionAtK": 0.75,
    "avgTTFU": 850,
    "totalQueries": 25
  },
  "byCategory": { ... },
  "queries": [ ... ]
}
```

**Markdown形式** (`var/eval/latest.md`):

```markdown
# KIRI Golden Set Evaluation - 2025-11-11

| Metric | Value | Threshold | Status |
| ------ | ----- | --------- | ------ |
| P@10   | 0.750 | ≥0.70     | ✅     |
| TFFU   | 850ms | ≤1000ms   | ✅     |
```

### クエリの追加

1. 手動でMCP toolを実行して結果を確認
2. `tests/eval/goldens/queries.yaml` に追加
3. 匿名化チェック（機密情報除去）
4. ベンチマーク実行して検証

詳細は [tests/eval/goldens/README.md](../tests/eval/goldens/README.md) を参照。

### 結果の記録

1. `pnpm run eval:golden` を実行
2. `var/eval/latest.md` を `tests/eval/results/YYYY-MM-DD-description.md` にコピー
3. `tests/eval/results/README.md` のサマリーテーブルを更新

詳細は [tests/eval/results/README.md](../tests/eval/results/README.md) を参照。

### 複数リポジトリの評価

- `tests/eval/goldens/queries.yaml` に `defaultRepo` と `repos` を定義すると、1回のベンチマーク内で複数のコードベースを切り替えて検査できます。
- `repos.<alias>.repoPath` は作業コピーのルート、`dbPath` は対応する DuckDB ファイルを指定します。
- private リポジトリを扱う場合は Git submodule などで `external/<name>` 配下に配置し、`kiri index --repo external/<name> --db external/<name>/.kiri/index.duckdb` のように事前インデックスを作成します。
- 各クエリは `repo: <alias>` を指定するだけで該当レポジトリを対象に検索できます（省略時は `defaultRepo` を使用）。
- `pnpm run eval:golden` はクエリの `repo` を検知してMCPサーバーを自動的に再起動するため、手動で `--repo` を付け替える必要はありません。

### ドキュメント front matter 無効化ベンチ

ドキュメント検索における front matter 依存度を比較するため、`scripts/docs/make-plain.ts` で front matter を除去したコーパスを生成します。

```bash
# plain corpus を生成し、インデックスも作成
pnpm exec tsx scripts/docs/make-plain.ts --index

# 生成物
#   tmp/docs-plain/                … front matter 無しの Markdown
#   tmp/docs-plain/.kiri/index.duckdb
```

`tests/eval/goldens/queries.yaml` の `kiri-docs-plain` エイリアスは上記 `tmp/docs-plain/` を参照しており、`pnpm run eval:golden` だけで「front matter あり/なし」両カテゴリのP@10やMetadata Pass Rateを計測できます。front matter 除去ロジックは YAML ブロックのみを削除し、本体コンテンツや Markdown リンクは変更されません。

### ゴールデンセット実行前チェックリスト

複数リポジトリを跨いだベンチマークでは、以下の手順を満たしていないとすべてのクエリが空振りします。CI/ローカルを問わず、実行前に毎回確認してください。

1. **リポジトリを用意する**

   ```bash
   git submodule update --init external/assay-kit
   scripts/setup-golden.sh
   pnpm exec tsx scripts/docs/make-plain.ts --index
   ```

2. **DuckDB と security.lock を揃える**

   ```bash
   pnpm exec tsx src/indexer/cli.ts --repo . --db var/index.duckdb --full
   ```

# 上記スクリプトでインデックス生成＆セキュリティロック生成まで行われます

pnpm exec tsx src/client/cli.ts security verify --db var/index.duckdb --security-lock var/security.lock --write-lock
pnpm exec tsx src/client/cli.ts security verify --db tmp/docs-plain/.kiri/index.duckdb --security-lock tmp/docs-plain/.kiri/security.lock --write-lock

````

> `scripts/eval/run-golden.ts` は `security.lock` が存在しない場合に即時停止します。エラーメッセージに沿って上記コマンドを再実行してください。

3. **インデックスカバレッジを確認する**

```bash
pnpm exec tsx scripts/diag/index-coverage.ts --dataset datasets/kiri-ab.yaml --db var/index.duckdb
pnpm exec tsx scripts/diag/index-coverage.ts --dataset tests/eval/goldens/queries.yaml --db external/vscode/.kiri/index.duckdb
````

期待される出力は `Missing on disk: 0 / Missing in DuckDB: 0` です。ヒットしないファイルがある場合は `.gitignore` や `.kiri` の生成を確認します。

4. **スニペット/トークンを spot check する**

   ```bash
   # 期待ファイルの抜粋を確認
   pnpm exec tsx scripts/diag/snippet-preview.ts --dataset datasets/kiri-ab.yaml --db var/index.duckdb --max-lines 6 | head -n 80

   # クエリごとのキーワード・パス展開を確認
   pnpm exec tsx scripts/diag/query-terms.ts --dataset tests/eval/goldens/queries.yaml --repo vscode
   ```

5. **ベンチマークを実行する**

   ```bash
   KIRI_ALLOW_UNSAFE_PATHS=1 pnpm run eval:golden -- --dataset datasets/kiri-ab.yaml --limit 50 --k 15
   ```

   `KIRI_ALLOW_UNSAFE_PATHS=1` を付与しないと `external/*` などリポジトリ外パスを参照できません。

### Assay Kit 連携（Phase 2 機能）

- `pnpm run assay:evaluate` で `external/assay-kit/examples/kiri-integration/datasets/kiri-golden.yaml` を対象に Assay Runner を実行し、`var/assay/eval-YYYY-MM-DD.(json|md)` に結果を保存します。`KiriSearchAdapter` が内部で `kiri-server` を HTTP モードで起動し、warmup/リトライ/並列実行を Assay に委譲します。
- `pnpm run assay:compare` で `ComparisonRunner`（Phase 2.1）による A/B 比較を実行し、`default` と `balanced` バリアントを統計的に比較します。`--variant-a`/`--variant-b` や `--stats mann-whitney-u`、`--correction holm`（0.1.1 で修正された Holm-Bonferroni 補正を活用）などのフラグは `--` 以降に指定可能です。
- どちらのコマンドも `.kiri/index.duckdb` を利用するため、事前に `pnpm exec kiri index --repo . --db .kiri/index.duckdb` などで最新のインデックスを作成してください。
- `scripts/assay/plugins` にはカスタムメトリクス（Phase 2.2）の登録例があり、`assay:evaluate` 実行時に PluginRegistry を通じて読み込まれます。今後はここに自社固有のレポーターやベースラインプロバイダを追加できます。
- Assay Kit v0.1.1 で統計補正の互換性が更新されたため、カスタムプラグインの `meta.assay` は `">=0.1.1"` を指定し、CLI から Holm/Bonferroni 補正を選べるようにしました。

## データセット設計のベストプラクティス

### hintsの役割と影響

**重要**: `hints`（`metadata.hints`）は検索結果に**強く影響**します。

#### hintsの動作

1. `hints` は `artifacts` としてMCP `context_bundle` に渡される
2. KIRIは `artifacts.hints` に含まれるファイルパスやキーワードを優先的に検索結果に含める
3. **hintsに含まれるファイルは、通常のスコアリングよりも高く評価される**

#### ベストプラクティス

**✅ DO**: hintsとexpectedを一致させる

```yaml
expected:
  - path: "src/plugins/registry.ts"
    relevance: 3
  - path: "src/plugins/types.ts"
    relevance: 2
hints:
  - "PluginRegistry"
  - "registerPlugin"
  - "src/plugins/registry.ts" # expectedの最重要ファイルを含める
  - "src/plugins/types.ts" # expectedの重要ファイルを含める
```

**❌ DON'T**: hintsに無関係なファイルを含める

```yaml
expected:
  - path: "src/plugins/registry.ts"
    relevance: 3
  - path: "src/plugins/types.ts"
    relevance: 2
hints:
  - "PluginRegistry"
  - "registerPlugin"
  - "src/cli/commands/evaluate.ts" # ❌ expectedに含まれない！
```

**理由**: 上記の誤った例では、`cli/commands/evaluate.ts` が検索結果の上位に現れ、本当に重要な `plugins/registry.ts` や `plugins/types.ts` が検索結果に含まれなくなります。その結果、NDCG が大幅に低下します（実例: 0.871 → 0.098、-89%）。

#### デバッグ方法

hintsが原因で検索結果が期待と異なる場合:

1. **デバッグログを追加**して実行時の検索結果を確認:

```typescript
if (query.id === "問題のクエリID") {
  console.error("Retrieved paths:", retrievedPaths.slice(0, 5));
  console.error("Expected paths:", expectedPaths);
}
```

2. **手動検証との比較**（artifacts なしで実行）:

```bash
# artifactsなしで直接サーバーを呼ぶ
curl -X POST http://localhost:19999/rpc \
  -d '{"method": "context_bundle", "params": {"goal": "クエリテキスト", "limit": 10}}'
```

3. **hints を段階的に削除**して影響を確認

### relevanceスコアの設計

#### 推奨レンジ

| relevance | 意味         | 使用場面                                      |
| --------- | ------------ | --------------------------------------------- |
| **3**     | 必須・最重要 | クエリの核心に直接答えるファイル（通常1-2件） |
| **2**     | 重要         | 核心の周辺、重要な関連ファイル（通常1-3件）   |
| **1**     | 関連あり     | 参考になるが必須ではない（3-5件程度）         |
| **0**     | 無関係       | （明示的に指定する必要なし）                  |

#### 例: プラグインシステムの実装

```yaml
id: "q-feature"
text: "plugin system registry initialization"
expected:
  - path: "src/plugins/registry.ts" # relevance=3: レジストリの実装（核心）
    relevance: 3
  - path: "src/plugins/types.ts" # relevance=2: 型定義（重要な関連）
    relevance: 2
  - path: "src/plugins/logger.ts" # relevance=1: ロガー（参考）
    relevance: 1
  - path: "src/plugins/dependencies.ts" # relevance=1: 依存関係（参考）
    relevance: 1
  - path: "src/cli/commands/evaluate.ts" # relevance=1: 利用側（参考）
    relevance: 1
```

### NDCG目標値の設定

| NDCG          | 評価      | アクション                  |
| ------------- | --------- | --------------------------- |
| **≥ 0.70**    | ✅ 合格   | そのまま使用可能            |
| **0.50-0.69** | ⚠️ 警告   | hintsとexpectedの一致を確認 |
| **< 0.50**    | ❌ 不合格 | データセット設計を見直し    |

### 検証チェックリスト

新しいクエリを追加する際:

- [ ] `hints` に含まれる全てのファイルパスが `expected` に含まれている
- [ ] `expected` の relevance=3, 2 のファイルが `hints` に含まれている
- [ ] relevance スコアが適切（3: 最重要、2: 重要、1: 参考）
- [ ] 実際の検索結果を確認（デバッグログまたは手動検証）
- [ ] NDCG ≥ 0.70 を達成している

### トラブルシューティング

#### 症状: NDCGが予想より低い（< 0.50）

**原因の可能性**:

1. **hints の不一致** (最頻出)
2. expected ファイルがインデックスに含まれていない
3. クエリテキストが漠然としすぎている

**診断手順**:

1. hints と expected を比較
2. デバッグログで実際の検索結果を確認
3. 手動検証（artifacts なし）と比較

#### 症状: 手動検証とテスト結果が異なる

**原因**: hints が artifacts として渡されている（テストのみ）

**対策**: デバッグログで実行時の検索結果を確認

### 参考資料

- **実例**: `docs/eval-debug-success-2025-11-18.md` - hintsの誤りによるNDCG低下とデバッグプロセス
- **データセット**: `datasets/kiri-ab.yaml` - 正しい hints 設計の例
- **評価結果**: `docs/eval-ndcg-results-2025-11-18.md` - NDCG による評価
