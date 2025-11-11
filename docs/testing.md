# テストと評価

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
