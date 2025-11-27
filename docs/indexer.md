# 取り込みパイプライン（Indexer）

## ステップ概要

1. **ワークツリー列挙**: `git ls-files --recurse-submodules` を用いつつ ignore を尊重し、サブモジュール配下も含めてファイルを取得する。
2. **メタデータ推定**: 拡張子から言語判定し、サイズ・mtime・バイナリ判定（ヌルバイト/閾値）を取得する。
3. **blob/tree 生成**: blob をハッシュで重複排除し、HEAD 時点の path→blob 対応を保持する。
4. **シンボル抽出**: TypeScript (TypeScript Compiler API)、Swift (tree-sitter)、PHP (tree-sitter) で定義・範囲・シグネチャを抽出する。
   - **TypeScript**: `class`, `interface`, `enum`, `function`, `method`
   - **Swift**: `class`, `struct`, `protocol`, `enum`, `extension`, `func`, `init`, `property`
   - **PHP**: `class`, `interface`, `trait`, `function`, `method`, `property`, `constant`, `namespace` (pure PHPおよびHTML混在PHPの両方をサポート)
5. **依存解決**: TypeScript プラグイン（`tsconfig` の paths/alias、`package.json` exports、`pnpm-workspace`）と Swift (`import` 文解析）を基準にし、他言語プラグインは後続拡張とする。
6. **snippet 切り出し**: 原則シンボル境界を用い、特定できない場合のみ 120–200 行のスライディングウィンドウを適用する。
7. **埋め込み生成（任意）**: snippet 単位で埋め込みを計算し `snippet_embedding` テーブルへ格納する。
8. **履歴・blame 更新**: 差分ファイルのみ更新し、フル再計算は週次などバッチで実施する。
9. **ステージング投入**: 小刻み書き込みを避け、ステージング→バッチマージでトランザクションをまとめる。

## Co-changeグラフ抽出（v0.15.0+）

インデックス作成時にGit履歴を解析し、一緒に変更されることの多いファイルペアを`cochange`テーブルに記録します。

### 動作

- **デフォルト有効**: Co-changeデータはフラグなしで自動的に投入されます
- **スキップ**: `--no-cochange`フラグでCo-change計算をスキップ可能
- **インクリメンタル更新**: `--since`モードでも新規コミットのCo-change関係を追加

### 設定パラメータ

| パラメータ          | デフォルト値 | 説明                                 |
| ------------------- | ------------ | ------------------------------------ |
| `maxCommits`        | 1000         | 解析する最大コミット数               |
| `minCochangeCount`  | 2            | 保存する最小Co-change回数            |
| `maxFilesPerCommit` | 50           | メガコミットを除外するファイル数上限 |
| `maxAgeDays`        | 365          | 解析対象とする日数                   |

### 不変条件

- **CC1**: 正規順序（file1 < file2 辞書順）
- **CC2**: 両ファイルがインデックス済み
- **CC3**: 正の重み（cochange_count > 0）
- **CC4**: べき等コミット処理（同一コミットは再処理しない）

### スキーマ

```sql
CREATE TABLE cochange (
  repo_id INTEGER,
  file1 TEXT,
  file2 TEXT,
  cochange_count INTEGER NOT NULL,
  confidence FLOAT,  -- Jaccard類似度
  last_commit TEXT,
  last_cochange_at TIMESTAMP,
  PRIMARY KEY (repo_id, file1, file2)
);
```

## 実行モード

- CLI: `kiri index --repo /path/to/repo --db /path/to/index.duckdb [--full | --since <commit>] [--no-cochange]`
- トリガ: pre-commit / post-merge hook / ファイル監視からの自動起動

### CLIオプション

| オプション      | 説明                                                   |
| --------------- | ------------------------------------------------------ |
| `--repo`        | インデックス対象のリポジトリパス（デフォルト: `.`）    |
| `--db`          | DuckDBファイルパス（デフォルト: `var/index.duckdb`）   |
| `--full`        | 全ファイルを再インデックス                             |
| `--since`       | 指定コミット以降の変更のみインクリメンタルインデックス |
| `--watch`       | ファイル監視モードで継続実行                           |
| `--debounce`    | watchモードのデバウンス時間（ミリ秒、デフォルト: 500） |
| `--no-cochange` | Co-changeグラフの計算をスキップ                        |

## 疑似コード（TypeScript）

```ts
import { connect } from "duckdb";

export async function indexRepo(repoRoot: string, dbPath: string) {
  const db = await connect(dbPath);
  const files = await gitLsFiles(repoRoot);

  const stage: Array<[string, ...unknown[]]> = [];
  for (const filePath of files) {
    const meta = await statAndLang(filePath);
    if (meta.isBinary) continue;
    const content = await readText(filePath);
    const hash = hashContent(content);
    stage.push(["blob", hash, content.length, content.split(/\r?\n/).length, content]);
    stage.push(["file", filePath, hash, meta.ext, meta.lang, false, meta.mtime]);
  }

  await db.transaction(async (trx) => {
    await upsertBlobsAndFiles(trx, stage); // まとめて投入
    await extractSymbolsAndDeps(trx, repoRoot, files); // tree-sitter
    await cutSnippetsAndEmbeddings(trx, repoRoot); // 任意で VSS
  });
}
```
