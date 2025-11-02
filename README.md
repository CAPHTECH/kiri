# KIRI

> Context extraction platform for LLMs - Minimal, relevant code fragments from Git repositories

[![Version](https://img.shields.io/badge/version-0.2.0-blue.svg)](package.json)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue.svg)](https://www.typescriptlang.org/)

**KIRI** is a context extraction platform that indexes Git repositories into DuckDB and provides MCP (Model Context Protocol) tools for semantic code search. It extracts minimal, relevant code fragments (snippets) based on structure, history, and proximity to minimize LLM token usage.

## 🎯 Key Features

- **🔍 Smart Code Search**: Full-text search with multi-word queries, FTS/BM25 ranking, and graceful fallback
- **📦 Context Bundling**: Extract relevant code fragments based on task goals
- **🔗 Dependency Analysis**: Bidirectional dependency graphs (outbound and inbound closure)
- **⚡ Fast Response**: Time to first useful result ≤ 1.0s
- **🛡️ Degrade-First Architecture**: Works without VSS/FTS extensions via fallback
- **🔌 MCP Integration**: JSON-RPC 2.0 over stdio/HTTP
- **👁️ Watch Mode**: Automatic re-indexing on file changes with debouncing

## 📝 Supported Languages

KIRI currently supports AST-based symbol extraction for:

| Language       | Extensions    | Symbol Types                                                                   | Parser                  |
| -------------- | ------------- | ------------------------------------------------------------------------------ | ----------------------- |
| **TypeScript** | `.ts`, `.tsx` | `class`, `interface`, `enum`, `function`, `method`                             | TypeScript Compiler API |
| **Swift**      | `.swift`      | `class`, `struct`, `protocol`, `enum`, `extension`, `func`, `init`, `property` | tree-sitter-swift       |

Other languages are detected and indexed but use full-file snippets instead of symbol-level extraction. Support for additional languages (Rust, Go, Python, etc.) is planned.

## 🚀 Quick Start

### Installation

#### For End Users (after npm publication)

```bash
# Global installation (recommended)
npm install -g kiri-mcp-server

# Or use npx (no installation required)
npx kiri-mcp-server --repo . --db .kiri/index.duckdb
```

#### For Development

```bash
# Clone and install dependencies
git clone https://github.com/CAPHTECH/kiri.git
cd kiri
pnpm install

# Build the project
pnpm run build

# Link the package globally (makes 'kiri' command available)
npm link
```

### Start MCP Server

**Note**: Since v0.1.0, the server automatically indexes your repository on first startup if the database doesn't exist. No manual indexing step required!

#### Stdio Mode (for MCP clients like Codex)

```bash
# Start stdio server (auto-indexes if DB doesn't exist)
node dist/src/server/main.js --repo . --db var/index.duckdb

# Force re-indexing
node dist/src/server/main.js --repo . --db var/index.duckdb --reindex

# Start with watch mode (auto-reindex on file changes)
node dist/src/server/main.js --repo . --db var/index.duckdb --watch

# Customize debounce timing (default: 500ms)
node dist/src/server/main.js --repo . --db var/index.duckdb --watch --debounce 1000
```

#### Manual Indexing (Optional)

If you prefer to index manually before starting the server:

```bash
# Index current directory into DuckDB
tsx src/indexer/cli.ts --repo . --db var/index.duckdb --full
```

#### HTTP Mode (for testing)

```bash
# Start HTTP server on port 8765
pnpm run dev

# Or specify custom port
node dist/src/server/main.js --repo . --db var/index.duckdb --port 8765

# With watch mode enabled
node dist/src/server/main.js --repo . --db var/index.duckdb --port 8765 --watch
```

## 📋 MCP Tools

KIRI provides 5 MCP tools for code exploration:

| Tool                | Description                                                           |
| ------------------- | --------------------------------------------------------------------- |
| **context.bundle**  | Extract relevant code context based on task goals                     |
| **semantic.rerank** | Re-rank candidates by semantic similarity                             |
| **files.search**    | Full-text search with multi-word queries (FTS/BM25 or ILIKE fallback) |
| **snippets.get**    | Retrieve code snippets with symbol boundaries                         |
| **deps.closure**    | Get dependency graph neighborhood (outbound/inbound)                  |

### Search Query Syntax

**files.search** supports multi-word queries automatically:

- `"tools call implementation"` → Finds files containing ANY of these words (OR logic)
- `"MCP-server-handler"` → Splits on hyphens and searches for each part
- Single words work as expected: `"DuckDB"` → Exact match

When DuckDB's FTS extension is available, searches use BM25 ranking for better relevance. Otherwise, the system falls back to pattern matching (ILIKE) with graceful degradation.

### File Type Boosting

Control search ranking behavior with the `boost_profile` parameter:

- **`"default"`** (default): Prioritizes implementation files (src/\*.ts) over documentation
- **`"docs"`**: Prioritizes documentation files (\*.md) over implementation
- **`"none"`**: Pure BM25 scoring without file type adjustments

```javascript
// Find implementation files (default behavior)
mcp__kiri__files_search({ query: "filesSearch implementation" });

// Find documentation
mcp__kiri__files_search({ query: "setup guide", boost_profile: "docs" });

// Pure BM25 ranking
mcp__kiri__files_search({ query: "authentication", boost_profile: "none" });
```

## 🔧 Configuration

### Watch Mode

Watch mode monitors your repository for file changes and automatically re-indexes when changes are detected:

- **Debouncing**: Aggregates rapid consecutive changes to minimize reindex operations (default: 500ms)
- **Denylist Integration**: Respects both `denylist.yml` and `.gitignore` patterns
- **Lock Management**: Prevents concurrent indexing using lock files
- **Graceful Shutdown**: Supports `SIGINT`/`SIGTERM` for clean termination
- **Statistics**: Tracks reindex count, duration, and queue depth

```bash
# Enable watch mode with default debounce (500ms)
node dist/src/server/main.js --repo . --db var/index.duckdb --watch

# Customize debounce timing for slower hardware or network filesystems
node dist/src/server/main.js --repo . --db var/index.duckdb --watch --debounce 1000

# Watch mode works with both stdio and HTTP modes
node dist/src/server/main.js --repo . --db var/index.duckdb --port 8765 --watch
```

**Note**: Watch mode runs in parallel with the MCP server. File changes trigger reindexing in the background without interrupting ongoing queries.

### MCP Client Integration

#### Option 1: Global Installation (Recommended for End Users)

```bash
npm install -g kiri-mcp-server
```

Create `~/.config/codex/mcp.json` or `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "kiri": {
      "command": "kiri",
      "args": [
        "--repo",
        "/path/to/your/project",
        "--db",
        "/path/to/your/project/.kiri/index.duckdb",
        "--watch"
      ]
    }
  }
}
```

#### Option 2: npx (No Installation Required)

```json
{
  "mcpServers": {
    "kiri": {
      "command": "npx",
      "args": [
        "kiri-mcp-server",
        "--repo",
        "/path/to/your/project",
        "--db",
        "/path/to/your/project/.kiri/index.duckdb"
      ]
    }
  }
}
```

**Note**: `npx` automatically downloads and caches the package on first use. Subsequent starts are faster.

#### Option 3: Local Development (with npm link)

After running `npm link` in the KIRI repository:

```json
{
  "mcpServers": {
    "kiri": {
      "command": "kiri",
      "args": [
        "--repo",
        "/path/to/your/project",
        "--db",
        "/path/to/your/project/.kiri/index.duckdb",
        "--watch"
      ]
    }
  }
}
```

**Note**: The `kiri` command will use the symlinked version from your local development directory. Changes require rebuilding with `pnpm run build`.

See [examples/README.md](examples/README.md) for detailed usage examples.

## 🏗️ Architecture

```
┌────────────────────┐     ┌─────────────────────────────┐     ┌────────────────────┐
│   MCP Client       │<--->│ KIRI MCP Server (JSON-RPC)  │<--->│     DuckDB         │
│ (Codex CLI, etc.)  │     │ tools: search/bundle/...    │     │  index.duckdb      │
└────────────────────┘     └─────────────────────────────┘     └────────────────────┘
                                    ^
                                    │
                          ┌─────────┴──────────┐
                          │     Indexer        │
                          │  git scan / AST    │
                          │  embedding (opt)   │
                          └────────────────────┘
```

### Three-Tier Architecture

1. **Indexer** (`src/indexer/`): Scans Git worktrees, extracts metadata and content, persists to DuckDB
2. **MCP Server** (`src/server/`): JSON-RPC 2.0 server exposing search and context tools
3. **Client** (`src/client/`): CLI utilities and integration helpers

## 📊 Data Model

KIRI uses a **blob/tree separation** pattern (similar to Git internals):

- **`blob`**: Stores unique file content by hash (deduplicates renamed/copied files)
- **`tree`**: Maps `repo_id + commit_hash + path → blob_hash`
- **`file`**: Convenience view of HEAD state for fast queries
- **`symbol`**: AST-based function/class/method boundaries
- **`snippet`**: Line-range chunks aligned to symbol boundaries

See [docs/data-model.md](docs/data-model.md) for complete schema details.

## 🧪 Development

### Run Tests

```bash
# Run all tests with coverage (requires ≥80%)
pnpm run test

# Run specific test file
pnpm exec vitest run tests/server/handlers.spec.ts

# Run tests in watch mode
pnpm exec vitest
```

### Code Quality

```bash
# Lint and test
pnpm run check

# Fix linting issues
pnpm exec eslint --fix "src/**/*.ts"
```

### Project Structure

```
kiri/
├── src/
│   ├── indexer/      # Git scanning, language detection, schema management
│   ├── server/       # MCP server, JSON-RPC handlers, context resolution
│   ├── shared/       # DuckDB client wrapper, common utilities
│   └── client/       # CLI and integration utilities
├── tests/            # Test files (mirrors src/ structure)
├── docs/             # Architecture documentation
├── config/           # YAML configuration schemas
├── sql/              # SQL schema definitions
├── examples/         # Usage examples and integration guides
└── var/              # Generated files and databases (gitignored)
```

## 📚 Documentation

- [Overview](docs/overview.md) - Core design and architecture
- [Data Model](docs/data-model.md) - Database schema details
- [Indexer](docs/indexer.md) - Indexing logic and patterns
- [Search & Ranking](docs/search-ranking.md) - Search algorithms
- [API Reference](docs/api-and-client.md) - API documentation
- [Codex Setup](docs/codex-setup.md) - Codex integration guide
- [Examples](examples/README.md) - Usage examples

## 🎯 Performance Targets

| Metric              | Target | Description                                 |
| ------------------- | ------ | ------------------------------------------- |
| **P@10**            | ≥ 0.7  | Precision at 10 - Top 10 snippets relevance |
| **TTFU**            | ≤ 1.0s | Time to first useful result                 |
| **Token Reduction** | ≥ 40%  | Compared to naive copy-paste approach       |
| **Coverage**        | ≥ 80%  | Statement and line coverage for tests       |

## 🔐 Security

- Sensitive paths (`.env*`, `*.pem`, `secrets/**`) are filtered by both `.gitignore` and indexer
- All responses mask sensitive values with `***`
- No credentials or secrets are stored in the database

## 🛠️ Commands Reference

```bash
# Build
pnpm run build                # Compile TypeScript to dist/

# Development
pnpm run dev                  # Start HTTP server with hot reload on :8765

# Testing
pnpm run test                 # Run all tests with coverage
pnpm run check                # Lint + test

# Indexing (optional - server auto-indexes on startup)
tsx src/indexer/cli.ts --repo <path> --db <db-path> --full

# Server modes
node dist/src/server/main.js --repo <path> --db <db-path>                     # stdio mode (auto-indexes if needed)
node dist/src/server/main.js --repo <path> --db <db-path> --port 8765        # HTTP mode (auto-indexes if needed)
node dist/src/server/main.js --repo <path> --db <db-path> --reindex          # Force re-indexing
node dist/src/server/main.js --repo <path> --db <db-path> --watch            # Enable watch mode
node dist/src/server/main.js --repo <path> --db <db-path> --watch --debounce 1000  # Custom debounce timing
```

## 🤝 Contributing

We follow these conventions:

- **Code Style**: 2-space indentation, `camelCase` for variables, `PascalCase` for types
- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/) format
- **Testing**: Maintain ≥80% coverage for new code
- **Documentation**: Update relevant docs with code changes

See [AGENTS.md](AGENTS.md) for detailed guidelines.

## 📄 License

MIT License - See [LICENSE](LICENSE) for details.

## 🙏 Acknowledgments

Built with:

- [DuckDB](https://duckdb.org/) - Embedded analytical database
- [tree-sitter](https://tree-sitter.github.io/) - Parser generator for AST extraction
- [MCP](https://modelcontextprotocol.io/) - Model Context Protocol

---

**Status**: v0.1.0 (Alpha) - Active development

For questions or issues, please open a [GitHub issue](https://github.com/CAPHTECH/kiri/issues).
