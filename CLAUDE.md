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

# Run golden set evaluation (P@10/TFFU benchmark)
pnpm run eval:golden

# Unlink the package (if needed)
npm unlink -g kiri-mcp-server
```

## Evaluation System

KIRI includes a golden set evaluation system for measuring search accuracy:

- **Location**: `tests/eval/goldens/`
- **Metrics**: P@10 (Precision at K=10), TFFU (Time To First Useful)
- **Usage**: `pnpm run eval:golden` (local execution only, CI blocked)

**Key Files:**

- `tests/eval/goldens/queries.yaml` - Representative queries (20-50 queries)
- `tests/eval/goldens/README.md` - Schema, categories, adding queries
- `tests/eval/results/README.md` - Results recording workflow
- `scripts/eval/run-golden.ts` - Benchmark execution script

See [tests/eval/goldens/README.md](tests/eval/goldens/README.md) for complete documentation.

````

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
````

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
- Golden data for evaluation tests goes in `tests/eval/*.spec.ts`
- Target metrics: **P@10 ≥ 0.7** (precision at 10), **TTFU ≤ 1.0s** (time to first useful result)
