---
doc_id: "GUIDE-006"
title: "Setup Guide"
category: "guide"
tags:
  - setup
  - installation
  - mcp
  - configuration
service: "kiri"
---

# KIRI Setup Guide

Complete installation and configuration guide for KIRI MCP Server.

## Prerequisites

Before using KIRI, ensure you have:

| Requirement | Minimum Version | Check Command    |
| ----------- | --------------- | ---------------- |
| Node.js     | v18.0.0+        | `node --version` |
| npm         | v9.0.0+         | `npm --version`  |
| Git         | v2.0+           | `git --version`  |

## Installation

### Option A: Global Installation (Recommended)

```bash
npm install -g kiri-mcp-server
```

Verify installation:

```bash
kiri --version
```

### Option B: Use npx (No Permanent Installation)

No installation needed. Configure your MCP client to use `npx` directly.

## MCP Client Configuration

### Claude Code

Edit `~/.claude/mcp.json`:

**With npx:** (include `--` so npm doesn't swallow `--repo/--db`)

```json
{
  "mcpServers": {
    "kiri": {
      "command": "npx",
      "args": [
        "kiri-mcp-server@latest",
        "--",
        "--repo",
        ".",
        "--db",
        ".kiri/index.duckdb",
        "--watch"
      ]
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

**Large Repository Configuration (10,000+ files):**

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

### Codex CLI

Edit `~/.config/codex/mcp.toml`:

**With npx:**

```toml
[mcp_servers.kiri]
command = "npx"
args = ["kiri-mcp-server@latest", "--", "--repo", ".", "--db", ".kiri/index.duckdb", "--watch"]
startup_timeout_sec = 240
```

**With Global Installation:**

```toml
[mcp_servers.kiri]
command = "kiri"
args = ["--repo", ".", "--db", ".kiri/index.duckdb", "--watch"]
startup_timeout_sec = 240
```

### Other MCP Clients

KIRI works with any MCP-compatible client. General configuration:

- **Command**: `kiri` (global) or `npx kiri-mcp-server@latest --`
- **Note**: If you run `npx` directly in a shell and `--full` is ignored, omit the separator.
- **Arguments**: `--repo . --db .kiri/index.duckdb --watch`
- **Protocol**: stdio (JSON-RPC 2.0)

## First Run

1. **Restart your MCP client** after configuration
2. **Initial indexing** starts automatically (may take a few minutes for large projects)
3. **Verify connection** by asking Claude: "What files are in this project?"

## Watch Mode

KIRI automatically re-indexes when files change:

```bash
# Enable watch mode (recommended for active development)
kiri --repo . --db .kiri/index.duckdb --watch

# Customize debounce timing (default: 500ms)
kiri --repo . --db .kiri/index.duckdb --watch --debounce 1000
```

**Features:**

- Debouncing: Aggregates rapid changes
- Incremental indexing: Only changed files (10-100x faster)
- Background operation: Doesn't interrupt queries
- Denylist integration: Respects `.gitignore`

## Database Management

### Database Location

Default: `.kiri/index.duckdb` in your repository root.

### Rebuild Database

```bash
# Delete and rebuild
rm -rf .kiri/
# Restart MCP client - KIRI will automatically reindex
```

### Typical Database Sizes

| Project Size | Files        | Database Size |
| ------------ | ------------ | ------------- |
| Small        | <1,000       | 1-10 MB       |
| Medium       | 1,000-10,000 | 10-100 MB     |
| Large        | >10,000      | 100-500 MB    |

## Denylist Configuration

Create `.kiri/denylist.yml` to exclude additional patterns:

```yaml
patterns:
  - "**/*.min.js"
  - "**/vendor/**"
  - "**/dist/**"
```

## Next Steps

- [Tools Reference](tools-reference.md) - Learn about MCP tools
- [Configuration](configuration.md) - Environment variables and advanced settings
- [Troubleshooting](../README.md#troubleshooting) - Common issues and solutions
