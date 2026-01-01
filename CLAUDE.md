# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Use KIRI MCP Tools - MANDATORY

**This project uses KIRI MCP**. You MUST proactively use KIRI MCP tools for all code exploration and search tasks.

### When to Use KIRI Tools

**ALWAYS use KIRI tools instead of Glob/Grep for:**

1. **Understanding codebase structure** → Use `mcp__kiri__context_bundle`
   - Finding relevant code for implementing features
   - Understanding how existing features work
   - Locating code related to specific functionality
   - Example: `mcp__kiri__context_bundle` with goal "How does the daemon lifecycle work?"

2. **Searching for files or code patterns** → Use `mcp__kiri__files_search`
   - Finding files by keywords or functionality
   - Locating implementation patterns
   - Example: `mcp__kiri__files_search` with query "daemon startup"

3. **Reading specific code sections** → Use `mcp__kiri__snippets_get`
   - Reading only relevant parts of large files
   - Minimizing token usage
   - Example: `mcp__kiri__snippets_get` for path "src/daemon/daemon.ts"

4. **Understanding dependencies** → Use `mcp__kiri__deps_closure`
   - Finding what files depend on a module (inbound)
   - Finding what a module depends on (outbound)
   - Impact analysis for refactoring
   - Example: `mcp__kiri__deps_closure` with path "src/server/runtime.ts"

5. **Refining search results** → Use `mcp__kiri__semantic_rerank`
   - Prioritizing files by semantic relevance
   - Narrowing down search results

### Performance Benefits

- **Token efficiency**: KIRI returns only relevant snippets, not entire files
- **Precision**: Context-aware search beats simple pattern matching
- **Speed**: Indexed search is faster than filesystem traversal
- **Structure-aware**: Understands code symbols and dependencies

### Token-Saving Workflow (v0.9.6+)

1. Run `files_search` or `context_bundle` with `compact: true` to gather lightweight candidates.
2. Use `snippets_get` with `compact: true` when you only need metadata, or `includeLineNumbers: true` when copying exact line references (format: `  1375→export function ...`).
3. Request `includeTokensEstimate: true` on `context_bundle` only when you explicitly need the projected token count; it is skipped by default.

### Default Tool Priority

1. First: Try KIRI tools (`mcp__kiri__*`)
2. Fallback: Use Glob/Grep only when KIRI doesn't return useful results
3. Never: Use Glob/Grep for initial exploration without trying KIRI first

---

## Project Overview

**KIRI** is a context extraction platform for LLMs that indexes Git repositories into DuckDB and provides MCP (Model Context Protocol) tools for semantic code search. It extracts minimal, relevant code fragments (snippets) based on structure, history, and proximity to minimize LLM token usage.

**Key design principle**: Degrade-first architecture - the system must work without VSS/FTS extensions, relying on string matching and structural proximity.

## Architecture

The codebase follows a three-tier architecture:

1. **Indexer** (`src/indexer/`): Scans Git worktrees, extracts file metadata, content, and language info, then persists to DuckDB using a blob/tree separation pattern (similar to Git's internal model). This avoids duplicate content storage and handles file renames efficiently.

2. **MCP Server** (`src/server/`): JSON-RPC 2.0 server exposing tools like `files_search` and `snippets_get` over HTTP. Queries DuckDB to return ranked code fragments. Each request includes repo context resolution via `resolveRepoId`.

3. **Shared** (`src/shared/`): Common utilities including `DuckDBClient` wrapper for async database operations and transaction support.

## Key Commands

```bash
# Install dependencies
pnpm install

# Build (outputs ESM to dist/)
pnpm run build

# Link the package globally (makes 'kiri' command available)
npm link

# Start MCP server on port 8765 with hot reload
pnpm run dev

# Run indexer to scan current directory into var/index.duckdb
tsx src/indexer/cli.ts --repo . --db var/index.duckdb --full

# Run all tests with coverage (requires ≥80% lines & statements)
pnpm run test

# Run single test file
pnpm exec vitest run tests/server/handlers.spec.ts

# Lint and test together
pnpm run check

# Run Assay evaluation (assay-kit based benchmark)
pnpm run assay:evaluate

# Unlink the package (if needed)
npm unlink -g kiri-mcp-server
```

## Evaluation System

KIRI uses assay-kit for search quality evaluation:

- **Dataset**: `external/assay-kit/examples/kiri-integration/datasets/kiri-golden.yaml`
- **Metrics**: P@10 / R@5 / TTFU / NDCG など（assay-kit 由来）
- **Usage**: `pnpm run assay:evaluate` (local execution)

**Key Files:**

- `scripts/assay/run-evaluation.ts` - Assay evaluation runner
- `scripts/assay/run-comparison.ts` - A/B comparison runner
- `scripts/assay/plugins/` - Custom metrics

## DuckDB Schema Design

The schema uses **blob/tree separation**:

- `blob` table: Stores unique file content by hash (deduplicates renamed/copied files)
- `tree` table: Maps repo_id + commit_hash + path → blob_hash
- `file` table: Convenience view of HEAD state for fast queries
- `symbol` table: AST-based function/class/method boundaries (tree-sitter)
- `snippet` table: Line-range chunks aligned to symbol boundaries

See `docs/data-model.md` for full schema and `sql/schema.sql` for baseline DDL.

## Development Patterns

### Database Client Usage

Always use the `DuckDBClient` wrapper, which provides:

- Automatic directory creation via `ensureDirectory` option
- Transaction support with `db.transaction(async () => {...})`
- Async query methods: `db.all()`, `db.run()`
- Resource cleanup with `db.close()`

Example:

```typescript
const db = await DuckDBClient.connect({
  databasePath: "var/index.duckdb",
  ensureDirectory: true,
});
try {
  await db.transaction(async () => {
    await db.run("INSERT INTO ...", [params]);
  });
} finally {
  await db.close();
}
```

### Testing with DuckDB

Tests using DuckDB should:

- Create temporary databases in `tmp/` directory
- Use `afterEach` to clean up: `await db.close()` and delete temp files
- Run evaluation tests with `vitest --runInBand` to avoid race conditions

See `tests/server/handlers.spec.ts` and `tests/indexer/cli.spec.ts` for patterns.

### Error Message Format

All error messages follow the pattern: **"Problem description. Resolution action."**

Examples:

- `"Target repository is missing from DuckDB. Run the indexer before starting the server."`
- `"Requested snippet file was not indexed. Re-run the indexer or choose another path."`

## Code Style

- **Indentation**: 2 spaces
- **Naming**: `camelCase` for variables/functions, `PascalCase` for classes/types, `SCREAMING_SNAKE_CASE` for constants
- **SQL conventions**: Keywords in UPPERCASE, identifiers in `snake_case`
- **MCP tool naming**: `<domain>.<verb>` format (e.g., `files_search`, `snippets_get`)
- All TypeScript uses strict mode with `noUncheckedIndexedAccess` enabled

## File Organization

- `src/indexer/`: Git scanning, language detection, schema management
- `src/server/`: MCP server entry point, JSON-RPC handlers, context resolution
- `src/shared/`: DuckDB client wrapper and common utilities
- `src/client/`: CLI and Codex integration utilities (planned)
- `tests/`: Mirror structure of `src/` with `.spec.ts` files
- `docs/`: Architecture documentation (start with `overview.md`)
- `config/`: YAML configuration schemas
- `sql/`: SQL schema definitions
- `var/`: Generated files and DuckDB databases (gitignored)

## Important Implementation Notes

1. **Binary Detection**: Files are sampled (first 32KB) for null bytes or UTF-8 replacement chars to determine binary status. Binary files are indexed but content is not stored.

2. **Language Detection**: Based on file extension mapping in `src/indexer/language.ts`. Currently supports symbol extraction for:
   - **TypeScript** (`.ts`, `.tsx`): Uses TypeScript Compiler API
   - **Swift** (`.swift`): Uses tree-sitter-swift
   - **PHP** (`.php`): Uses tree-sitter-php (automatically detects pure PHP vs HTML-mixed PHP)
   - **Java** (`.java`): Uses tree-sitter-java
   - Other languages are detected but symbols are not extracted (fallback to full-file snippets)

3. **Repo ID Resolution**: Each indexed repository gets an auto-incrementing ID. The server resolves `repoRoot` → `repoId` at startup and stores it in `ServerContext`.

4. **Search Ranking**: Currently uses simple content matching with ILIKE. Future versions will add proximity scoring, recency weighting, and optional semantic ranking.

5. **Security**: All `.env*`, `*.pem`, `secrets/**` patterns must be filtered by both `.gitignore` and indexer logic. Sensitive paths in MCP responses are masked with `***`.

## Reference Documentation

- **Core design**: `docs/overview.md`
- **Schema details**: `docs/data-model.md`
- **Indexer logic**: `docs/indexer.md`
- **Search & ranking**: `docs/search-ranking.md`
- **Repository guidelines**: `AGENTS.md` (commit conventions, testing standards)

## Testing Standards

- Use `vitest` for all tests
- Maintain ≥80% statement and line coverage for new code
- Name test files to mirror implementation: `tests/server/handlers.spec.ts` ↔ `src/server/handlers.ts`
- Evaluation datasets live in assay-kit YAML (e.g., `external/assay-kit/examples/kiri-integration/datasets/*.yaml`)
- Target metrics: **P@10 ≥ 0.7** (precision at 10), **TTFU ≤ 1.0s** (time to first useful result)

## pce-memory とは

プロジェクトの知識（設計決定、規約、好み、タスク）を永続化し、セッションを跨いで想起するためのMCPサーバーです。

## 利用フロー

1. activate → タスク開始前に関連知識を想起
2. 作業実行 → 想起した知識を考慮して実装
3. upsert → 重要な決定事項を記録
4. feedback → 知識の有用性をフィードバック

## いつ activate するか

以下の状況で `pce.memory.activate` を呼び出してください：

- **新しいタスクを開始するとき** - 関連する過去の決定を確認
- **設計判断が必要なとき** - 既存のアーキテクチャ決定を参照
- **命名や規約を確認したいとき** - プロジェクト固有のルールを想起
- **エラーに遭遇したとき** - 過去の類似問題の解決策を検索

```json
// 例: API設計前に関連知識を想起
{
  "q": "API 命名規約 RESTful",
  "scope": ["project", "principle"],
  "allow": ["answer:task"],
  "top_k": 10
}
```

## いつ upsert するか

以下の情報を `pce.memory.upsert` で記録してください：

### kind: fact（事実）

- アーキテクチャ決定（「認証にはJWTを使用」）
- 技術的制約（「DuckDBはFOREIGN KEY CASCADEをサポートしない」）
- API仕様（「POST /cancel は非同期で202を返す」）

### kind: preference（好み）

- コーディングスタイル（「関数型パターンを好む」）
- ツール選択（「テストにはVitestを使用」）
- 命名規則（「ハンドラは handle\* プレフィックス」）

### kind: task（タスク）

- 進行中の作業（「認証機能を実装中」）
- TODO項目（「エラーハンドリングを追加する必要がある」）

### kind: policy_hint（ポリシーヒント）

- セキュリティ要件（「PII は internal 以上で保護」）
- 運用ルール（「本番DBへの直接アクセス禁止」）

```json
// 例: 設計決定を記録
{
  "text": "状態管理にはfp-tsのEitherを使用し、例外をthrowしない",
  "kind": "fact",
  "scope": "project",
  "boundary_class": "internal",
  "provenance": {
    "at": "2025-11-27T15:00:00Z",
    "actor": "claude",
    "note": "ADR-0002で決定"
  },
  "content_hash": "sha256:..."
}
```

## scope の使い分け

| scope       | 用途             | 例                                              |
| ----------- | ---------------- | ----------------------------------------------- |
| `session`   | 今回の会話限定   | 「このファイルを編集中」「デバッグ中の仮説」    |
| `project`   | プロジェクト固有 | 「JWTで認証」「Vitestでテスト」「REST API設計」 |
| `principle` | 普遍的原則       | 「TDDで開発」「SOLID原則を遵守」                |

## boundary_class の使い分け

| class      | 用途         | 例                                         |
| ---------- | ------------ | ------------------------------------------ |
| `public`   | 公開可能     | OSSライブラリの使い方、一般的な技術情報    |
| `internal` | 社内限定     | 内部API仕様、アーキテクチャ決定            |
| `pii`      | 個人情報含む | ユーザー名、メールアドレスを含む文脈       |
| `secret`   | 機密情報     | APIキー、認証情報（※記録しないことを推奨） |

## feedback を送るタイミング

activateで取得した知識が役立ったかを `pce.memory.feedback` で報告してください：

| signal      | いつ送るか                                |
| ----------- | ----------------------------------------- |
| `helpful`   | 提案/知識が採用された、問題解決に貢献した |
| `harmful`   | 提案が誤っていた、バグの原因になった      |
| `outdated`  | 情報が古くなっていた、現状と異なる        |
| `duplicate` | 同じ内容が既に別のClaimで存在する         |

```json
// 例: 知識が役立った
{
  "claim_id": "clm_abc123",
  "signal": "helpful"
}
```

## 実践的なワークフロー例

### 1. 新機能実装

User: "ユーザー認証機能を実装して"

Agent:

1. activate({ q: "認証 JWT セッション", scope: ["project"] })
   → 既存の認証関連の決定を確認

2. 実装を進める（想起した知識を考慮）

3. upsert({
   text: "認証トークンは15分で期限切れ、リフレッシュトークンは7日",
   kind: "fact",
   scope: "project"
   })
   → 新しい決定を記録

4. feedback({ claim_id: "clm_xxx", signal: "helpful" })
   → 参考になった知識にフィードバック

### 2. バグ修正

User: "ログインできないバグを直して"

Agent:

1. activate({ q: "ログイン 認証 エラー", scope: ["project", "session"] })
   → 過去の類似問題や関連実装を確認

2. 原因を特定して修正

3. upsert({
   text: "JWTのtimezone不一致でログイン失敗する問題があった。UTCに統一",
   kind: "fact",
   scope: "project"
   })
   → 解決策を記録（将来の参考に）

### 3. コードレビュー

Agent:

1. activate({ q: "コーディング規約 命名 スタイル", scope: ["project", "principle"] })
   → プロジェクトの規約を確認

2. レビュー実施（規約に基づいて）

3. 新しい規約が決まったら upsert

## 注意事項

- **secret は記録しない**: APIキー、パスワード等は upsert しないでください
- **content_hash は必須**: 重複防止のため、テキストのSHA256ハッシュを含めてください
- **provenance を明記**: いつ、誰が、なぜその知識を記録したか追跡可能にしてください
- **過度な記録は避ける**: 全ての会話を記録するのではなく、重要な決定のみを厳選してください
