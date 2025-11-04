# KIRI 使用例

## Codex での基本的な使い方

### セットアップ

1. **MCP 設定ファイルを作成**

`~/.config/codex/mcp.json` に以下を追加（または `codex-mcp-config.json` をコピー）：

```json
{
  "mcpServers": {
    "kiri": {
      "command": "kiri",
      "args": [
        "--repo",
        "/path/to/your/project",
        "--db",
        "/path/to/your/project/.kiri/index.duckdb"
      ]
    }
  }
}
```

**設定ファイルのコピー**:

```bash
cp examples/codex-mcp-config.json ~/.config/codex/mcp.json
# パスを実際のプロジェクトに合わせて編集してください
```

2. **Codex を起動**

```bash
codex
```

**注**: v0.1.0以降、データベースが存在しない場合は初回起動時に自動的にインデックス化されます。
手動で再インデックス化する場合は：

```bash
kiri --repo /path/to/your/project --db /path/to/your/project/.kiri/index.duckdb --reindex
```

---

## 使用例

### 例1: コード検索

**ユーザー**: "authentication 関連のコードを検索して"

**Codex の動作**:

1. KIRI の `files_search` ツールを使用
2. "authentication" をキーワードに全文検索
3. 関連ファイルのリストを返却

**期待される結果**:

```
見つかったファイル:
- src/auth/token.ts (認証トークン検証)
- src/auth/middleware.ts (認証ミドルウェア)
- tests/auth/token.spec.ts (認証テスト)
```

---

### 例2: 特定機能の理解

**ユーザー**: "トークン検証の実装を理解したい"

**Codex の動作**:

1. `context_bundle` ツールでゴールに基づいてコンテキスト抽出
2. 関連するコードスニペットを収集
3. 依存関係も含めて提示

**期待される結果**:

```markdown
## トークン検証の実装

### メインロジック (src/auth/token.ts)

\`\`\`typescript
export function verifyToken(token: string): boolean {
if (!token) return false;
const expires = calculateExpiry(token);
return Date.now() < expires;
}
\`\`\`

### 依存関係

- src/utils/helper.ts: `calculateExpiry` 関数
- src/auth/token.spec.ts: テストコード
```

---

### 例3: 依存関係の調査

**ユーザー**: "src/main.ts が依存しているファイルを教えて"

**Codex の動作**:

1. `deps_closure` ツールで依存グラフを取得
2. outbound 方向（依存先）を取得
3. ツリー構造で表示

**期待される結果**:

```
src/main.ts の依存関係:
├── src/server/main.ts
│   ├── src/server/handlers.ts
│   │   └── src/shared/duckdb.ts
│   └── src/server/context.ts
└── src/indexer/cli.ts
    └── src/indexer/git.ts
```

---

### 例4: コードスニペットの取得

**ユーザー**: "src/auth/token.ts の verifyToken 関数だけ見せて"

**Codex の動作**:

1. `snippets_get` ツールでファイル取得
2. シンボル（関数）境界を検出
3. 該当部分のみ抽出

**期待される結果**:

```typescript
// src/auth/token.ts:3-9
export function verifyToken(token: string): boolean {
  if (!token) {
    return false;
  }
  const expires = calculateExpiry(token);
  return Date.now() < expires;
}
```

---

### 例5: セマンティック検索

**ユーザー**: "ユーザー認証に関連するファイルを重要度順に並べて"

**Codex の動作**:

1. まず `files_search` で候補を取得
2. `semantic_rerank` で類似度計算
3. スコア順にソート

**期待される結果**:

```
関連度順:
1. src/auth/token.ts (スコア: 0.92)
2. src/auth/middleware.ts (スコア: 0.87)
3. src/user/service.ts (スコア: 0.74)
4. tests/auth/integration.spec.ts (スコア: 0.68)
```

---

## 高度な使用例

### ケース1: バグ修正のためのコンテキスト取得

```
ユーザー: "認証トークンの有効期限チェックにバグがあるみたい。関連するコードを全部見せて"

Codex:
1. context_bundle で "認証トークン 有効期限 バグ" をゴールに設定
2. 関連ファイル、テスト、依存関係を包括的に取得
3. 最も関連性の高いスニペットから順に提示
```

### ケース2: リファクタリングの影響範囲調査

```
ユーザー: "calculateExpiry 関数を変更したら、どこに影響が出る？"

Codex:
1. deps_closure で inbound 方向（呼び出し元）を取得
2. 影響範囲をツリー表示
3. テストファイルも含めて提示
```

### ケース3: 新機能の実装場所の提案

```
ユーザー: "メール認証機能を追加したいんだけど、どこに実装すればいい？"

Codex:
1. files_search で "auth" "mail" "email" などを検索
2. 既存の認証実装パターンを分析
3. 適切な実装場所とパターンを提案
```

---

## パフォーマンスTips

### 大規模プロジェクト向け

```json
{
  "mcpServers": {
    "kiri": {
      "command": "kiri",
      "args": [
        "--repo",
        "/path/to/large/project",
        "--db",
        "/path/to/index.duckdb",
        "--allow-degrade"
      ]
    }
  }
}
```

`--allow-degrade` オプションで、DuckDB が利用できない場合でもフォールバック検索を有効化。

### 定期的なインデックス更新

```bash
# cron で1日1回更新
0 2 * * * /path/to/kiri-index --repo /path/to/project --db /path/to/index.duckdb
```

---

## トラブルシューティング

### よくある問題

**Q: ツールが見つからない**

```
/mcp tools kiri
→ エラー: サーバー未接続
```

**A**: 設定ファイルのパスを確認

```bash
cat ~/.config/codex/mcp.json
# パスが絶対パスになっているか確認
```

---

**Q: 検索結果が空**

```
files_search { query: "test" }
→ 0 results
```

**A**: インデックスを確認

```bash
# インデックスサイズを確認
ls -lh /path/to/index.duckdb

# 再インデックス化
kiri-index --repo /path/to/project --db /path/to/index.duckdb --full
```

---

**Q: レスポンスが遅い**

**A**: 以下を確認

1. データベースサイズ（大きすぎる場合は分割）
2. 除外設定（node_modules など）
3. `--allow-degrade` オプションの利用

---

## 参考資料

- [Codex セットアップガイド](../docs/codex-setup.md)
- [API リファレンス](../docs/api-and-client.md)
- [MCP 公式ドキュメント](https://modelcontextprotocol.io/)
