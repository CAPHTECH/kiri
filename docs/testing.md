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
- 評価データは assay-kit のデータセット YAML と `var/assay/` の結果で管理する。

## Assay Kit 評価システム

KIRI の検索品質評価は assay-kit を標準とする。

### 実行方法

```bash
# 評価実行（ローカル）
pnpm run assay:evaluate

# プロファイル切り替え（current / release）
pnpm run assay:evaluate -- --profile release

# データセットを差し替える
pnpm run assay:evaluate -- --dataset datasets/kiri-ab.yaml
```

### A/B 比較

```bash
pnpm run assay:compare -- --dataset datasets/kiri-ab.yaml --variant-a default --variant-b balanced
```

### 成果物

- 既定の結果は `var/assay/` に `eval-<profile>-<dataset>-YYYY-MM-DD.(json|md)` で保存される。
- A/B 比較の結果は `var/assay/` に `comparison-*.json` / `comparison-*.md` が出力される。
- 直近の評価は `var/assay/latest.(json|md)` に上書き保存される。

### 実行前チェック（最小）

1. `var/index.duckdb` が最新であることを確認する。
2. 既存の `src/server/main.ts` プロセスが起動していないことを確認する。
3. 必要なら `pnpm exec kiri index --repo . --db var/index.duckdb` を実行する。

### 評価基準（データセット別・誤差許容）

- **前提**: データセットごとに主指標と許容幅を分けて運用する。
- **許容幅の決め方**: 同一条件で3回評価し、`stdev > 0` の場合は `max(2*stdev, 0.01)` を許容幅とする。`stdev = 0` は **±0.01** を採用する。

#### stopwords（`datasets/kiri-stopwords.yaml`）

- **主指標**: precision / recall
- **合格条件**:
  - 片方が **+0.02 以上改善**
  - 他方は **-0.01 以内の悪化**（許容幅内）
- **副指標**: ndcg / mrr / map / f1 は **±0.01以内**、tffu は **±0.01秒以内**

#### docs（`datasets/kiri-docs*.yaml`）

- **主指標**: NDCG（目標値は「NDCG目標値の設定」を適用）
- **補助条件**: 直近ベースラインから **-0.01 以上の劣化は警戒**とする

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
