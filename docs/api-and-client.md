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
