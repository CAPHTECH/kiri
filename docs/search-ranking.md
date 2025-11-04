# 検索とランキング

## 方針

- **一次候補**は文字列一致・シンボル名・依存・パス近接・直近変更など決定的特徴で高速抽出する。
- **FTSハイブリッド検索**: DuckDB FTS拡張が利用可能な場合はBM25ランキングを使用、利用不可の場合はILIKEフォールバックで動作する（Degrade-First Architecture）
- **複数単語クエリ**: 空白・スラッシュ・ハイフン・アンダースコアで単語分割し、OR検索ロジックで柔軟にマッチする
- **ファイルタイプブースト**: 実装ファイル（src/_.ts）を優遇し、ドキュメントファイル（_.md）を減点することで、検索精度を向上
- **二次再ランキング**ではオプションの VSS を利用し、概念的な近さを加点する。
- **目的別プロファイル**（bugfix/testfail/refactor/typeerror/feature）で重み付けを切り替える。

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

## スコア計算例

```
score = w_sem  * semantic_sim          -- VSS 1 - distance（無効可）
      + w_path * path_proximity        -- 同モジュール/同ディレクトリ
      + w_dep  * dep_distance_score    -- 依存距離(0/1/2)
      + w_rec  * recentness            -- 直近変更・last_touched
      + w_sym  * symbol_overlap        -- 関数/型名・シグネチャ一致
```

既定プロファイル例:

- bugfix: w_sem=0.25, w_path=0.25, w_dep=0.25, w_rec=0.15, w_sym=0.10
- testfail: w_sem=0.20, w_path=0.20, w_dep=0.30, w_rec=0.20, w_sym=0.10
- typeerr: w_sem=0.15, w_path=0.25, w_dep=0.20, w_rec=0.10, w_sym=0.30

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
