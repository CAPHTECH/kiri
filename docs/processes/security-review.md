# セキュリティレビュー手順

## 週次レビューの目的

- エクスポートログの棚卸しと、機密情報のマスキング状況を確認する。
- Denylist と `.gitignore` の差分を把握し、不要なファイルがインデックスされていないかを検証する。
- Degrade イベントの有無を確認し、再発防止のアクションを洗い出す。

## チェックリスト

1. `pnpm exec tsx scripts/diag.ts check-denylist` を実行し、差分が空であることを確認する。
2. `var/audit/` 配下の最新ログを開き、`path` / `rationale` に `***` マスキングが適用されていることを確認する。
3. `/metrics` の `kiri_mask_applied_total` と `kiri_denylist_hits_total` を記録し、前週からの増減をトレンドとして残す。
4. `pnpm exec tsx src/client/cli.ts security verify --db <path/to/index.duckdb>` を実行し、`state: MATCH` を確認する。
5. 重大な異常が見つかった場合はインシデントチケットを起票し、runbook の手順で対応する。

## 記録テンプレート

- レビュー日:
- 担当者:
- Denylist 差分:
- マスキング件数 (前回比):
- Degrade イベント有無:
- 対応アクション:
