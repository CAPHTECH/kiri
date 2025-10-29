# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**KIRI** is a context extraction platform for LLMs that indexes Git repositories into DuckDB and provides MCP (Model Context Protocol) tools for semantic code search. It extracts minimal, relevant code fragments (snippets) based on structure, history, and proximity to minimize LLM token usage.

**Key design principle**: Degrade-first architecture - the system must work without VSS/FTS extensions, relying on string matching and structural proximity.

## Architecture

The codebase follows a three-tier architecture:

1. **Indexer** (`src/indexer/`): Scans Git worktrees, extracts file metadata, content, and language info, then persists to DuckDB using a blob/tree separation pattern (similar to Git's internal model). This avoids duplicate content storage and handles file renames efficiently.

2. **MCP Server** (`src/server/`): JSON-RPC 2.0 server exposing tools like `files.search` and `snippets.get` over HTTP. Queries DuckDB to return ranked code fragments. Each request includes repo context resolution via `resolveRepoId`.

3. **Shared** (`src/shared/`): Common utilities including `DuckDBClient` wrapper for async database operations and transaction support.

## Key Commands

```bash
# Install dependencies
pnpm install

# Build (outputs ESM to dist/)
pnpm run build

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
```

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
- **MCP tool naming**: `<domain>.<verb>` format (e.g., `files.search`, `snippets.get`)
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

2. **Language Detection**: Based on file extension mapping in `src/indexer/language.ts`. Extensible for new languages.

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
