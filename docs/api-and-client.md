# MCP API and Client Configuration

## Overview

The server implements MCP standard endpoints `initialize` / `tools/list`, enabling AI agents to auto-detect capabilities upon startup.

## Available Tools

- `files_search(query, lang?, ext?, path_prefix?, limit=50, compact?)` - Search files by keywords; use `compact: true` to omit previews
- `symbols.find(name, kind?, path_hint?, limit=50)` - Find code symbols
- `deps_closure(paths[], direction="out"|"in", depth=2)` - Analyze dependencies
- `recent.changed(since="30d", path_prefix?)` - Find recently changed files
- `who.owns(path)` - Get ownership information from blame summary
- `snippets_get(path, start_line?, end_line?, compact?, include_line_numbers?)` - Retrieve code snippets; `compact` omits content, `include_line_numbers` prefixes each line when content is returned
- `semantic_rerank(candidates[], text, k=20)` - Semantic reranking (VSS only)
- `context_bundle(goal, artifacts, includeTokensEstimate?)` ← **Most Important**
  - `goal`: Natural language description (e.g., "Fix failing test: test_verify_token in Auth")
  - `artifacts`: {`editing_path`?, `failing_tests`?, `last_diff`?}
    - Providing `editing_path` with the file you're touching strongly boosts that file and nearby dependencies, returning a cohesive set of related files.
  - Output: Fragment list (path, [start,end], why[], score, optional preview) and `tokens_estimate` **only** when `includeTokensEstimate: true`

## `context_bundle` Request/Response Example

```json
// request
{
  "method": "context_bundle",
  "params": {
    "goal": "fix failing test: JwtVerifier rejects expired tokens",
    "artifacts": {
      "editing_path": "src/auth/jwt.ts",
      "failing_tests": ["AuthJwtSpec#rejectsExpired"],
      "last_diff": "..."
    },
    "includeTokensEstimate": true
  }
}

// response
{
  "context": [
    {
      "path": "src/auth/jwt.ts",
      "range": [12, 78],
      "why": ["symbol:verifyToken", "dep:src/auth/keys.ts", "recent:7d"],
      "score": 0.86,
      "preview": "function verifyToken(token:string){...}"
    },
    {
      "path": "src/auth/keys.ts",
      "range": [1, 120],
      "why": ["dep<-jwt.ts"],
      "score": 0.74
    }
  ],
  "tokens_estimate": 1450
}
```

> `tokens_estimate` is only present when you pass `includeTokensEstimate: true`. Skipping it avoids the extra DuckDB reads required for token estimation.

## Token Optimization: `compact` Mode

Using the `compact` parameter in `context_bundle` can reduce token consumption by **approximately 95%**.

### Recommended: Two-Tier Workflow

```javascript
// Step 1: Get candidate files (compact mode)
const result = await context_bundle({
  goal: "User authentication handler logic, runtime execution flow, Mastra integration",
  limit: 10,
  compact: true, // Get metadata only: path, range, why, score
});

// Step 2: Fetch details for selected files only
for (const item of result.context.slice(0, 3)) {
  const content = await snippets_get({
    path: item.path,
    start_line: item.range[0],
    end_line: item.range[1],
  });
  // Perform detailed analysis with content
}
```

### Token Consumption Comparison

| Mode                               | Tokens  | Information Included                 |
| ---------------------------------- | ------- | ------------------------------------ |
| `compact: true` (default, v0.8.0+) | ~2,500  | path, range, why, score              |
| `compact: false`                   | ~55,000 | path, range, why, score, **preview** |

**Reduction: 95%**

### Usage Guidelines

**Use `compact: true` when:**

- Exploring codebase / discovering files
- Getting candidate file lists
- Token efficiency is the priority

**Use `compact: false` when:**

- Immediate code preview is needed
- Retrieving only a few files (1-3)

### Lightweight inspection options

- `files_search(..., compact: true)` removes previews from every result for 60–70% fewer tokens during keyword scans. Use `compact: false` only when the preview text is required inline.
- `snippets_get(..., compact: true)` returns only metadata (`path`, `startLine`, `endLine`, totals, symbol info) so that you can confirm the symbol boundaries without streaming full text.
- `snippets_get(..., includeLineNumbers: true)` prefixes each returned line with an aligned counter such as `  1375→export async function...`, making it easier to quote exact locations when copying into bug reports or chats.

### Real Example: Lambda Function Investigation

```json
// Request (compact mode)
{
  "method": "context_bundle",
  "params": {
    "goal": "ask-agent Lambda handler logic, runtime execution flow",
    "limit": 10,
    "compact": true,
    "includeTokensEstimate": true
  }
}

// Response (metadata only, ~2,500 tokens)
{
  "context": [
    {
      "path": "lambda/ask-agent/handler.ts",
      "range": [15, 89],
      "why": ["phrase:ask-agent", "path-phrase:handler", "boost:impl-file"],
      "score": 0.92
      // No preview field → token savings
    },
    {
      "path": "lambda/ask-agent/runtime.ts",
      "range": [42, 156],
      "why": ["phrase:ask-agent", "dep:handler.ts"],
      "score": 0.85
    }
  ],
  "tokens_estimate": 2480
}
```

## Codex CLI Configuration Example

KIRI launches via the CLI binary `kiri` using the MCP standard `stdio` transport by default. Simply pass `--repo` and `--db`, and capabilities will be auto-detected via `initialize` / `tools/list`.

**Important change in v0.1.0+**: If the database does not exist, the repository is automatically indexed on first startup. Manual index creation is no longer required.

```json
{
  "mcpServers": {
    "kiri": {
      "command": "kiri",
      "args": ["--repo", "/abs/path/repo", "--db", "/abs/path/index.duckdb"]
    }
  }
}
```

**Options**:

- `--reindex`: Force reindexing even if database exists
- `--port 8765`: Launch in HTTP mode (instead of stdio)
- `--watch`: Enable file change monitoring with automatic reindexing
- `--debounce <ms>`: Watch mode debounce time (default: 500ms)

> Note: For legacy HTTP mode, specify `--port` like `kiri --port 8765 ...` (metrics available at `/metrics`).

### Watch Mode

Watch mode (`--watch`) monitors repository file changes and automatically reindexes when changes are detected.

**Features**:

- **Debouncing**: Aggregates rapid consecutive changes to minimize reindex frequency (default: 500ms)
- **Exclusion list integration**: Respects both `denylist.yml` and `.gitignore` patterns
- **Lock management**: Uses lock files to prevent concurrent indexing
- **Graceful shutdown**: Supports clean termination via `SIGINT`/`SIGTERM`
- **Statistics**: Tracks reindex count, processing time, and queue depth

**Configuration Example (Codex)**:

```json
{
  "mcpServers": {
    "kiri": {
      "command": "kiri",
      "args": ["--repo", "/abs/path/repo", "--db", "/abs/path/index.duckdb", "--watch"]
    }
  }
}
```

**Custom Debounce Time** (for slow hardware or network filesystems):

```json
{
  "mcpServers": {
    "kiri": {
      "command": "kiri",
      "args": [
        "--repo",
        "/abs/path/repo",
        "--db",
        "/abs/path/index.duckdb",
        "--watch",
        "--debounce",
        "1000"
      ]
    }
  }
}
```

**Note**: Watch mode runs in parallel with the MCP server. Reindexing from file changes occurs in the background and does not interrupt ongoing queries.

---

# MCP API とクライアント設定

## 提供ツール一覧

サーバーは MCP 標準エンドポイント `initialize` / `tools/list` を実装しており、AI エージェントは起動直後に能力を自動検出できます。

- `files_search(query, lang?, ext?, path_prefix?, limit=50, compact?)`
- `symbols.find(name, kind?, path_hint?, limit=50)`
- `deps_closure(paths[], direction="out"|"in", depth=2)`
- `recent.changed(since="30d", path_prefix?)`
- `who.owns(path)` → `blame_summary` を要約
- `snippets_get(path, start_line?, end_line?, compact?, include_line_numbers?)`
- `semantic_rerank(candidates[], text, k=20)`（VSS 有効時のみ）
- `context_bundle(goal, artifacts, includeTokensEstimate?)` ← **最重要**
  - `goal`: 自然文（例: "Auth の失敗テスト test_verify_token を修す"）
  - `artifacts`: {`editing_path`?, `failing_tests`?, `last_diff`?}
    - `editing_path` に作業中ファイルを渡すと、そのファイルと依存・近傍ファイルが優先的に返り、関連コンテキストをまとめて取得できます。
  - 出力: 断片リスト（path, [start,end], why[], score, optional preview）と `tokens_estimate`（`includeTokensEstimate: true` のときのみ）

## `context_bundle` リクエスト/レスポンス例

```json
// request
{
  "method": "context_bundle",
  "params": {
    "goal": "fix failing test: JwtVerifier rejects expired tokens",
    "artifacts": {
      "editing_path": "src/auth/jwt.ts",
      "failing_tests": ["AuthJwtSpec#rejectsExpired"],
      "last_diff": "..."
    }
  }
}

// response
{
  "context": [
    {
      "path": "src/auth/jwt.ts",
      "range": [12, 78],
      "why": ["symbol:verifyToken", "dep:src/auth/keys.ts", "recent:7d"],
      "score": 0.86,
      "preview": "function verifyToken(token:string){...}"
    },
    {
      "path": "src/auth/keys.ts",
      "range": [1, 120],
      "why": ["dep<-jwt.ts"],
      "score": 0.74
    }
  ],
  "tokens_estimate": 1450
}
```

## トークン最適化：`compact` モード

`context_bundle` の `compact` パラメータを使用することで、トークン消費を**約95%削減**できます。

### 推奨：二段階ワークフロー

```javascript
// ステップ1: 候補ファイルを取得（compactモード）
const result = await context_bundle({
  goal: "ユーザー認証ハンドラーのロジック、ランタイム実行フロー、Mastra統合",
  limit: 10,
  compact: true, // メタデータのみ取得：path, range, why, score
});

// ステップ2: 必要なファイルのみ詳細取得
for (const item of result.context.slice(0, 3)) {
  const content = await snippets_get({
    path: item.path,
    start_line: item.range[0],
    end_line: item.range[1],
  });
  // contentを使って詳細分析
}
```

### トークン消費の比較

| モード                                 | トークン数 | 含まれる情報                         |
| -------------------------------------- | ---------- | ------------------------------------ |
| `compact: true`（デフォルト、v0.8.0+） | ~2,500     | path, range, why, score              |
| `compact: false`                       | ~55,000    | path, range, why, score, **preview** |

**削減率：95%**

### 使い分けガイド

**`compact: true` を使うべき場合：**

- コードベースの探索・ファイル発見
- 関連ファイルの候補リスト取得
- トークン効率を最優先する場合

**`compact: false` を使うべき場合：**

- すぐにコードプレビューが必要な場合
- 少数のファイル（1-3件）のみを取得する場合

### 実例：Lambda関数の調査

```json
// リクエスト（compact mode）
{
  "method": "context_bundle",
  "params": {
    "goal": "ask-agent Lambda handler logic, runtime execution flow",
    "limit": 10,
    "compact": true
  }
}

// レスポンス（メタデータのみ、~2,500トークン）
{
  "context": [
    {
      "path": "lambda/ask-agent/handler.ts",
      "range": [15, 89],
      "why": ["phrase:ask-agent", "path-phrase:handler", "boost:impl-file"],
      "score": 0.92
      // preview フィールドなし → トークン節約
    },
    {
      "path": "lambda/ask-agent/runtime.ts",
      "range": [42, 156],
      "why": ["phrase:ask-agent", "dep:handler.ts"],
      "score": 0.85
    }
  ],
  "tokens_estimate": 2480
}
```

## Codex CLI 設定例

KIRI は CLI バイナリ `kiri` を通じて MCP 標準の `stdio` トランスポートで起動するのが既定です。`--repo` と `--db` のみ渡せば、`initialize` / `tools/list` で自動検出されます。

**v0.1.0以降の重要な変更**: データベースが存在しない場合、初回起動時に自動的にリポジトリをインデックス化します。事前の手動インデックス作成は不要です。

```json
{
  "mcpServers": {
    "kiri": {
      "command": "kiri",
      "args": ["--repo", "/abs/path/repo", "--db", "/abs/path/index.duckdb"]
    }
  }
}
```

**オプション**:

- `--reindex`: データベースが存在する場合でも強制的に再インデックス化
- `--port 8765`: HTTP モードで起動（stdio の代わりに）
- `--watch`: ファイル変更の監視を有効化し、変更時に自動的に再インデックス化
- `--debounce <ms>`: ウォッチモードのデバウンス時間（デフォルト: 500ms）

> 補足: 旧来の HTTP モードを継続利用する場合は `kiri --port 8765 ...` のように `--port` を指定してください（この場合も `/metrics` で監視指標が取得できます）。

### ウォッチモード

ウォッチモード（`--watch`）を有効にすると、リポジトリのファイル変更を監視し、変更検出時に自動的に再インデックス化を実行します。

**機能**:

- **デバウンス**: 短時間に連続した変更を集約し、再インデックス回数を最小化（デフォルト: 500ms）
- **除外リスト統合**: `denylist.yml` と `.gitignore` の両方のパターンを尊重
- **ロック管理**: ロックファイルを使用して並行インデックス化を防止
- **グレースフルシャットダウン**: `SIGINT`/`SIGTERM` によるクリーンな終了をサポート
- **統計情報**: 再インデックス回数、処理時間、キュー深度を追跡

**設定例（Codex）**:

```json
{
  "mcpServers": {
    "kiri": {
      "command": "kiri",
      "args": ["--repo", "/abs/path/repo", "--db", "/abs/path/index.duckdb", "--watch"]
    }
  }
}
```

**カスタムデバウンス時間の設定**（低速ハードウェアやネットワークファイルシステム向け）:

```json
{
  "mcpServers": {
    "kiri": {
      "command": "kiri",
      "args": [
        "--repo",
        "/abs/path/repo",
        "--db",
        "/abs/path/index.duckdb",
        "--watch",
        "--debounce",
        "1000"
      ]
    }
  }
}
```

**注意**: ウォッチモードは MCP サーバーと並行して動作します。ファイル変更による再インデックス化はバックグラウンドで実行され、進行中のクエリを中断しません。
