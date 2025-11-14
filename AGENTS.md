# Repository Guidelines

## プロジェクト構成とモジュール整理

本レポジトリの設計知は `docs/overview.md` を起点としたテーマ別ドキュメントに分割されています。TypeScript での実装を追加する際は `src/indexer/`（Git 走査と DuckDB 取り込み）、`src/server/`（MCP サーバー）、`src/client/`（CLI や Codex 用ユーティリティ）を基本フォルダとし、共通ロジックは `src/shared/` に集約してください。設定スキーマは `config/` に YAML で格納し、型定義を `types/` へ配置します。生成物や DuckDB のワークファイルは `var/` 以下にまとめ、テストは対象モジュールを鏡写しにした `tests/indexer/*.spec.ts` などへ置いてください。

GitHubを利用している。IssueはGitHubで管理している。

GitHub: CAPHTECH/kiri

## ビルド・テスト・開発コマンド

Node.js 20 と pnpm を前提とします。主要コマンドは以下のとおりです。

- `pnpm install`: 依存関係を解決し、`node_modules` を整備します。
- `pnpm run build`: `tsc --noEmit false` で `dist/` に ESM を出力します。
- `pnpm run dev`: `tsx src/server/main.ts --port 8765` を起動しホットリロードを有効化します。
- `pnpm run lint`: `eslint "src/**/*.{ts,tsx}"` と `prettier --check` を実行します。
- `pnpm run test`: `vitest run --coverage` を呼び出し、閾値 `lines ≥ 0.8` を確認します。
- `pnpm run check`: `pnpm run lint` と `pnpm run test` をまとめて実行します。
  開発で固定化した診断コマンドは `scripts/diag.ts` に関数として追加し、`pnpm exec tsx` で再利用してください。

## コーディングスタイルと命名

TypeScript 5 系を採用し、インデントは 2 スペース、セミコロンは常に付与します。変数・関数は `camelCase`、クラスと型は `PascalCase`、定数は `SCREAMING_SNAKE_CASE` を用いてください。`tsconfig.json` の `strict` と `noUncheckedIndexedAccess` は必ず有効化し、`eslint-config-standard-with-typescript` と `prettier` を pre-commit で実行します。SQL 定義は `sql/` に `.sql` 拡張子で保存し、キーワードは大文字、識別子は `snake_case` に統一します。MCP ツール名は `<領域>.<動詞>`（例: `context_bundle`）の形式とし、例外メッセージは「原因→対処」を 2 文で記述してください。

## テスト指針

テストは `vitest` を標準とし、`tests/server/context_bundle.spec.ts` のように対象モジュールを明示する命名を徹底します。DuckDB を利用するテストは `tmp` ディレクトリにワークファイルを生成し、`afterEach` で削除してください。検索品質など長時間の評価は `tests/eval/*.spec.ts` にゴールデンデータを置き、P@10 と TTFU をメトリクスとして `vitest --runInBand` で収集します。Pull Request では新規機能に対して 80% 以上のステートメントカバレッジを確保してください。

## コミットとプルリクガイド

Conventional Commits を必須とし、例として `feat(server): expose semantic rerank` や `chore(deps): bump duckdb-wasm` の形式を用います。1 コミットで 1 論点を守り、生成物や `var/` 配下は含めないでください。Pull Request では「目的」「実装概要」「検証手順」「残課題」を見出しとして記載し、関連 Issue があれば `Closes #番号` で紐付けます。レビュー依頼前に `pnpm run check` の結果をログで共有し、性能差分がある場合はベンチ結果を表形式で添付してください。

## セキュリティと設定メモ

denylist（`secrets/**`, `*.pem`, `.env*` など）は `.gitignore` と indexer 内のフィルタで二重に適用してください。DuckDB ファイルは暗号化ディスク上の `var/index.duckdb` を既定にし、MCP 応答では機密パスを `***` へマスクします。外部へのコンテキスト共有時は `scripts/audit/export-log.ts` を経由して行範囲ログを残し、週次でレビューしてください。依存更新時は `pnpm up --latest` を `scripts/update-deps.ts` 経由で実行し、差分と署名確認結果を PR コメントで共有する方針を維持します。

## MCP サーバー運用メモ

- `pnpm run dev` や `scripts/assay/*` から `src/server/main.ts` を起動すると、ポート `19999` / `20099` のサーバープロセスが常駐します。**複数同時起動やプロセス放置は禁止**です。作業前後に `ps aux | grep 'src/server/main.ts'` を確認し、不要な Node プロセスは `kill` で停止してください。古いプロセスが残ると検索結果が更新されず、Assay も古い挙動を報告します。
- DuckDB を更新するジョブ（`pnpm exec tsx src/indexer/cli.ts ...` や `pnpm run assay:*`）を実行する際は、必ず上記のサーバープロセスを全て停止した状態で行います。起動中のままインデクサを走らせると `var/index.duckdb.lock` が残り、`Database was already closed` のまま復旧できなくなります。
- もし手動でロック解除が必要になった場合は、**プロセス停止 → `rm var/index.duckdb.lock` → `pnpm exec tsx src/indexer/cli.ts --full`** の順でのみ実施してください。ロック解除前にプロセスを殺さないとデータ破損につながります。
