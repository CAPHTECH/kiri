---
doc_id: "GUIDE-003"
title: "Path Penalties ユーザーガイド"
category: "configuration"
tags:
  - path-penalty
  - boosting
  - config
service: "kiri"
---

# パス乗算ペナルティ設定ガイド（日本語）

## 目的

リポジトリ固有の重要／不要ディレクトリをスコアリングで優先・抑制するために、`path_penalties` を設定します。

## 設定方法（推奨: YAML）

`.kiri/config.yaml` をリポジトリルートに作成:

```yaml
path_penalties:
  - prefix: src/
    multiplier: 1.4 # src を強める
  - prefix: external/
    multiplier: 0.3 # external を弱める
```

## 環境変数での上書き

- 形式: `KIRI_PATH_PENALTY_<PREFIX_ENCODING>=<multiplier>`
- `/` は `__` にエンコード。例: `KIRI_PATH_PENALTY_src__api__=0.8`

## 優先順位（後勝ち）

`boost_profile` 定義 < 環境変数 < `.kiri/config.yaml`

## 正規化ルール

- `\` を `/` に変換し POSIX 形式へ統一。
- `../` やドライブレター（`C:\` など）は除去（リポジトリ相対のみ許容）。
- 末尾 `/` は入力にあった場合のみ維持。

## 適用と反映タイミング

- KIRI サーバー起動時に読み込み。
- プロセス起動後に `.kiri/config.yaml` や環境変数を変更した場合は、**サーバー/デーモンの再起動が必要**（キャッシュ済みのため）。

## 確認手順（最小）

1. `.kiri/config.yaml` を設定
2. サーバー/デーモンを再起動 (`kiri --repo . --db .kiri/index.duckdb --watch` など)
3. `context_bundle` / `files_search` でパスに応じた順位変化を確認

## トラブルシュート

- エラー例: `Path penalty prefix "..." must not contain ".."`  
  → `..` を含むパスは拒否されます。リポジトリ相対で指定してください。
- 反映されない: 設定変更後はサーバーを再起動してください（キャッシュが効きます）。
