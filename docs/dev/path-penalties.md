---
doc_id: "GUIDE-004"
title: "Path Penalties Developer Notes"
category: "configuration"
tags:
  - path-penalty
  - dev-notes
  - caching
service: "kiri"
---

# パス乗算ペナルティ開発メモ

## ロード経路とキャッシュ

- 実装: `src/server/config-loader.ts`
- マージ順: `boost_profile` 既定 → 環境変数 → `.kiri/config.yaml`（後勝ち）
- キャッシュ: `loadPathPenalties` は `(cwd, baseMultipliers, envスナップショット)` をキーにメモ化。ハンドラー側はプロファイルごとにマージ済み配列をキャッシュ。
- 設定変更を即時反映させるには **プロセス再起動が必要**（メモリキャッシュを破棄するため）。ホットリロードは未対応。

## 正規化仕様

- `\` → `/` に統一し POSIX 化。
- 先頭の `/` やドライブレターは削除し、`..` を含むパスはエラーで拒否。
- 末尾 `/` は入力にあった場合のみ維持。

## テスト

- ユニット: `tests/server/config-loader.spec.ts`（マージ順・正規化・エラー系）
- 統合: `tests/server/context.bundle.spec.ts` に YAML/env 反映のシナリオを追加。

## 拡張時の注意

- `PathMultiplier` を増やす場合は最長一致ロジックを壊さないようソートを維持。
- キャッシュキーは `basePathMultipliers` の内容を JSON 化しているため、可変配列を渡すと予期せぬミスキャッシュが起こる可能性あり。基本は不変配列を渡すこと。
- Windows 固有挙動を変える際は正規化仕様とユーザーガイド（`docs/user/path-penalties.md`）を合わせて更新すること。
