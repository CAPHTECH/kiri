# 運用 Runbook

## Degrade 発生時の復旧手順

1. `/metrics` を確認し、`kiri_http_requests_total` の伸びと 503 レスポンスが増えていないかを確認する。
2. 監査ログ (`var/audit/*.json`) を開き、直近の `degrade` イベントと対象リポジトリを確認する。
3. `pnpm exec tsx src/client/cli.ts security verify --db <path/to/index.duckdb>` を実行し、セキュリティロックに改ざんがないことを確認する。
4. DuckDB/VSS プロセスのヘルスチェックを行い、必要であれば再起動する。
5. 復旧が完了したらサーバーを `--allow-degrade` なしで再起動する。復旧完了後に `/metrics` のレスポンスから `degrade: true`
   が含まれないことを確認する。

## 観測項目

### Prometheus メトリクス（`/metrics` エンドポイント）

サーバーは `http://localhost:8765/metrics` で Prometheus 形式のメトリクスを公開する。以下の指標を監視する：

- **`kiri_http_requests_total`**: 処理された JSON-RPC リクエストの総数
  - 異常: 急激な減少（サービス停止の可能性）または異常な増加（攻撃の可能性）
- **`kiri_mask_applied_total`**: 機密データのマスキング件数
  - 異常: 急増した場合は流出を疑い監査を実施する
- **`kiri_denylist_hits_total`**: インデックス除外の件数
  - 異常: 設定値と `.gitignore` の差分がないか `pnpm exec tsx scripts/diag.ts check-denylist` で確認する
- **`kiri_request_duration_ms`**: JSON-RPC リクエストの累積処理時間（ミリ秒）
  - 異常: 急増時は DuckDB/VSS の負荷を調査する

**推奨アラート設定**:

- リクエスト処理時間の平均が 1000ms を超える場合
- マスキング件数が通常の 10倍を超える場合
- Denylist ヒット率が 50% を超える場合（設定ミスの可能性）

### OpenTelemetry トレーシング

OpenTelemetry が利用可能な環境では、各リクエストにスパンが記録され、以下の情報が含まれる：

- **成功時**: span status code = 1 (OK)
- **失敗時**: span status code = 2 (ERROR)、エラー属性（`error.type`, `error.message`, `error.stack`）

トレースデータは Jaeger、Zipkin、Datadog などの APM ツールで可視化できる。

**トラブルシューティング**:

1. エラースパンでフィルタリングして失敗オペレーションを特定
2. `error.stack` 属性からスタックトレースを確認
3. スパンの継続時間から性能ボトルネックを発見
