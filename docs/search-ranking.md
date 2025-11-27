---
title: "検索とランキング"
category: "search"
tags:
  - ranking
  - docs
  - metadata
  - inbound-links
service: "kiri"
---

# 検索とランキング

> 関連: [KIRI 概要](./overview.md#kiri-概要) / [運用 Runbook](./runbook.md#運用-runbook) / [テストと評価](./testing.md#テストと評価)

## 方針

- **一次候補**は文字列一致・シンボル名・依存・パス近接・直近変更など決定的特徴で高速抽出する。
- **FTSハイブリッド検索**: DuckDB FTS拡張が利用可能な場合はBM25ランキングを使用、利用不可の場合はILIKEフォールバックで動作する（Degrade-First Architecture）
- **フレーズ認識トークン化**: ハイフン区切り用語（例: `page-agent`）を単一ユニットとして保持し、引用符で囲まれたフレーズ（例: `"oauth handler"`）を正確にマッチする
- **パスベーススコアリング**: キーワードやフレーズがファイルパス内に現れる場合に追加ブーストを適用
- **ファイルタイプブースト**: 実装ファイル（src/\*.ts）を優遇し、ドキュメントファイル（\*.md）を減点することで、検索精度を向上
- **構造化メタデータ加点**: Markdown Front Matter や YAML/JSON の `title`/`tags` を取り込み、クエリ語や `metadata_filters` に一致した場合はスコアを加算する。
- **リンクグラフブースト**: Markdown インラインリンクの参照数をカウントし、被リンクの多いドキュメントを優先表示する。
- **二次再ランキング**ではオプションの VSS を利用し、概念的な近さを加点する。
- **目的別プロファイル**（bugfix/testfail/refactor/typeerror/feature）で重み付けを切り替える。

## トークン化戦略

キーワード抽出とセマンティック埋め込み生成で使用するトークン化戦略を設定できます。

### 設定方法

`config/default.example.yml` または環境変数 `KIRI_TOKENIZATION_STRATEGY` で設定:

```yaml
tokenization:
  strategy: "phrase-aware" # "phrase-aware", "legacy", "hybrid" から選択
```

### 戦略の種類

| 戦略                          | 説明                                       | 例: "page-agent" の処理           |
| ----------------------------- | ------------------------------------------ | --------------------------------- |
| **phrase-aware** (デフォルト) | ハイフン区切り用語を単一ユニットとして保持 | `["page-agent"]`                  |
| **legacy**                    | ハイフンで分割（従来の動作）               | `["page", "agent"]`               |
| **hybrid**                    | フレーズと分割キーワードの両方を出力       | `["page-agent", "page", "agent"]` |

### 推奨設定

- **一般的な使用**: `phrase-aware` (デフォルト) - 最も正確なマッチングを提供
- **後方互換性が必要な場合**: `legacy` - 従来の動作を維持
- **網羅的な検索**: `hybrid` - 最も広範なマッチングを提供（トークン数増加のトレードオフあり）

## ストップワード設定

キーワード抽出時に除外される一般語（ストップワード）を設定できます。

### 設定ファイル

`config/stop-words.yml` または `.kiri/stop-words.yml` に配置:

```yaml
version: "1.0"

# デフォルト言語（"en" または "ja"）
default_language: "en"

languages:
  en:
    words:
      - the
      - and
      - for
      # ... (英語ストップワード)

  ja:
    words:
      - は
      - が
      - を
      - に
      # ... (日本語ストップワード)

# プログラミング言語キーワード（全言語共通）
code_generic:
  - "null"
  - undefined
  - "true"
  - "false"

# リポジトリ固有の追加
custom: []
```

### 設定項目

| 項目                     | 説明                                         |
| ------------------------ | -------------------------------------------- |
| `default_language`       | デフォルトで使用する言語（`en` または `ja`） |
| `languages.<lang>.words` | 言語固有のストップワードリスト               |
| `code_generic`           | 全言語共通で除外するプログラミングキーワード |
| `custom`                 | リポジトリ固有の追加ストップワード           |

### 環境変数

- `KIRI_STOP_WORDS_LANG`: 使用する言語を上書き（例: `ja`）

### 後方互換性

設定ファイルがない場合、従来の31語の英語ストップワードが使用されます。既存の動作に影響はありません。

### 日本語サポート

日本語のストップワードでは、以下の正規化が自動適用されます:

- NFKC正規化（全角→半角変換）
- カタカナ→ひらがな変換
- 小文字化

```yaml
# 以下は同一のストップワードとして扱われる
languages:
  ja:
    words:
      - こと # ひらがな
      - コト # カタカナ（正規化されてマッチ）
```

## フレーズマッチング

### 引用符で囲まれたフレーズ

ゴールに引用符（`"` または `'`）で囲まれたフレーズを含めると、完全一致でマッチングされます:

```typescript
// 例: "oauth-handler" を正確に探す
contextBundle({ goal: '"oauth-handler" authentication' });
// → "oauth-handler" がコンテンツまたはパスに含まれるファイルを優先
```

### 複合用語の自動認識（ハイフン・アンダースコア）

引用符なしでも、ハイフン区切り用語（kebab-case）やアンダースコア区切り用語（snake_case）は自動的にフレーズとして認識されます（`phrase-aware` モード）:

```typescript
// 例: page-agent が単一ユニットとして処理される
contextBundle({ goal: "page-agent Lambda handler" });
// → "page-agent" を含むファイルを優先（"page" と "agent" に分割されない）

// 例: user_profile が単一ユニットとして処理される (snake_case)
contextBundle({ goal: "user_profile database query" });
// → "user_profile" を含むファイルを優先（"user" と "profile" に分割されない）

// 例: file_embedding も同様
contextBundle({ goal: "file_embedding vector generation" });
// → "file_embedding" がフレーズとして認識される
```

### パスライクな用語の抽出

スラッシュを含むパスライクな用語は自動的にセグメントに分割されます:

```typescript
// 例: lambda/page-agent/handler からセグメント抽出
contextBundle({ goal: "lambda/page-agent/handler request processing error handling" });
// → パスセグメント: ["lambda", "page-agent", "handler"]
// → これらのセグメントがファイルパスに含まれる場合にブースト
```

## パスベーススコアリング

キーワード、フレーズ、パスセグメントがファイルパスに含まれる場合、追加のスコアブーストが適用されます。

### スコアリングルール

| マッチタイプ           | 重み係数        | 例                                                                   |
| ---------------------- | --------------- | -------------------------------------------------------------------- |
| **フレーズ in パス**   | pathMatch × 1.5 | `lambda/page-agent/handler.ts` に対して `"page-agent"`               |
| **パスセグメント**     | pathMatch × 1.0 | `lambda/foo/bar.ts` に対して `/lambda/foo` から抽出された `"lambda"` |
| **キーワード in パス** | pathMatch × 0.5 | `src/auth/login.ts` に対して `"auth"`                                |

### 例

```typescript
// ファイル: lambda/page-agent/src/handler.ts
// ゴール: "page-agent Lambda handler"
//
// スコア計算:
// - phrase:page-agent (コンテンツマッチ): textMatch × 2.0 = +2.0
// - path-phrase:page-agent (パスマッチ): pathMatch × 1.5 = +2.25
// - 合計ブースト: +4.25
//
// 比較: lambda/canvas-agent/handler.ts
// - text:agent (分割キーワードマッチ): textMatch × 1.0 = +1.0
// - text:handler: textMatch × 1.0 = +1.0
// - 合計: +2.0 (page-agent より大幅に低い)
```

### ファイルタイプブースト

`boost_profile` パラメータで代表的なモードを選択可能:

#### boost_profile: "default" (デフォルト)

実装ファイルを優遇し、ドキュメントを減点

**files_search:**

- `src/*.ts`, `src/*.js`: スコア ×1.5（実装ファイルを優遇）
- `tests/*.ts`: スコア ×1.2（テストファイルを軽度優遇）
- `*.md`, `*.yaml`, `*.yml`: スコア ×0.5（ドキュメントを減点）

**context_bundle:**

- `src/*.ts`: スコア +0.5（実装ファイルに追加ボーナス）
- `*.md`, `*.yaml`, `*.yml`: スコア -0.3（ドキュメントにペナルティ）

#### boost_profile: "docs"

ドキュメントを優遇し、実装ファイルを軽度減点

**files_search:**

- `*.md`, `*.yaml`, `*.yml`: スコア ×1.5（ドキュメントを優遇）
- `src/*.ts`, `src/*.js`: スコア ×0.7（実装ファイルを軽度減点）

**context_bundle:**

- `*.md`, `*.yaml`, `*.yml`: スコア +0.5（ドキュメントに追加ボーナス）
- `src/*.ts`: スコア -0.2（実装ファイルに軽度ペナルティ）

#### boost_profile: "balanced" (NEW in v0.9.10)

ドキュメントと実装ファイルに等しい重みを適用

**files_search & context_bundle:**

- `src/*.ts`, `src/*.js`: スコア ×1.0（ブースト/ペナルティなし）
- `*.md`, `*.yaml`, `*.yml`: スコア ×1.0（ブースト/ペナルティなし）
- `docs/` ディレクトリ: ✅ **ブラックリストから除外**（検索可能）
- `tsconfig.json`, `package.json` などの設定ファイル: スコア ×0.3（緩やかなペナルティ、defaultの0.05より緩い）
- パス固有のブースト（`src/app/` × 1.4など）: **無効化**

**使用ケース:**

- ドキュメントとコードの両方を等しく検索したい場合
- プロジェクト全体のナレッジベース検索
- APIドキュメントと実装を同時に参照する場合

#### boost_profile: "none"

ファイルタイプによるブースト無効、純粋なBM25スコアのみ

#### boost_profile: "vscode" (NEW)

VS Code リポジトリのように `src/vs/**` と `extensions/**` が巨大なケース向けの専用プロファイル。

- `src/vs/workbench/**`, `src/vs/platform/**`: 大幅ブースト（×2.5 以上）
- `extensions/**`: 中程度ブースト（×1.9）でエクステンション実装を浮上
- `cli/**`, `.eslint-plugin-local/**`: 強い減衰（×0.3 以下）でノイズを除去
- `docs/` は denylist 解除せず、通例どおり `docs` プロファイルを併用

**使用ケース:**

- VS Code ワークツリーで `registerWorkbenchContribution` 等を検索する際に CLI 実装が先に出てしまう場合
- 大規模モノレポで「特定ディレクトリのみを優遇・その他を減衰」したい場合

### 使用例

```typescript
// 実装ファイルを探す（デフォルト）
filesSearch({ query: "tryCreateFTSIndex" });
// → src/*.ts が上位に

// ドキュメントを探す
filesSearch({ query: "setup instructions", boost_profile: "docs" });
// → *.md が上位に

// ドキュメントとコードを同等に扱う（NEW in v0.9.10）
contextBundle({ goal: "authentication design docs/auth/README.md", boost_profile: "balanced" });
// → docs/*.md と src/*.ts が等しい重みでランク付け

// 純粋なBM25スコア
filesSearch({ query: "authentication", boost_profile: "none" });
// → ファイルタイプ関係なく、BM25スコアのみ

// VS Code コードパスを優先
contextBundle({
  goal: "registerWorkbenchContribution workbench part",
  boost_profile: "vscode",
});
// → src/vs/workbench/** が上位に、cli/ や .eslint-plugin-local は抑制
```

### 乗算ペナルティモデル（v1.0.0+）

**v1.0.0で絶対ペナルティ(`-100`)から乗算ペナルティ(`×0.01`など)に移行しました。**

この変更により、ペナルティが予測可能で組み合わせ可能になり、boost_profileとの相互作用が明確になりました。

### パス乗算ペナルティのカスタマイズ（.kiri/config.yaml）

`boost_profile` の既定 `pathMultipliers` に加えて、リポジトリ単位でパス倍率を上書きできます。

```yaml
# .kiri/config.yaml
path_penalties:
  - prefix: src/
    multiplier: 1.4 # src/ を強める
  - prefix: external/
    multiplier: 0.3 # external/ を弱める
```

- 環境変数でも設定可能: `KIRI_PATH_PENALTY_src__core__=0.8`（`/` → `__` にエンコード）
- マージ優先度: プロファイル定義 < 環境変数 < YAML（後勝ち）
- プレフィックスは POSIX 化され、最長一致（Longest Prefix Wins）で適用される。
- 正規化ルール: `\` は `/` に変換され、`..` やドライブレターは除去される（リポジトリ内相対パス前提）。

#### スコアフィルタリング

乗算ペナルティ適用後、スコアが非常に低いファイル（デフォルト: `< 0.05`）は結果から除外されます:

```typescript
// 環境変数で調整可能
export KIRI_SCORE_THRESHOLD=0.1  // より厳しいフィルタリング（デフォルト: 0.05）
```

#### ペナルティ係数（ScoringWeights）

`config/scoring-profiles.yml` で各プロファイルごとに設定可能:

| フィールド                   | デフォルト値 | 説明                                                          |
| ---------------------------- | ------------ | ------------------------------------------------------------- |
| `blacklistPenaltyMultiplier` | `0.01`       | ブラックリストディレクトリに99%削減（スコア×0.01）            |
| `testPenaltyMultiplier`      | `0.02`       | テストファイルに98%削減（スコア×0.02）                        |
| `lockPenaltyMultiplier`      | `0.01`       | Lockファイル（package-lock.jsonなど）に99%削減                |
| `configPenaltyMultiplier`    | `0.05`       | 設定ファイルに95%削減（構造的ノイズが多いファイル用）         |
| `docPenaltyMultiplier`       | `0.5`        | ドキュメントファイル（\*.md）に50%削減（defaultプロファイル） |
| `implBoostMultiplier`        | `1.3`        | 実装ファイル（src/\*.ts）に30%ブースト                        |

**ペナルティ適用の例:**

```typescript
// ファイル: node_modules/lodash/index.js
// 基本スコア: 5.0
// blacklistPenaltyMultiplier: 0.01
// 最終スコア: 5.0 × 0.01 = 0.05 → フィルタリングされる（threshold未満）

// ファイル: tests/unit/auth.spec.ts
// 基本スコア: 4.0
// testPenaltyMultiplier: 0.02
// 最終スコア: 4.0 × 0.02 = 0.08 → フィルタリングされる

// ファイル: src/auth/login.ts
// 基本スコア: 4.0
// implBoostMultiplier: 1.3
// 最終スコア: 4.0 × 1.3 = 5.2 → 上位にランク
```

#### ブラックリスト動作

以下のディレクトリには強い乗算ペナルティ（`blacklistPenaltyMultiplier`）が適用されます:

| ディレクトリ                 | デフォルト係数                                        | `"docs"`プロファイル                                  | `"balanced"`プロファイル                              | 説明                                       |
| ---------------------------- | ----------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------ |
| `docs/`                      | `×0.01` (99%削減)                                     | ✅ **除外免除**                                       | ✅ **除外免除**                                       | ドキュメント専用ディレクトリ               |
| テストファイル（\*.spec.ts） | `×testPenaltyMultiplier` (デフォルト: 0.02 = 98%削減) | `×testPenaltyMultiplier` (デフォルト: 0.02 = 98%削減) | `×testPenaltyMultiplier` (デフォルト: 0.02 = 98%削減) | 拡張子ベースで判定（プロファイル調整可能） |
| `node_modules/`              | `×0.01` (99%削減)                                     | `×0.01` (99%削減)                                     | `×0.01` (99%削減)                                     | 依存関係（常にペナルティ）                 |
| `.git/`, `.cursor/`          | `×0.01` (99%削減)                                     | `×0.01` (99%削減)                                     | `×0.01` (99%削減)                                     | メタデータディレクトリ（常にペナルティ）   |
| `dist/`, `build/`            | `×0.01` (99%削減)                                     | `×0.01` (99%削減)                                     | `×0.01` (99%削減)                                     | ビルド成果物（常にペナルティ）             |
| `coverage/`, `tmp/`          | `×0.01` (99%削減)                                     | `×0.01` (99%削減)                                     | `×0.01` (99%削減)                                     | 一時ファイル（常にペナルティ）             |

**重要な動作変更（v1.0.0）:**

- ✅ **乗算ペナルティ**: 絶対ペナルティ(`-100`)の代わりに乗算係数を使用
- ✅ **組み合わせ可能**: 複数のペナルティ/ブーストが予測可能に組み合わさる
- ✅ **フィルタリング**: スコア < `KIRI_SCORE_THRESHOLD`（デフォルト: 0.05）のファイルは除外
- ✅ **プロファイル免除**: `denylistOverrides`でプロファイルごとにディレクトリ免除を制御

**使用例:**

```typescript
// デフォルトプロファイル: docs/ に99%ペナルティ適用
contextBundle({ goal: "feature guide" });
// → docs/guide.md のスコアは 0.01倍になり、多くの場合フィルタリングされる

// docsプロファイル: docs/ の免除
contextBundle({ goal: "feature guide", boost_profile: "docs" });
// → docs/guide.md が正常にランク付けされる

// カスタムしきい値: より寛容に
// export KIRI_SCORE_THRESHOLD=0.001
contextBundle({ goal: "feature guide" });
// → 低スコアのファイルも含まれるようになる
```

## スコア計算例

`context_bundle` で使用される総合スコアは以下の3フェーズで計算されます（v1.0.0+）:

### フェーズ1: 加算的スコアリング（Additive Scoring）

```
baseScore = textMatch * (keyword_matches + phrase_matches * 2.0)  -- テキストマッチ（フレーズは2倍）
          + pathMatch * path_boost                                 -- パスベースブースト
          + editingPath * editing_boost                            -- 編集中ファイル
          + dependency * dep_score                                 -- 依存関係（静的解析）
          + proximity * proximity_score                            -- 近接度（同ディレクトリ）
          + structural * semantic_sim                              -- 構造的類似度（LSHベース）
          + graphInbound * log(1 + inbound_count) * decay^depth   -- グラフ被参照度（v0.15.0+）
          + graphImportance * importance_score                     -- グラフ重要度（v0.15.0+）
          + cochange * log(1 + count) * confidence                 -- Co-change（v0.15.0+、editing_path使用時のみ）
```

### フェーズ2: 乗算的ペナルティ/ブースト（Multiplicative Penalties/Boosts）

```
scoreMultiplier = 1.0
if (blacklisted directory):
    scoreMultiplier *= blacklistPenaltyMultiplier  -- 例: ×0.01 (99%削減)
else if (test file):
    scoreMultiplier *= testPenaltyMultiplier        -- 例: ×0.02 (98%削減)
else if (lock file):
    scoreMultiplier *= lockPenaltyMultiplier        -- 例: ×0.01 (99%削減)
else if (doc file):
    scoreMultiplier *= docPenaltyMultiplier         -- 例: ×0.5 (50%削減、defaultプロファイル)
else if (impl file):
    scoreMultiplier *= implBoostMultiplier          -- 例: ×1.3 (30%ブースト)
```

### フェーズ3: 最終スコアとフィルタリング

```
finalScore = baseScore * scoreMultiplier

if (finalScore < SCORE_FILTER_THRESHOLD):
    exclude from results  -- デフォルト: < 0.05
```

**例:**

```typescript
// ファイル: src/auth/login.ts
// baseScore: 4.0 (テキストマッチ + パスマッチ)
// implBoostMultiplier: 1.3
// finalScore: 4.0 × 1.3 = 5.2 ✅ 上位にランク

// ファイル: docs/setup.md
// baseScore: 3.5
// docPenaltyMultiplier: 0.5 (defaultプロファイル)
// finalScore: 3.5 × 0.5 = 1.75 ✅ ランクは下がるが含まれる

// ファイル: tests/auth.spec.ts
// baseScore: 4.0
// testPenaltyMultiplier: 0.02
// finalScore: 4.0 × 0.02 = 0.08 ✅ わずかに閾値を超えて含まれる

// ファイル: node_modules/lodash/index.js
// baseScore: 2.0
// blacklistPenaltyMultiplier: 0.01
// finalScore: 2.0 × 0.01 = 0.02 ❌ 閾値未満で除外
```

### スコアリングプロファイル

`config/scoring-profiles.yml` で定義されたプロファイル（v0.6.0+）:

#### default プロファイル

```yaml
textMatch: 1.0 # テキスト/キーワードマッチ（増加: 精度向上）
pathMatch: 1.5 # パスマッチ（新規: パス内のキーワード優先）
editingPath: 2.0 # 編集中ファイル
dependency: 0.6 # 依存関係
proximity: 0.25 # 近接度
structural: 0.6 # 構造的類似度（削減: 誤マッチ防止）
```

#### bugfix プロファイル

```yaml
textMatch: 1.0
pathMatch: 1.5
editingPath: 1.8
dependency: 0.7 # バグは依存関係にあることが多い
proximity: 0.35
structural: 0.7 # 削減: canvas-agentがpage-agent検索で誤マッチしないように
```

#### testfail プロファイル

```yaml
textMatch: 1.0
pathMatch: 1.5
editingPath: 1.6
dependency: 0.85 # 非常に高い: 失敗したテストは依存関係を明らかにする
proximity: 0.3
structural: 0.7 # 削減: 実際のテスト依存関係に焦点
```

#### typeerror プロファイル

```yaml
textMatch: 1.0
pathMatch: 1.5
editingPath: 1.4
dependency: 0.6
proximity: 0.4 # 型エラーはモジュール内でクラスター化
structural: 0.6 # すでにバランス済み
```

#### feature プロファイル

```yaml
textMatch: 1.0
pathMatch: 1.5
editingPath: 1.5
dependency: 0.45 # 新機能は既存コードへの依存が少ない
proximity: 0.5 # 機能は空間的にクラスター化
structural: 0.6 # 削減: 実際の機能ファイルに焦点
```

### v0.6.0 での主な変更点

1. **textMatch 増加**: 0.8 → 1.0（リテラルマッチを優先）
2. **pathMatch 追加**: 新規 1.5（パス内のキーワードに高ブースト）
3. **structural 削減**: 1.0 → 0.6（構造的に類似したファイルによる誤マッチを防止）
4. **フレーズマッチ強化**: フレーズマッチは textMatch の 2倍のスコア

これらの調整により、`page-agent` 検索で `canvas-agent` が誤ってマッチするような問題が解決されます。

## 代表クエリ例

- **FTSハイブリッド検索（複数単語対応）**

FTS拡張が利用可能な場合（BM25ランキング）:

```sql
SELECT f.path, f.lang, f.ext, b.content, fts.score
FROM file f
JOIN blob b ON b.hash = f.blob_hash
JOIN (
  SELECT hash, fts_main_blob.match_bm25(hash, ?) AS score
  FROM blob
  WHERE score IS NOT NULL
) fts ON fts.hash = b.hash
WHERE f.repo_id = ?
ORDER BY fts.score DESC
LIMIT ?
```

FTS拡張が利用不可の場合（ILIKEフォールバック、複数単語OR検索）:

```sql
SELECT f.path, f.lang, f.ext, b.content
FROM file f
JOIN blob b ON b.hash = f.blob_hash
WHERE f.repo_id = ?
  AND (b.content ILIKE '%' || ? || '%' OR b.content ILIKE '%' || ? || '%')
LIMIT ?
```

- **文字列＋近接**

```sql
WITH cand AS (
  SELECT path, 1.0 AS base
  FROM file f JOIN blob b ON b.hash = f.blob_hash
  WHERE f.repo_id=? AND (b.content ILIKE '%' || ? || '%' OR b.content ILIKE '%' || ? || '%')
  LIMIT 400
),
near AS (
  SELECT path, 0.6 AS near
  FROM file
  WHERE repo_id=? AND path LIKE ? -- 例: 'src/auth/%'
)
SELECT path,
       MAX(COALESCE(base,0))*0.6 + MAX(COALESCE(near,0))*0.4 AS score
FROM (SELECT * FROM cand UNION ALL SELECT * FROM near)
GROUP BY path
ORDER BY score DESC
LIMIT 100;
```

- **依存クロージャ（双方向対応、深さ2）**

Outbound（このファイルが何を使用しているか）:

```sql
WITH RECURSIVE walk(step, path) AS (
  SELECT 0, ?
  UNION ALL
  SELECT step+1, d.dst
  FROM walk w JOIN dependency d ON d.repo_id=? AND d.src_path=w.path
  WHERE step < 2 AND d.dst_kind='path'
)
SELECT DISTINCT path FROM walk;
```

Inbound（どのファイルがこれを使用しているか）:

```sql
WITH RECURSIVE walk(step, path) AS (
  SELECT 0, ?
  UNION ALL
  SELECT step+1, d.src_path
  FROM walk w JOIN dependency d ON d.repo_id=? AND d.dst=w.path
  WHERE step < 2 AND d.dst_kind='path'
)
SELECT DISTINCT path FROM walk;
```

## `context_bundle` 内部フロー

1. **一次候補収集**: goal/failing_tests/last_diff など入力からキーワードを抽出し文字列マッチを行う。
2. **増補**: 依存クロージャ（深さ 1–2）やパス近接で不足断片を追加する。
3. **再ランキング**: VSS が有効な場合のみ `semantic_rerank` を適用する。
4. **断片化**: シンボル境界で行範囲を最小化し重複を統合する。
5. **出力生成**: why（根拠タグ、最大10件）を付与し、`includeTokensEstimate: true` が指定されたときのみ tokens_estimate を添えて返却する。

## グラフレイヤー統合（v0.15.0+）

### 依存グラフスコアリング

依存関係グラフは静的解析により抽出され、以下のメトリクスをスコアリングに活用します:

| パラメータ        | デフォルト値 | 説明                                                                   |
| ----------------- | ------------ | ---------------------------------------------------------------------- |
| `graphInbound`    | 0.5          | 被参照度スコア（このファイルを参照しているファイル数に基づくブースト） |
| `graphImportance` | 0.3          | PageRank風重要度スコア（依存グラフの中心性に基づくブースト）           |
| `graphDecay`      | 0.5          | 深さ減衰係数（深いノードほどスコアが減衰）                             |
| `graphMaxDepth`   | 3            | BFSトラバーサルの最大深度                                              |

**スコア計算:**

```
graphScore = graphInbound * log(1 + inbound_count) * decay^depth
           + graphImportance * importance_score
```

### Co-changeグラフスコアリング

Co-changeグラフはGit履歴から抽出され、一緒に変更されることの多いファイルペアを識別します:

| パラメータ | デフォルト値 | 説明                                              |
| ---------- | ------------ | ------------------------------------------------- |
| `cochange` | 3.0          | Co-changeスコアの重み（v0.15.0+でデフォルト有効） |

**不変条件（Alloy/TLA+仕様より）:**

- **CC1**: 正規順序（file1 < file2 辞書順）
- **CC2**: 両ファイルがインデックス済み
- **CC3**: 正の重み（cochange_count > 0）
- **CC4**: べき等コミット処理

**スコア計算:**

```
cochangeScore = cochange * log(1 + count) * confidence
```

ここで:

- `count`: 一緒にコミットされた回数
- `confidence`: Jaccard類似度 = |A ∩ B| / |A ∪ B|

### Co-changeの動作

Co-changeはv0.15.0以降、デフォルトで有効（`cochange: 3.0`）です。

Co-changeは `editing_path` が指定されている場合にのみ効果があります（編集中のファイルと一緒に変更されることの多いファイルをブースト）。

**無効化する場合**は `config/scoring-profiles.yml` で `cochange: 0.0` に設定:

```yaml
default:
  cochange: 0.0 # Co-changeスコアを無効化
```

## ハイブリッド検索の融合方式

KIRI は**加重線形結合（Weighted Linear Combination）**方式を採用しています。

### 採用方式: 加重線形結合

```
finalScore = Σ (weight_i × signal_i)
```

各シグナル（textMatch, pathMatch, graphInbound, cochange など）にプロファイル固有の重みを適用し、合計スコアを計算します。

**メリット:**

- シンプルで解釈しやすい
- 重みの調整でドメイン知識を反映可能
- 計算コストが低い
- プロファイルによる柔軟な切り替え

**デメリット:**

- 最適な重み設定にチューニングが必要
- シグナル間のスケール正規化が必要

### 代替方式との比較

| 方式                             | 説明                                                             | トレードオフ                                      |
| -------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------- |
| **RRF (Reciprocal Rank Fusion)** | `1/(k + rank_i)` の合計でランキングを統合                        | パラメータ `k` の設定が難しい、スコア情報を捨てる |
| **Query Expansion**              | クエリを関連語で拡張してから検索                                 | Recall向上するがPrecision低下のリスク             |
| **Two-Stage Reranking**          | 第1段階で候補収集、第2段階でLLM/クロスエンコーダーで再ランキング | 高精度だがレイテンシ・コスト増加                  |

### なぜ加重線形結合を選択したか

1. **解釈可能性**: 各シグナルの寄与が明確
2. **チューニング容易性**: YAMLで重みを調整可能
3. **低レイテンシ**: 追加のモデル呼び出しが不要
4. **段階的改善**: 新シグナル（VSS、グラフなど）を追加しやすい

VSS（ベクトル類似度検索）はオプションの二次再ランキングとして提供されており、`semantic_rerank` で Two-Stage アプローチも可能です。

## 運用メモ（Precision調整の注意）

- path_penalties は `.kiri/config.yml` または `config/kiri.yml` で上書き可能。拡張ディレクトリや fixtures/datasets を強く減衰させるときは Recall 影響を確認すること。
- fallback:path の候補は text evidence が無い場合に除外されるよう設定してある（KEEP=8）。TRACE で `penalty:fallback-no-text` が多いときはパスヒントを追加するのが効果的。
- **グラフレイヤー**: `graphInbound` や `cochange` の重みを高くすると、依存関係の深いファイルが優先される。実装詳細を探す場合に有効。
- **Co-change注意点**: Co-changeはGit履歴に依存するため、新規ファイルや履歴の浅いリポジトリでは効果が限定的。
