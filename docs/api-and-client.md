# MCP API とクライアント設定

## 提供ツール一覧

サーバーは MCP 標準エンドポイント `initialize` / `tools/list` を実装しており、AI エージェントは起動直後に能力を自動検出できます。

- `files.search(query, lang?, ext?, path_prefix?, limit=50)`
- `symbols.find(name, kind?, path_hint?, limit=50)`
- `deps.closure(paths[], direction="out"|"in", depth=2)`
- `recent.changed(since="30d", path_prefix?)`
- `who.owns(path)` → `blame_summary` を要約
- `snippets.get(path, start_line, end_line)`
- `semantic.rerank(candidates[], text, k=20)`（VSS 有効時のみ）
- `context.bundle(goal, artifacts)` ← **最重要**
  - `goal`: 自然文（例: "Auth の失敗テスト test_verify_token を修す"）
  - `artifacts`: {`editing_path`?, `failing_tests`?, `last_diff`?}
  - 出力: 断片リスト（path, [start,end], why[], score, preview）と `tokens_estimate`

## `context.bundle` リクエスト/レスポンス例

```json
// request
{
  "method": "context.bundle",
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

## Codex CLI 設定例

KIRI は CLI バイナリ `kiri` を通じて MCP 標準の `stdio` トランスポートで起動するのが既定です。`--repo` と `--db` のみ渡せば、`initialize` / `tools/list` で自動検出されます。

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

> 補足: 旧来の HTTP モードを継続利用する場合は `kiri --port 8765 ...` のように `--port` を指定してください（この場合も `/metrics` で監視指標が取得できます）。
