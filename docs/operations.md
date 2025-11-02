# 運用と可観測性

## SLO とメトリクス

- **SLO**
  - `context.bundle` P95 を **≤ 1000ms** に維持する。
  - 初回フル索引を **1M 行/10分** 以内で完了させる。
  - 差分取り込みを **5 分バッチ / P95 1 分未満** に抑える。
- **モニタリング対象**
  - Indexer: 走査数/分、blob 重複率、再構築時間。
  - MCP: ツール別レイテンシ／エラー率、Degrade 発動回数。
  - 検索品質: P@k、NDCG、TTFU、Token 削減率。

## 失敗モードと Degrade 戦略

- **拡張ロード失敗（FTS/VSS）**: 文字列検索＋構造近接のみで結果を返却し、VSS を無効化。
- **DuckDB ロック衝突**: 読み込みは許可し、書き込みはステージング→バッチに統一して再試行。
- **依存解決不能**: `dst_kind="package"` として保持し、パス近接の重み付けを増やす。
- **blame 計算コスト増**: 差分のみ逐次更新し、巨大ファイルは週次フル再計算に限定する。

## npm 公開フロー

1. `pnpm install` → `pnpm run check` を実行し、Lint とテストがすべて成功することを確認する。
2. `package.json` の `version` を SemVer に従って更新し、変更点を `CHANGELOG.md`（追記が必要な場合）へ反映する。
3. `pnpm run build` を実行して `dist/` を再生成し、`git status` で不要な生成物が残っていないか検証する。
4. `npm login`（初回のみ）後、公開アクセスの場合は `pnpm publish --access public` を実行する。プライベート公開の場合は `--access restricted` を指定する。
5. 公開完了後にタグ付け `git tag v<version>` → `git push origin --tags` を行い、GitHub Release と npm のバージョンを同期させる。
6. パッケージをグローバルインストールして動作確認 (`npm install -g kiri-mcp-server` → `kiri-server --help`) を行い、問題があれば速やかに `npm deprecate` とパッチリリースで対処する。
