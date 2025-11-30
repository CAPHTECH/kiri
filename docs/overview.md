---
doc_id: "ARCH-001"
title: "KIRI 概要"
category: "architecture"
tags:
  - overview
  - architecture
  - docs
  - llm
service: "kiri"
---

# KIRI 概要

## 基本情報

- **バージョン**: v0.1 (Draft)
- **更新日**: 2025-10-28
- **オーナー**: りずさん
- **目的**: Git ワークツリーの構造・履歴・近接・意味を合成し、LLM 向けに最小限の文脈断片を即時返却するプラットフォームを構築する。
- **推奨 Node バージョン**: 20.x (LTS)

## 用語

- **Indexer**: Git ワークツリーを走査して DuckDB に書き込む取り込みプロセス。
- **MCP Server**: KIRI の検索機能を MCP（JSON-RPC over stdio/HTTP）ツールとして提供するサーバー。
- **Client**: Codex CLI など MCP ツールを呼び出すクライアント。
- **断片（Snippet）**: 関数やクラスなど意味境界に沿って抽出した行範囲。

## 関連ドキュメント

- [運用 Runbook](./runbook.md#運用-runbook): デグレード時の復旧と観測手順。Front matter の `tags: [operations, degrade, observability]` を使用。
- [検索とランキング指針](./search-ranking.md#検索とランキング): `boost_profile` やメタデータブーストの詳細。
- [テストと評価](./testing.md#テストと評価): ゴールデンセットやカバレッジ指標の延長戦ガイド。

## メトリクス/観測

- Prometheus exporter は `src/server/observability/metrics.ts` で登録。
- Adaptive K 関連: `adaptive_k_selected_total{enabled,category,k}`（選択Kの分布）、
  `adaptive_k_deviation_total{category,requested}`（ユーザ指定limitがallowedSet外のとき）。

## 目標と非目標

### 目標

- **P@10 ≥ 0.7**: 上位 10 断片中 7 つ以上が実務で有用。
- **TTFU ≤ 1.0s**: ローカル実行で初回有用断片を 1 秒以内に返却。
- **Token 削減 ≥ 40%**: 従来の貼り付け方式と比較してプロンプトトークンを 40%以上削減。
- **Degrade 運転**: FTS/VSS 拡張なしでも文字列＋構造近接検索で稼働。

### 非目標

- IDE の完全代替や自動リファクタリング等の包括的コードインサイト。
- リポジトリ横断の厳密なコールグラフ生成（近似で十分）。

## 全体アーキテクチャ

```
+--------------------+     +-----------------------------+     +--------------------+
|     MCP Client     |<--->|  KIRI MCP Server (JSON-RPC) |<--->|      DuckDB        |
| (Codex CLI, etc.)  |     |  tools: search/bundle/...   |     |  index.duckdb      |
+--------------------+     +-----------------------------+     +--------------------+
                                   ^
                                   |
                         +---------+----------+
                         |      Indexer      |
                         |  git scan / AST   |
                         |  embedding (opt)  |
                         +-------------------+
```

- **Indexer** が Git から構造・履歴・本文・埋め込みを DuckDB に書き込む。
- **MCP Server** が DuckDB を叩き、`files_search` や `context_bundle` などのツールを公開する。
- **Client** は `context_bundle` で得た断片を LLM プロンプトへ注入する。

## ドメイン用語辞書

- 定義ファイル: `config/domain-terms.yml`（`.kiri/domain-terms.yml` でも可）。camelCase/スペース/アンダースコアは正規化され、ハイフン小文字＋分割トークンも生成。
- スキーマ: カテゴリ配下に `{canonical: {aliases, files}}` の配列を並べる。例は `config/domain-terms.yml` を参照。
- フィーチャーフラグ: デフォルト OFF。`KIRI_ENABLE_DOMAIN_TERMS=1` を付けて `context_bundle` サーバーを起動すると有効化され、辞書エイリアスとファイルヒントをブースト対象に追加する（`dictionary:hint:<path>` が `why` に付与）。
- 更新手順: 辞書を編集したら `pnpm exec vitest run tests/server/domain-terms.spec.ts` で構文を確認し、必要に応じて `tests/server/context.bundle.spec.ts` も併せて実行。
