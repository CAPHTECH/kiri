# セキュリティとコンプライアンス

## 基本方針

- **Denylist** を標準 ON（`secrets/`, `*.pem`, `*.key`, `.env*`, `config/*.prod.*` など）。
- **機密検出**: 高エントロピー文字列や既知の鍵パターンを検知し、格納拒否またはマスキングを実施する。
- **MCP 出力制御**: ツール単位で生本文返却禁止や要約のみ返却を選択できるポリシを整備する。
- **DB 暗号化**: 少なくともファイルシステムレベルで暗号化し、DuckDB の暗号化オプションも検討する。
- **監査ログ**: 外部 LLM に渡したパスと行範囲を記録し、週次レビューを義務化する。

## Denylist 初期値

```
secrets/**, **/*.pem, **/*.key, **/.env*, **/config/*.prod.*, **/node_modules/**,
**/build/**, **/dist/**, **/.git/**, **/*.sqlite, **/*.duckdb, **/*.db
```

**パターン検証**: Denylist パターンは glob 構文をサポートし、`*`（ワイルドカード）と `**`（再帰マッチ）を使用できる。
パターンは起動時に検証され、以下の制限が適用される：

- 最大長: 500文字
- 複雑度: 3個以上の量指定子（`*`, `+`, `{}`）を含むパターンは拒否される（ReDoS対策）

不正なパターンが検出された場合、インデクサーは起動時にエラーを返す。

## セキュリティ設定と検証フロー

- 運用時の権限境界は `config/security.yml` に定義する。`allowed_paths`、`allow_network_egress`、`allow_subprocess` を明示し、
  `sensitive_tokens` にはマスキング対象のトークン接頭辞を列挙する。
- **スキーマ検証**: 設定ファイルは起動時に Zod スキーマで検証され、必須フィールドの欠落や型エラーがあればサーバー起動をブロックする。
- 設定ファイルの改ざんを検知するため、DuckDB ファイル (`index.duckdb`) と同じディレクトリに `security.lock` を保存し、SHA-256
  ハッシュを照合する。差分がある場合はサーバー起動前にブロックされる。
- CLI から `pnpm exec tsx src/client/cli.ts security verify --db <path/to/index.duckdb> --write-lock` を実行すると現在の設定を検証し、
  ロックファイルが存在しなければ生成する。パスを省略した場合は `--db var/index.duckdb` が既定値となる。
- CI では `pnpm exec tsx src/client/cli.ts security verify --db <path/to/index.duckdb>` を最初のステップとして実行し、差分がないことを
  保証する。

## MCP 応答のマスキング

- `src/shared/security/masker.ts` でマスキングユーティリティを提供し、`context_bundle` などサーバー側で返却するすべてのペイロード
  に対して `***` へ置換する。
- **ReDoS 対策**: マスキングパターンは起動時に検証され、長さ（最大100文字）と複雑度（ネストした量指定子の禁止）がチェックされる。
  悪意のあるパターンによる CPU 使用率の急上昇を防止する。
- マスキング件数はメトリクス (`/metrics`) に `kiri_mask_applied_total` として公開され、運用監視で確認できる。
- 監査ログ (`scripts/audit/export-log.ts`) からエクスポートされる JSON もマスキング済みフィールドのみを含む。

## Degrade 発生時の運用ポリシー

- DuckDB/VSS が利用できない場合、`--allow-degrade` フラグを付けてサーバーを起動するとファイル検索のみ許可するセーフモードに
  移行する。その他ツールは 503 を返す。
- Degrade 状態は `/metrics` のレスポンスタイム増加と監査ログのイベントで検知できる。復旧後はサーバーを再起動して通常モードに
  戻す。
