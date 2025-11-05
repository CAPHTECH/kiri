# 検索とランキング

## 方針

- **一次候補**は文字列一致・シンボル名・依存・パス近接・直近変更など決定的特徴で高速抽出する。
- **FTSハイブリッド検索**: DuckDB FTS拡張が利用可能な場合はBM25ランキングを使用、利用不可の場合はILIKEフォールバックで動作する（Degrade-First Architecture）
- **フレーズ認識トークン化**: ハイフン区切り用語（例: `page-agent`）を単一ユニットとして保持し、引用符で囲まれたフレーズ（例: `"oauth handler"`）を正確にマッチする
- **パスベーススコアリング**: キーワードやフレーズがファイルパス内に現れる場合に追加ブーストを適用
- **ファイルタイプブースト**: 実装ファイル（src/\*.ts）を優遇し、ドキュメントファイル（\*.md）を減点することで、検索精度を向上
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
contextBundle({ goal: "lambda/page-agent/handler implementation" });
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

`boost_profile` パラメータで3つのモードを選択可能:

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

#### boost_profile: "none"

ファイルタイプによるブースト無効、純粋なBM25スコアのみ

### 使用例

```typescript
// 実装ファイルを探す（デフォルト）
filesSearch({ query: "tryCreateFTSIndex" });
// → src/*.ts が上位に

// ドキュメントを探す
filesSearch({ query: "setup instructions", boost_profile: "docs" });
// → *.md が上位に

// 純粋なBM25スコア
filesSearch({ query: "authentication", boost_profile: "none" });
// → ファイルタイプ関係なく、BM25スコアのみ
```

### ブラックリスト動作（v0.9.0+）

以下のディレクトリはデフォルトプロファイルで強いペナルティ（score = -100）が適用されます:

| ディレクトリ        | デフォルトプロファイル | `boost_profile: "docs"` | 説明                                     |
| ------------------- | ---------------------- | ----------------------- | ---------------------------------------- |
| `docs/`             | ❌ score = -100        | ✅ **除外可能**         | ドキュメント専用ディレクトリ             |
| `tests/`, `test/`   | ❌ score = -100        | ❌ score = -100         | テストファイル（常にペナルティ）         |
| `node_modules/`     | ❌ score = -100        | ❌ score = -100         | 依存関係（常にペナルティ）               |
| `.git/`, `.cursor/` | ❌ score = -100        | ❌ score = -100         | メタデータディレクトリ（常にペナルティ） |
| `dist/`, `build/`   | ❌ score = -100        | ❌ score = -100         | ビルド成果物（常にペナルティ）           |
| `coverage/`, `tmp/` | ❌ score = -100        | ❌ score = -100         | 一時ファイル（常にペナルティ）           |

**重要な動作変更（v0.9.0）:**

- ✅ **`boost_profile: "docs"` を指定すると `docs/` ディレクトリのブラックリストが解除される**
- これにより、ドキュメント検索が正しく機能するようになりました（v0.7.0で主張された動作が実際に動作するように修正）
- 他のブラックリストディレクトリ（`tests/`、`node_modules/` など）は常にペナルティが適用されます

**使用例:**

```typescript
// デフォルトプロファイル: docs/ はブラックリスト
contextBundle({ goal: "feature guide" });
// → docs/guide.md は除外される（score = -100）

// docsプロファイル: docs/ のブラックリストを解除
contextBundle({ goal: "feature guide", boost_profile: "docs" });
// → docs/guide.md が正常にランク付けされる（✅ v0.9.0で修正）
```

## スコア計算例

`context_bundle` で使用される総合スコアは以下の要素から計算されます:

```
score = textMatch * (keyword_matches + phrase_matches * 2.0)  -- テキストマッチ（フレーズは2倍）
      + pathMatch * path_boost                                 -- パスベースブースト
      + editingPath * editing_boost                            -- 編集中ファイル
      + dependency * dep_score                                 -- 依存関係
      + proximity * proximity_score                            -- 近接度（同ディレクトリ）
      + structural * semantic_sim                              -- 構造的類似度（LSHベース）
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
5. **出力生成**: why（根拠タグ）と tokens_estimate を添えて返却する。
