# 実装マイルストーンと依存関係

## マイルストーン
1. **M0 (2–3日)**: `file/blob/tree` 取り込み、`files.search`、`snippets.get`（シンボルなし固定チャンク）。
2. **M1 (1–2週)**: tree-sitter 導入で `symbol` / `snippet` をシンボル境界化し、`deps.closure` を追加。
3. **M2 (1週)**: `context.bundle`（文字列/依存/近接ベース）と評価基盤（P@k / TTFU）を整備。
4. **M3 (1–2週)**: VSS を追加し `semantic.rerank` とプロファイル別重みを実装。
5. **M4**: セキュリティ、denylist、マスキング、可観測性、Degrade 周りを仕上げる。

## 依存関係
- **ランタイム**: Node.js 20+（TypeScript ESM / pnpm 管理 / MCP サーバーも同言語で統一）。
- **ツール**: git、pnpm、tree-sitter CLI（ctags 代替可）、tsx、vitest、eslint、prettier。
- **ライブラリ候補**: duckdb-node / duckdb-wasm（用途で選択）、tree-sitter-<langs>、埋め込み器（e5/jina/instructor 等）。
