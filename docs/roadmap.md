# 実装マイルストーンと依存関係

## マイルストーン

1. **M0 (2–3日)**: `file/blob/tree` 取り込み、`files_search`、`snippets_get`（シンボルなし固定チャンク）。
2. **M1 (1–2週)**: tree-sitter 導入で `symbol` / `snippet` をシンボル境界化し、`deps_closure` を追加。
3. **M2 (1週)**: `context_bundle`（文字列/依存/近接ベース）と評価基盤（P@k / TTFU）を整備。
4. **M3 (1–2週)**: VSS を追加し `semantic_rerank` とプロファイル別重みを実装。
5. **M4 (1週)**: セキュリティ、denylist、マスキング、可観測性、Degrade 周りを仕上げる。

### M4 の詳細タスク

1. **セキュリティ境界と設定の固定化**
   - `config/security.yml` を追加し、エージェント実行時の権限、アクセス可能なパス、ネットワーク出口の有無を明示する。
   - `src/server/bootstrap.ts` に起動時バリデーションを実装し、設定の署名ハッシュを `var/security.lock` と比較して改ざんを検知する。
   - CLI (`src/client/cli.ts`) からは `security.verify` サブコマンドで現在の適用状況と差分をレポート可能にする。

2. **denylist の二重適用とテスト**
   - `config/denylist.yml` に `secrets/**`、`*.pem`、`.env*` などを定義し、`src/indexer/pipeline/filters/denylist.ts` で Git 走査と DuckDB 取り込み前にフィルタリングする。
   - 既存の `.gitignore` パターンを読み込む仕組みを追加し、両者の差分がないか `pnpm run diag -- check-denylist` で検証できるようにする。
   - `tests/indexer/denylist.spec.ts` を作成し、除外対象がメタデータにも残らないことを保証する。

3. **マスキングとレスポンス監査**
   - `src/server/tools/contextBundle.ts` などの MCP 応答で `path`, `content` に機密トークンが含まれる場合は `***` に置換するユーティリティを `src/shared/security/masker.ts` に実装。
   - `scripts/audit/export-log.ts` の出力にマスキング済みフィールドが含まれているか検証し、`tests/server/audit.spec.ts` で差分検知する。
   - コンテキスト共有時は `var/audit/` 以下に行範囲ログを保存し、30 日でローテートする仕組みを cron スクリプトに追加する。

4. **可観測性 (Observability)**
   - `src/server/observability/metrics.ts` を追加し、Prometheus 形式の HTTP エンドポイント `/metrics` を提供する。主要メトリクスはリクエスト数、レスポンスタイム、マスク適用件数、denylist ヒット数。
   - OpenTelemetry のトレースを `src/server/main.ts` へ導入し、`context_bundle` など主要ツールの span を発行する。
   - `scripts/diag/health.ts` でメトリクスとトレースの疎通確認を自動化し、CI では `pnpm run diag -- health` を追加する。

5. **Degrade / フォールバック戦略**
   - `src/server/fallbacks/degradeController.ts` を新設し、DuckDB や VSS が利用できない場合にファイル検索のみで応答するモードを定義する。
   - フォールバック発生時は観測メトリクスと監査ログにイベントを記録し、CLI では `--allow-degrade` フラグで明示的に許可する設計にする。
   - `tests/server/degrade.spec.ts` で DuckDB 接続エラー時に graceful degrade することを確認する。

6. **ドキュメントと運用手順**
   - `docs/security.md` に設定方法、マスキング仕様、監査ログの読み方を追記する。
   - 運用 runbook (`docs/runbook.md`) に Degrade 発生時の復旧手順と観測項目の確認方法を追加する。
   - 週次レビュー向けに `docs/processes/security-review.md` を作成し、エクスポートログのチェックリストを整理する。

## 依存関係

- **ランタイム**: Node.js 20+（TypeScript ESM / pnpm 管理 / MCP サーバーも同言語で統一）。
- **ツール**: git、pnpm、tree-sitter CLI（ctags 代替可）、tsx、vitest、eslint、prettier。
- **ライブラリ候補**: duckdb-node / duckdb-wasm（用途で選択）、tree-sitter-<langs>、埋め込み器（e5/jina/instructor 等）。
