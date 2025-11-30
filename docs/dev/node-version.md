---
doc_id: "GUIDE-005"
title: "Node バージョンとツールチェーン"
category: "development"
tags:
  - node
  - toolchain
  - setup
service: "kiri"
---

# Node バージョンとツールチェーン

- 推奨 Node: **20.x (LTS)**
- `.nvmrc` / `.node-version` に `v20` を記載済み。
- mise を使用する場合は `.mise.toml` に node=20 / pnpm=9 を定義済み。`mise install` で取得。
- Corepack を有効化し、pnpm@9 を使用すること。
  - `corepack enable`
  - `corepack prepare pnpm@9 --activate`
- Node 25 では duckdb の prebuilt binary が提供されず、`duckdb.node` が見つからないためテストが失敗する。必ず Node 20 環境で `pnpm install`, `pnpm run build`, `pnpm test` を実行すること。
