# KIRI MCP Server

> Intelligent code context extraction for LLMs via Model Context Protocol

[![Version](https://img.shields.io/badge/version-0.22.2-blue.svg)](package.json)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-Compatible-green.svg)](https://modelcontextprotocol.io/)

**KIRI** is an MCP server that provides intelligent code context extraction from Git repositories. It indexes your codebase into DuckDB and exposes semantic search tools for LLMs.

## Why KIRI?

- **MCP Native**: Plug-and-play with Claude Desktop, Codex CLI, and other MCP clients
- **Smart Context**: Extract minimal, relevant code fragments based on task goals
- **Accurate**: MRR 1.0 — the most relevant file always ranks first
- **Fast**: Sub-second response time for most queries
- **Semantic Search**: Multi-word queries, dependency analysis, BM25 ranking
- **Auto-Sync**: Watch mode automatically re-indexes on file changes
- **Phrase-Aware**: Recognizes compound terms (kebab-case, snake_case)

## Quick Start

### 1. Install

```bash
npm install -g kiri-mcp-server
```

Or use `npx` without installation.

### 2. Configure Claude Code

Edit `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "kiri": {
      "command": "kiri",
      "args": ["--repo", ".", "--db", ".kiri/index.duckdb", "--watch"]
    }
  }
}
```

### 3. Restart Claude Code

KIRI automatically indexes your repository on first startup.

> **Other MCP clients**: See [Setup Guide](docs/setup.md) for Codex CLI and other configurations.

## MCP Tools

| Tool              | Purpose                       | Example                          |
| ----------------- | ----------------------------- | -------------------------------- |
| `context_bundle`  | Find relevant code for a task | `goal: "auth token refresh bug"` |
| `files_search`    | Search files by keywords      | `query: "handler"`               |
| `snippets_get`    | Read specific code sections   | `path: "src/server/handlers.ts"` |
| `deps_closure`    | Analyze dependencies          | `direction: "inbound"`           |
| `semantic_rerank` | Refine search results         | `candidates: [...]`              |

> **Full documentation**: [Tools Reference](docs/tools-reference.md)

## Supported Languages

| Language   | Extensions    | Parser                  |
| ---------- | ------------- | ----------------------- |
| TypeScript | `.ts`, `.tsx` | TypeScript Compiler API |
| Swift      | `.swift`      | tree-sitter-swift       |
| PHP        | `.php`        | tree-sitter-php         |
| Java       | `.java`       | tree-sitter-java        |
| Dart       | `.dart`       | Dart Analysis Server    |
| Rust       | `.rs`         | tree-sitter-rust        |

Other languages are indexed but use full-file snippets instead of symbol extraction.

## Troubleshooting

### Database Issues

```bash
# Delete and rebuild
rm -rf .kiri/
# Restart MCP client - KIRI will automatically reindex
```

### Daemon Timeout (Large Repositories)

```json
{
  "env": { "KIRI_DAEMON_READY_TIMEOUT": "480" }
}
```

### Stale Lock File

```bash
rm -f .kiri/index.duckdb.sock.lock
```

### Version Mismatch After Upgrade

```bash
pkill -f "kiri.*daemon"
```

> **More issues**: See [full troubleshooting guide](#detailed-troubleshooting) below.

## For Developers

```bash
git clone https://github.com/CAPHTECH/kiri.git
cd kiri
pnpm install
pnpm run build
pnpm run test
pnpm run dev  # HTTP server on :8765
```

> **Guidelines**: See [AGENTS.md](AGENTS.md) for development standards.

## Documentation

| Document                                               | Description                                 |
| ------------------------------------------------------ | ------------------------------------------- |
| [Setup Guide](docs/setup.md)                           | Installation and MCP client configuration   |
| [Tools Reference](docs/tools-reference.md)             | Complete MCP tools documentation            |
| [Configuration](docs/configuration.md)                 | Environment variables and advanced settings |
| [Architecture](docs/overview.md)                       | System design and data flow                 |
| [Data Model](docs/data-model.md)                       | Database schema details                     |
| [Search & Ranking](docs/search-ranking.md)             | Search algorithms                           |
| [API Reference](docs/api-and-client.md)                | Complete API documentation                  |
| [Authoring Docs](docs/documentation-best-practices.md) | Writing metadata-rich documentation         |

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release notes.

**Recent highlights:**

- **v0.22.2**: files_search path_prefix filter fix (Issue #162)
- **v0.22.1**: FTS index WAL visibility fix (Issue #158)
- **v0.21.0**: Daemon Watch Mode (`--watch` flag for auto re-indexing)
- **v0.20.2**: Build artifact fix (dist/ contained stale Japanese text)

---

## Detailed Troubleshooting

### Daemon Initialization Timeout

**Problem**: "Daemon did not become ready within X seconds"

**Solutions**:

1. Increase timeout (Claude Code: `KIRI_DAEMON_READY_TIMEOUT=480`, Codex CLI: `startup_timeout_sec = 480`)
2. Check logs: `cat .kiri/index.duckdb.daemon.log`
3. Manual test: `kiri --repo . --db .kiri/index.duckdb --port 8765`

### Command Not Found

```bash
# Verify installation
npm list -g kiri-mcp-server

# Re-link
npm link kiri-mcp-server

# Or use npx
npx kiri-mcp-server@latest --repo . --db .kiri/index.duckdb
```

### Slow Indexing

1. Check size: `git ls-files | wc -l`
2. Review `.gitignore`
3. Add denylist: Create `.kiri/denylist.yml`:

```yaml
patterns:
  - "**/*.min.js"
  - "**/vendor/**"
```

### DuckDB Native Binding Errors

```bash
# Use pnpm link, not npm link
rm -rf node_modules pnpm-lock.yaml
pnpm install --frozen-lockfile
pnpm rebuild duckdb
pnpm run build
pnpm link --global
```

### Schema Mismatch (Degrade Mode)

```bash
pkill -f "kiri.*daemon"
rm -f .kiri/index.duckdb.sock.lock .kiri/index.duckdb.sock
kiri --repo . --db .kiri/index.duckdb --full
```

### Getting Help

1. Check logs: `.kiri/index.duckdb.daemon.log`
2. Enable debug: `DEBUG=kiri:*`
3. [GitHub Issues](https://github.com/CAPHTECH/kiri/issues)
4. [Discussions](https://github.com/CAPHTECH/kiri/discussions)

---

## License

MIT License - See [LICENSE](LICENSE).

## Acknowledgments

Built with [Model Context Protocol](https://modelcontextprotocol.io/), [DuckDB](https://duckdb.org/), and [tree-sitter](https://tree-sitter.github.io/).

---

**Status**: v0.22.2 (Beta) - Production-ready for MCP clients
