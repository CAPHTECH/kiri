# MCP API とクライアント設定

## 提供ツール一覧

サーバーは MCP 標準エンドポイント `initialize` / `tools/list` を実装しており、AI エージェントは起動直後に能力を自動検出できます。

- `files_search(query, lang?, ext?, path_prefix?, limit=50)`
- `symbols.find(name, kind?, path_hint?, limit=50)`
- `deps_closure(paths[], direction="out"|"in", depth=2)`
- `recent.changed(since="30d", path_prefix?)`
- `who.owns(path)` → `blame_summary` を要約
- `snippets_get(path, start_line, end_line)`
- `semantic_rerank(candidates[], text, k=20)`（VSS 有効時のみ）
- `context_bundle(goal, artifacts)` ← **最重要**
  - `goal`: 自然文（例: "Auth の失敗テスト test_verify_token を修す"）
  - `artifacts`: {`editing_path`?, `failing_tests`?, `last_diff`?}
  - 出力: 断片リスト（path, [start,end], why[], score, preview）と `tokens_estimate`

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
