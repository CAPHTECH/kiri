# KIRI MCP Server

> Intelligent code context extraction for LLMs via Model Context Protocol

[![Version](https://img.shields.io/badge/version-0.10.0-blue.svg)](package.json)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-Compatible-green.svg)](https://modelcontextprotocol.io/)

**KIRI** is an MCP (Model Context Protocol) server that provides intelligent code context extraction from Git repositories. It indexes your codebase into DuckDB and exposes semantic search tools for LLMs to find relevant code snippets efficiently.

## 🎯 Why KIRI?

- **🔌 MCP Native**: Plug-and-play integration with Claude Desktop, Codex CLI, and other MCP clients
- **🧠 Smart Context**: Extract minimal, relevant code fragments based on task goals (95% accuracy)
- **⚡ Fast**: Sub-second response time for most queries
- **🔍 Semantic Search**: Multi-word queries, dependency analysis, and BM25 ranking
- **👁️ Auto-Sync**: Watch mode automatically re-indexes when files change
- **🛡️ Reliable**: Degrade-first architecture works without optional extensions
- **📝 Phrase-Aware**: Recognizes compound terms (kebab-case, snake_case) for precise matching
- **🔒 Concurrency-Safe** _(v0.9.7+)_: Per-database queues, canonicalized DuckDB paths, and bootstrap-safe locking prevent FTS rebuild conflicts and keep locks consistent across symlinks—even on first run

## 🆕 What’s New in v0.9.8

- First-time bootstrap now skips redundant DuckDB locking, so `kiri` / `kiri-server` can index fresh repositories without deadlocking on their own locks.
- Added regression coverage (`tests/server/indexBootstrap.spec.ts`) to ensure repeated `ensureDatabaseIndexed` calls reuse the lock cleanly.
- All reliability upgrades from v0.9.7 (automatic ILIKE degrade during FTS rebuilds, canonicalized DB paths, expanded verify suite) remain in effect.

## ⚙️ Prerequisites

Before using KIRI, ensure you have:

- **Node.js** v18.0.0 or higher
- **npm** v9.0.0 or higher
- **Git** v2.0 or higher
- A Git repository to index

Check your versions:

```bash
node --version  # Should be >= v18.0.0
npm --version   # Should be >= v9.0.0
git --version   # Should be >= v2.0
```

## 🚀 Quick Start for MCP Users

### Step 1: Install KIRI

Choose one of the following methods:

**Option A: Global Installation (Recommended)**

```bash
npm install -g kiri-mcp-server
```

> **Note**: This installs the `kiri` command globally. You can verify with `kiri --version`.

**Option B: Use npx (No Permanent Installation)**

No permanent installation needed—`npx` downloads and caches the package on first use. Just configure your MCP client to use `npx`.

### Step 2: Configure Your MCP Client

#### For Claude Code

Edit `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "kiri": {
      "command": "npx",
      "args": ["kiri-mcp-server@latest", "--repo", ".", "--db", ".kiri/index.duckdb", "--watch"]
    }
  }
}
```

**With Global Installation:**

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

**Timeout Configuration (Claude Code)**

For very large repositories (10,000+ files), you may need to increase the timeout:

```json
{
  "mcpServers": {
    "kiri": {
      "command": "kiri",
      "args": ["--repo", ".", "--db", ".kiri/index.duckdb", "--watch"],
      "env": {
        "KIRI_DAEMON_READY_TIMEOUT": "480"
      }
    }
  }
}
```

> **Note**: The example shows `480` seconds (8 minutes) for very large repositories (>20,000 files). The default `240` seconds (4 minutes) is sufficient for most projects with <10,000 files.

| Variable                    | Default          | Description                                                                                                           |
| --------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| `KIRI_DAEMON_READY_TIMEOUT` | `240`            | Daemon initialization timeout in seconds. Increase for very large repositories                                        |
| `KIRI_SOCKET_DIR`           | OS tmp directory | Directory for Unix socket fallback when repo paths are too long (e.g., `/var/run/kiri`). Keeps worktree sockets short |

> **Tip**: If you encounter `listen EINVAL` on deep worktrees, set `export KIRI_SOCKET_DIR=/var/run/kiri` (or any short 0700 directory) before launching `kiri`. This fallback ships in v0.9.9+, and an explicit path keeps logs and cleanup predictable.

**Dart Analysis Server Configuration:**

For projects containing Dart code, KIRI uses the Dart Analysis Server to extract accurate symbol information. The following environment variables control the Dart analyzer behavior:

| Variable                       | Default | Description                                                                                       |
| ------------------------------ | ------- | ------------------------------------------------------------------------------------------------- |
| `DART_SDK_DETECT_TIMEOUT_MS`   | `5000`  | Timeout in milliseconds for SDK detection (prevents hanging on network issues)                    |
| `DART_ANALYSIS_MAX_CLIENTS`    | `8`     | Maximum concurrent Dart Analysis Server processes (prevents memory exhaustion on large monorepos) |
| `DART_ANALYSIS_CLIENT_WAIT_MS` | `10000` | Max wait time in milliseconds for available analysis server slot                                  |
| `DART_ANALYSIS_IDLE_MS`        | `60000` | Idle time in milliseconds before disposing unused analysis server (60s default)                   |
| `DART_FILE_QUEUE_TTL_MS`       | `30000` | TTL in milliseconds for file-level request queues (prevents memory leaks)                         |

**When to adjust these values:**

- **Large Dart projects (>500 files)**: Increase `DART_ANALYSIS_MAX_CLIENTS` to 16 or 32
- **Network/UNC path issues**: Decrease `DART_SDK_DETECT_TIMEOUT_MS` to 2000 for faster failure
- **Memory constraints**: Decrease `DART_ANALYSIS_MAX_CLIENTS` to 4 and increase `DART_ANALYSIS_IDLE_MS` to 30000
- **Monorepo with many workspaces**: Increase `DART_ANALYSIS_CLIENT_WAIT_MS` to 30000

#### For Codex CLI

Edit `~/.config/codex/mcp.toml`:

```toml
[mcp_servers.kiri]
command = "npx"
args = ["kiri-mcp-server@latest", "--repo", ".", "--db", ".kiri/index.duckdb", "--watch"]
startup_timeout_sec = 240
```

**With Global Installation:**

```toml
[mcp_servers.kiri]
command = "kiri"
args = ["--repo", ".", "--db", ".kiri/index.duckdb", "--watch"]
startup_timeout_sec = 240
```

| Parameter             | Default | Description                                                                   |
| --------------------- | ------- | ----------------------------------------------------------------------------- |
| `startup_timeout_sec` | `30`    | Daemon initialization timeout in seconds. Set to `240` for large repositories |

**Note**: The default internal timeout was increased from 30s to 240s in v0.3.0. We recommend setting `startup_timeout_sec = 240` explicitly for Codex CLI.

### Step 3: Restart Your MCP Client

Restart Claude Desktop or Codex CLI to load the KIRI server. On first startup, KIRI automatically indexes your repository (this may take a few minutes for large projects).

### Step 4: Start Using KIRI Tools

Once configured, you can use KIRI tools in your conversations with Claude:

- **Search for files**: "Find files related to authentication"
- **Get code context**: "Show me the implementation of the user login flow"
- **Analyze dependencies**: "What files depend on utils.ts?"
- **Extract snippets**: "Show me the handleRequest function"

## 📋 MCP Tools Reference

KIRI provides 5 MCP tools for intelligent code exploration:

### 1. context_bundle

**Extract relevant code context based on task goals (95% accuracy)**

The most powerful tool for getting started with unfamiliar code. Provide a task description, and KIRI returns the most relevant code snippets using phrase-aware tokenization and path-based scoring.

Tip: Avoid leading command words like `find` or `show`; instead list concrete modules, files, and observed symptoms to keep rankings sharp.

**v0.8.0 improvements:**

- **⚡ Compact mode default (BREAKING)**: `compact: true` is now default, reducing token usage by ~95% (55K → 2.5K tokens). Set `compact: false` to restore full preview mode.
- **🔧 Separated config penalties**: Configuration files (`.json`, `.yaml`, `.env`) now have independent 95% penalty (×0.05), separate from documentation penalty (×0.5)
- **🌐 Multi-language config support**: Recognizes config files across all languages (`package.json`, `tsconfig.json`, `composer.json`, `Gemfile`, etc.)
- **🛡️ Production hardening**: Memory leak prevention in WarningManager, configurable warning limits, improved path matching

**v0.7.0 improvements:**

- **Multiplicative penalties**: Documentation files now penalized by ×0.5 (50% reduction) instead of additive -2.0
- **Implementation prioritization**: Implementation files rank 3-5× higher than documentation
- **Unified boosting logic**: Consistent file ranking across `files_search` and `context_bundle`
- **Configurable profiles**: `boost_profile` parameter supports "default" (implementation-first), "docs" (documentation-first), or "none" (natural BM25)

**When to use:**

- Understanding how a feature works
- Finding implementation patterns
- Gathering context before making changes
- Exploring unfamiliar codebases

**Example:**

```typescript
// Request
{
  "goal": "auth token refresh bug; file=src/server/auth/session.ts; symptom=expired tokens accepted",
  "limit": 10
}

// Returns: Relevant snippets from auth-related files, ranked by relevance
```

**Parameters:**

| Parameter       | Type    | Required | Description                                                                                                                                                                                                             |
| --------------- | ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `goal`          | string  | Yes      | Task description or question about the code                                                                                                                                                                             |
| `limit`         | number  | No       | Max snippets to return (default: 12, max: 20)                                                                                                                                                                           |
| `compact`       | boolean | No       | Return only metadata without preview (default: **true** in v0.8.0+, false in v0.7)                                                                                                                                      |
| `boost_profile` | string  | No       | File type boosting: `"default"` (prioritizes src/, blacklists docs/), `"docs"` (prioritizes .md/.yaml, includes docs/ directory), `"balanced"` (equal weight for docs and impl, NEW in v0.9.10), `"none"` (no boosting) |

### 2. files_search

**Full-text search with multi-word queries**

Fast search across all indexed files. Supports multi-word queries, hyphenated terms, and BM25 ranking when available.

**When to use:**

- Finding files by name or content
- Searching for specific keywords or patterns
- Locating API endpoints or configuration

**Example:**

```typescript
// Request
{
  "query": "MCP server handler",
  "limit": 20
}

// Returns: Files containing any of these words (OR logic)
```

**Query Syntax:**

- Multi-word: `"tools call implementation"` → Finds files containing ANY word
- Hyphenated: `"MCP-server-handler"` → Splits on hyphens and searches each part
- Single word: `"DuckDB"` → Exact match

**Parameters:**

| Parameter       | Type   | Required | Description                                                                                                                                                  |
| --------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `query`         | string | Yes      | Search keywords or phrase                                                                                                                                    |
| `limit`         | number | No       | Max results to return (default: 50, max: 200)                                                                                                                |
| `lang`          | string | No       | Filter by language (e.g., "typescript", "python")                                                                                                            |
| `ext`           | string | No       | Filter by extension (e.g., ".ts", ".md")                                                                                                                     |
| `path_prefix`   | string | No       | Filter by path prefix (e.g., "src/auth/")                                                                                                                    |
| `boost_profile` | string | No       | File type boosting: `"default"` (prioritizes src/, blacklists docs/), `"docs"` **(prioritizes .md/.yaml, includes docs/ directory)**, `"none"` (no boosting) |

### 3. snippets_get

**Retrieve code snippets with symbol boundaries**

Get specific code sections from a file, aligned to function/class boundaries for better context.

**When to use:**

- Reading a specific function or class
- Extracting a code section you already know about
- Getting implementation details

**Example:**

```typescript
// Request
{
  "path": "src/server/handlers.ts",
  "start_line": 100
}

// Returns: Code snippet starting at line 100, aligned to symbol boundary
```

**Parameters:**

| Parameter    | Type   | Required | Description                           |
| ------------ | ------ | -------- | ------------------------------------- |
| `path`       | string | Yes      | File path relative to repository root |
| `start_line` | number | No       | Starting line number                  |
| `end_line`   | number | No       | Ending line number (inclusive)        |

### 4. deps_closure

**Get dependency graph neighborhood**

Analyze file dependencies to understand impact and relationships. Supports both outbound (what this file imports) and inbound (what imports this file) analysis.

**When to use:**

- Understanding what a file depends on
- Finding all files affected by a change (impact analysis)
- Tracing import chains
- Refactoring planning

**Example:**

```typescript
// Outbound: What does this file import?
{
  "path": "src/server/handlers.ts",
  "direction": "outbound",
  "max_depth": 2
}

// Inbound: What files import this file?
{
  "path": "src/utils/parser.ts",
  "direction": "inbound",
  "max_depth": 3
}
```

**Parameters:**

| Parameter          | Type    | Required | Description                           |
| ------------------ | ------- | -------- | ------------------------------------- |
| `path`             | string  | Yes      | Starting file path                    |
| `direction`        | string  | Yes      | "outbound" or "inbound"               |
| `max_depth`        | number  | No       | Max traversal depth (default: 3)      |
| `include_packages` | boolean | No       | Include npm packages (default: false) |

### 5. semantic_rerank

**Re-rank candidates by semantic similarity**

Refine search results by semantic relevance to your specific query. Useful when you have too many results and need better ranking.

**When to use:**

- After files_search returns too many results
- When you need more precise relevance ranking
- Refining context_bundle results for specific needs

**Example:**

```typescript
// Request
{
  "text": "user authentication with OAuth2",
  "candidates": [
    { "path": "src/auth/oauth.ts", "score": 0.8 },
    { "path": "src/auth/jwt.ts", "score": 0.7 },
    { "path": "src/utils/crypto.ts", "score": 0.6 }
  ],
  "k": 2
}

// Returns: Top 2 candidates re-ranked by semantic similarity
```

**Parameters:**

| Parameter    | Type   | Required | Description                          |
| ------------ | ------ | -------- | ------------------------------------ |
| `text`       | string | Yes      | Query or goal text for comparison    |
| `candidates` | array  | Yes      | Array of {path, score?} objects      |
| `k`          | number | No       | Number of top results (default: all) |

## 💡 Common Use Cases

### 1. Understanding a New Codebase

**Goal**: Quickly understand how authentication works in an unfamiliar project

```
You: "How does user authentication work in this project?"

Claude (using KIRI):
1. Uses context_bundle with goal "user authentication flow JWT validation session management"
2. Analyzes returned snippets
3. Explains the authentication flow with code references
```

### 2. Finding Related Code

**Goal**: Find all files related to API endpoints

```
You: "Find all API endpoint handlers"

Claude (using KIRI):
1. Uses files_search with query "API endpoint handler"
2. Uses deps_closure to find related files
3. Lists all relevant files with descriptions
```

### 3. Impact Analysis

**Goal**: Understand what will be affected by changing a utility function

```
You: "If I change the parseRequest function in utils.ts, what will be affected?"

Claude (using KIRI):
1. Uses deps_closure with direction="inbound" on utils.ts
2. Analyzes all dependent files
3. Explains potential impact of the change
```

### 4. Code Review Preparation

**Goal**: Get context for reviewing a pull request

```
You: "Show me the context for the authentication module changes"

Claude (using KIRI):
1. Uses context_bundle for authentication-related code
2. Uses snippets_get for specific changed files
3. Provides comprehensive context for review
```

## 🔧 Advanced Configuration

### Watch Mode

KIRI can automatically re-index your repository when files change:

```bash
# Enable watch mode (recommended for active development)
kiri --repo . --db .kiri/index.duckdb --watch

# Customize debounce timing (default: 500ms)
kiri --repo . --db .kiri/index.duckdb --watch --debounce 1000
```

**Watch Mode Features:**

- **Debouncing**: Aggregates rapid changes to minimize reindex operations
- **Incremental Indexing**: Only reindexes changed files (10-100x faster)
- **Background Operation**: Doesn't interrupt ongoing queries
- **Denylist Integration**: Respects `.gitignore` and `denylist.yml`
- **Lock Management**: Prevents concurrent indexing
- **Statistics**: Tracks reindex count, duration, and queue depth

### Tokenization Strategy

Control how KIRI tokenizes and matches compound terms using the `KIRI_TOKENIZATION_STRATEGY` environment variable:

```bash
# Phrase-aware (default): Recognizes kebab-case/snake_case as phrases
export KIRI_TOKENIZATION_STRATEGY=phrase-aware

# Legacy: Traditional word-by-word tokenization
export KIRI_TOKENIZATION_STRATEGY=legacy

# Hybrid: Both phrase and word-level matching
export KIRI_TOKENIZATION_STRATEGY=hybrid
```

**Strategies:**

- **`phrase-aware`** (default): Compound terms like `page-agent`, `user_profile` are treated as single phrases with 2× scoring weight. Best for codebases with consistent naming conventions.
- **`legacy`**: Traditional tokenization that splits all delimiters. Use for backward compatibility.
- **`hybrid`**: Combines both strategies for maximum flexibility.

### Database Auto-Gitignore

KIRI automatically creates `.gitignore` files in database directories to prevent accidental commits:

```typescript
// Enabled by default
const db = await DuckDBClient.connect({
  databasePath: ".kiri/index.duckdb",
  autoGitignore: true, // Creates .gitignore with "*" pattern
});

// Disable if needed
const db = await DuckDBClient.connect({
  databasePath: ".kiri/index.duckdb",
  autoGitignore: false,
});
```

**Behavior:**

- Only creates `.gitignore` if directory is inside a Git repository
- Never overwrites existing `.gitignore` files
- Uses wildcard pattern (`*`) to ignore all database files

### File Type Boosting

Control search ranking behavior with the `boost_profile` parameter:

- **`"default"`** (default): Prioritizes implementation files (`src/*.ts`) over documentation
  - Implementation files get 30% boost, documentation files get 50% penalty
  - Config files heavily penalized (95% reduction)
  - `docs/` directory is blacklisted
- **`"docs"`**: Prioritizes documentation files (`*.md`) over implementation
  - Documentation files get 50% boost, implementation files get 50% penalty
  - `docs/` directory is included in search results
- **`"balanced"`** (NEW in v0.9.10): Equal weight for docs and implementation
  - Both documentation and implementation files: no penalty/boost (1.0x)
  - Config files: relaxed penalty (0.3x, compared to 0.05x in default)
  - `docs/` directory is included in search results
  - No path-specific multipliers (treats all `src/` equally)
- **`"none"`**: Pure BM25 scoring without file type adjustments

```typescript
// Find implementation files (default behavior)
files_search({ query: "authentication", boost_profile: "default" });

// Find documentation
files_search({ query: "setup guide", boost_profile: "docs" });

// Balanced search (docs and code equally weighted)
files_search({ query: "authentication design", boost_profile: "balanced" });

// Pure BM25 ranking without boosting
files_search({ query: "API", boost_profile: "none" });
```

### Security Configuration

KIRI automatically filters sensitive files and masks sensitive values:

- `.env*`, `*.pem`, `secrets/**` are excluded from indexing
- Sensitive values in responses are masked with `***`
- Respects both `.gitignore` and custom denylist patterns

## 🔧 Troubleshooting

### Common Issues

#### Daemon Initialization Timeout

**Problem**: MCP client shows "Daemon did not become ready within X seconds"

**Solutions**:

1. **Increase timeout** for large repositories:
   - Claude Code: Set `KIRI_DAEMON_READY_TIMEOUT` to `480` or higher
   - Codex CLI: Set `startup_timeout_sec = 480` or higher

2. **Check daemon logs**:

   ```bash
   cat .kiri/index.duckdb.daemon.log
   ```

3. **Manual indexing** to verify repository can be indexed:
   ```bash
   kiri --repo . --db .kiri/index.duckdb --port 8765
   ```

#### Command Not Found

**Problem**: `kiri: command not found` when using global installation

**Solutions**:

1. **Verify installation**:

   ```bash
   npm list -g kiri-mcp-server
   ```

2. **Re-link package**:

   ```bash
   npm link kiri-mcp-server
   ```

3. **Use npx instead**:
   ```bash
   npx kiri-mcp-server@latest --repo . --db .kiri/index.duckdb
   ```

#### Slow Indexing

**Problem**: Initial indexing takes too long

**Solutions**:

1. **Check repository size**:

   ```bash
   git ls-files | wc -l  # Count tracked files
   ```

2. **Review `.gitignore`**: Ensure large directories (node_modules, build artifacts) are excluded

3. **Use denylist**: Create `.kiri/denylist.yml` to exclude additional patterns:
   ```yaml
   patterns:
     - "**/*.min.js"
     - "**/vendor/**"
     - "**/dist/**"
   ```

#### Disk Space Issues

**Problem**: Database file grows too large

**Solutions**:

1. **Check database size**:

   ```bash
   du -h .kiri/index.duckdb
   ```

2. **Force reindex with cleanup**:

   ```bash
   rm -f .kiri/index.duckdb*
   kiri --repo . --db .kiri/index.duckdb --port 8765
   ```

3. **Typical database sizes**:
   - Small project (<1,000 files): 1-10 MB
   - Medium project (1,000-10,000 files): 10-100 MB
   - Large project (>10,000 files): 100-500 MB

#### DuckDB Native Binding Errors

**Problem**: Error message like `Cannot find module '.../duckdb.node'` when running from a cloned repository

**Root Cause**: Using `npm link` with pnpm-installed packages causes native module path resolution issues

**Solutions**:

1. **Use pnpm link instead of npm link**:

   ```bash
   # Remove existing npm link (if any)
   npm unlink -g kiri-mcp-server 2>/dev/null || true

   # Clean and reinstall
   rm -rf node_modules pnpm-lock.yaml
   pnpm install --frozen-lockfile

   # Verify native binding exists
   ls -la node_modules/.pnpm/duckdb@*/node_modules/duckdb/lib/binding/duckdb.node

   # If missing, rebuild DuckDB
   pnpm rebuild duckdb

   # Build and link (use pnpm, not npm!)
   pnpm run build
   pnpm link --global
   ```

2. **Prerequisites for building DuckDB**:
   - **macOS**: Install Xcode Command Line Tools: `xcode-select --install`
   - **Node.js**: Version 20 or higher: `node -v`
   - **Network**: Access to `npm.duckdb.org` for prebuilt binaries

3. **Unlink when done**:
   ```bash
   pnpm unlink --global kiri-mcp-server
   ```

### Getting Help

If you encounter issues not covered here:

1. **Check daemon logs**: `.kiri/index.duckdb.daemon.log`
2. **Enable verbose logging**: Set `DEBUG=kiri:*` environment variable
3. **Report issues**: [GitHub Issues](https://github.com/CAPHTECH/kiri/issues)
4. **Community support**: [GitHub Discussions](https://github.com/CAPHTECH/kiri/discussions)

## 📝 Supported Languages

KIRI provides AST-based symbol extraction for the following languages:

| Language       | Extensions    | Symbol Types                                                                             | Parser                              |
| -------------- | ------------- | ---------------------------------------------------------------------------------------- | ----------------------------------- |
| **TypeScript** | `.ts`, `.tsx` | `class`, `interface`, `enum`, `function`, `method`                                       | TypeScript Compiler API             |
| **Swift**      | `.swift`      | `class`, `struct`, `protocol`, `enum`, `extension`, `func`, `init`, `property`           | tree-sitter-swift                   |
| **PHP**        | `.php`        | `class`, `interface`, `trait`, `function`, `method`, `property`, `constant`, `namespace` | tree-sitter-php (pure & HTML-mixed) |
| **Java**       | `.java`       | `class`, `interface`, `enum`, `annotation`, `method`, `constructor`, `field`             | tree-sitter-java                    |
| **Dart**       | `.dart`       | `class`, `mixin`, `enum`, `extension`, `function`, `method`, `getter`, `setter`          | Dart Analysis Server                |

**Dart Integration Features:**

- Full IDE-quality symbol extraction via official Dart Analysis Server
- Automatic SDK detection from PATH or `DART_SDK` environment variable
- Memory-efficient client pooling with configurable limits
- Windows path normalization for case-insensitive filesystems
- Graceful degradation when Dart SDK is unavailable

Other languages are detected and indexed but use full-file snippets instead of symbol-level extraction. Support for additional languages (Rust, Go, Python, etc.) is planned.

## 🏗️ How It Works

```
┌─────────────────┐         ┌──────────────────────┐         ┌────────────┐
│   MCP Client    │ <────>  │   KIRI MCP Server    │ <────>  │   DuckDB   │
│ (Claude, Codex) │  stdio  │   (JSON-RPC 2.0)     │         │  Database  │
└─────────────────┘         └──────────────────────┘         └────────────┘
                                       │
                                       ▼
                             ┌──────────────────┐
                             │     Indexer      │
                             │  Git Scanner     │
                             │  AST Parser      │
                             │  FTS Indexing    │
                             └──────────────────┘
```

**Architecture:**

1. **Indexer**: Scans your Git repository, extracts code structure and content
2. **DuckDB Database**: Stores indexed data with efficient query support
3. **MCP Server**: Exposes JSON-RPC 2.0 tools via stdio for MCP clients
4. **Watch Mode** (optional): Monitors file changes and re-indexes automatically

**Data Model:**

- **blob/tree separation**: Deduplicates renamed/copied files (Git-like model)
- **Symbol extraction**: AST-based function/class boundaries for precise snippets
- **FTS indexing**: Full-text search with BM25 ranking when available
- **Dependency graph**: Import/export relationships for impact analysis

See [docs/architecture.md](docs/architecture.md) for detailed technical information.

## 📚 Additional Resources

### Documentation

- [Examples](examples/README.md) - Real-world usage examples
- [Architecture](docs/overview.md) - System design and data flow
- [Data Model](docs/data-model.md) - Database schema details
- [Search & Ranking](docs/search-ranking.md) - Search algorithms
- [API Reference](docs/api-and-client.md) - Complete API documentation

### Performance

| Metric                        | Target | Current       |
| ----------------------------- | ------ | ------------- |
| **Time to First Result**      | ≤ 1.0s | ✅ 0.8s       |
| **Precision @ 10**            | ≥ 0.7  | ✅ 0.75       |
| **Token Reduction (compact)** | ≥ 90%  | ✅ 95% (v0.8) |

### Evaluation & Quality Assurance

KIRI includes a **Golden Set Evaluation System** for tracking search accuracy over time using representative queries.

**Metrics:**

- **P@10** (Precision at K=10): Fraction of relevant results in top 10 (target: ≥0.70)
- **TFFU** (Time To First Useful): Time until first relevant result appears (target: ≤1000ms)

**For Developers:**

```bash
# Run benchmark evaluation (local only)
pnpm run eval:golden

# Verbose output
pnpm run eval:golden:verbose
```

The benchmark system evaluates 5+ representative queries across categories (bugfix, feature, refactor, infra, docs) and outputs:

- JSON: Detailed per-query results (`var/eval/latest.json`)
- Markdown: Summary table (`var/eval/latest.md`)

**Documentation:**

- [Golden Set Guide](tests/eval/goldens/README.md) - Query format, categories, adding queries
- [Results Recording](tests/eval/results/README.md) - Tracking improvements over time

See [docs/testing.md](docs/testing.md) for complete testing and evaluation guidelines.

### Community

- [GitHub Issues](https://github.com/CAPHTECH/kiri/issues) - Bug reports and feature requests
- [Discussions](https://github.com/CAPHTECH/kiri/discussions) - Questions and community support
- [Contributing Guide](AGENTS.md) - How to contribute

## 🛠️ For Developers

### Local Development

```bash
# Clone and setup
git clone https://github.com/CAPHTECH/kiri.git
cd kiri
pnpm install

# Build
pnpm run build

# Link globally for testing (IMPORTANT: use pnpm link, not npm link)
pnpm link --global

# Verify DuckDB native binding is installed
ls -la node_modules/.pnpm/duckdb@*/node_modules/duckdb/lib/binding/duckdb.node

# If duckdb.node is missing, rebuild it
pnpm rebuild duckdb

# Run tests
pnpm run test

# Start in development mode (HTTP server on :8765)
pnpm run dev

# Unlink when done
pnpm unlink --global kiri-mcp-server
```

### Commands Reference

```bash
# Server modes
kiri --repo <path> --db <db-path>                    # stdio mode (MCP)
kiri --repo <path> --db <db-path> --port 8765        # HTTP mode (testing)
kiri --repo <path> --db <db-path> --reindex          # Force re-indexing
kiri --repo <path> --db <db-path> --watch            # Enable watch mode

# Development
pnpm run build                # Build TypeScript
pnpm run dev                  # HTTP server with hot reload
pnpm run test                 # Run all tests
pnpm run check                # Lint + test
```

### Project Structure

```
kiri/
├── src/
│   ├── indexer/      # Git scanning, AST parsing, schema management
│   ├── server/       # MCP server, JSON-RPC handlers
│   ├── client/       # CLI utilities, daemon management
│   └── shared/       # DuckDB client, utilities
├── tests/            # Test files (mirrors src/)
├── docs/             # Architecture documentation
├── config/           # YAML configuration schemas
├── sql/              # SQL schema definitions
└── examples/         # Usage examples
```

See [AGENTS.md](AGENTS.md) for detailed development guidelines.

## 📄 License

MIT License - See [LICENSE](LICENSE) for details.

## 🙏 Acknowledgments

Built with:

- [Model Context Protocol](https://modelcontextprotocol.io/) - Standard for LLM context
- [DuckDB](https://duckdb.org/) - Embedded analytical database
- [tree-sitter](https://tree-sitter.github.io/) - Parser generator for AST extraction

---

**Status**: v0.8.0 (Beta) - Production-ready for MCP clients

**Breaking Changes in v0.8.0**: `compact` mode is now default. Existing integrations should set `compact: false` explicitly if full preview content is required. See [CHANGELOG.md](CHANGELOG.md) for migration guide.

For questions or support, please open a [GitHub issue](https://github.com/CAPHTECH/kiri/issues).
