---
doc_id: "GUIDE-007"
title: "MCP Tools Reference"
category: "guide"
tags:
  - mcp
  - tools
  - api
  - reference
service: "kiri"
---

# KIRI MCP Tools Reference

Complete reference for all KIRI MCP tools.

## Overview

| Tool              | Purpose                        | When to Use                                 |
| ----------------- | ------------------------------ | ------------------------------------------- |
| `context_bundle`  | Extract relevant code context  | Understanding features, exploring codebases |
| `files_search`    | Full-text file search          | Finding files by name or content            |
| `snippets_get`    | Retrieve code sections         | Reading specific functions or classes       |
| `deps_closure`    | Dependency graph analysis      | Impact analysis, refactoring                |
| `semantic_rerank` | Re-rank by semantic similarity | Refining search results                     |

---

## context_bundle

**Extract relevant code context based on task goals**

The most powerful tool for getting started with unfamiliar code. Provide a task description, and KIRI returns the most relevant code snippets.

### Parameters

| Parameter          | Type    | Required | Default   | Description                                                |
| ------------------ | ------- | -------- | --------- | ---------------------------------------------------------- |
| `goal`             | string  | Yes      | -         | Task description or question about the code                |
| `limit`            | number  | No       | 7         | Max snippets to return (max: 20)                           |
| `compact`          | boolean | No       | true      | Return only metadata without preview                       |
| `includeWhy`       | boolean | No       | false     | Keep `why[]` even when compact mode suppresses them        |
| `boost_profile`    | string  | No       | "default" | File type boosting mode                                    |
| `path_prefix`      | string  | No       | -         | Filter by path prefix                                      |
| `category`         | string  | No       | -         | Query category for adaptive K                              |
| `metadata_filters` | object  | No       | -         | Filter by document metadata                                |
| `why_mode`         | string  | No       | "full"    | `"full"` returns verbose tags, `"terse"` shortens prefixes |

### Boost Profiles

| Profile    | Behavior                                         |
| ---------- | ------------------------------------------------ |
| `default`  | Prioritizes `src/`, deprioritizes `docs/`        |
| `code`     | Strongly deprioritizes docs/config (95% penalty) |
| `docs`     | Prioritizes `.md`/`.yaml`, includes `docs/`      |
| `balanced` | Equal weight for docs and implementation         |
| `none`     | Pure BM25 scoring                                |

### Examples

**Basic usage:**

```json
{
  "goal": "auth token refresh bug; file=src/server/auth/session.ts; symptom=expired tokens accepted",
  "limit": 10
}
```

**Documentation search:**

```json
{
  "goal": "setup guide authentication",
  "boost_profile": "docs"
}
```

**With metadata filter:**

```json
{
  "goal": "observability",
  "metadata_filters": { "tags": ["sre"] }
}
```

### Best Practices

- **Be specific**: Include file names, error messages, symptoms
- **Avoid imperatives**: "auth flow JWT validation" not "Find where authentication happens"
- **Use compact mode**: Default is `compact: true` (95% token savings)
- **Need explanations?** Pass `includeWhy: true` when using compact mode to keep `why[]`
- **Follow up with snippets_get**: Get full code after identifying relevant files. Pass `range_source: item.rangeSource` so clamped windows stay intact even if the default view changes.

---

## files_search

**Full-text search with multi-word queries**

Fast search across all indexed files with BM25 ranking.

### Parameters

| Parameter          | Type    | Required | Default   | Description                      |
| ------------------ | ------- | -------- | --------- | -------------------------------- |
| `query`            | string  | Yes      | -         | Search keywords or phrase        |
| `limit`            | number  | No       | 50        | Max results (max: 200)           |
| `lang`             | string  | No       | -         | Filter by language               |
| `ext`              | string  | No       | -         | Filter by extension              |
| `path_prefix`      | string  | No       | -         | Filter by path prefix            |
| `boost_profile`    | string  | No       | "default" | File type boosting mode          |
| `compact`          | boolean | No       | true      | Omit previews unless you opt out |
| `metadata_filters` | object  | No       | -         | Filter by document metadata      |

### Query Syntax

- **Multi-word**: `"tools call implementation"` → Finds files containing ANY word
- **Hyphenated**: `"MCP-server-handler"` → Splits on hyphens
- **Metadata**: `tag:observability` → Filter by front matter

### Examples

```json
{
  "query": "MCP server handler",
  "limit": 20
}
```

```json
{
  "query": "authentication",
  "lang": "typescript",
  "path_prefix": "src/auth/"
}
```

---

## snippets_get

**Retrieve code snippets with symbol boundaries**

Get specific code sections from a file, aligned to function/class boundaries.

### Parameters

| Parameter              | Type    | Required | Default  | Description                                                     |
| ---------------------- | ------- | -------- | -------- | --------------------------------------------------------------- |
| `path`                 | string  | Yes      | -        | File path relative to repository root                           |
| `start_line`           | number  | No       | -        | Starting line number                                            |
| `end_line`             | number  | No       | -        | Ending line number                                              |
| `view`                 | string  | No       | "symbol" | Retrieval strategy (override with `KIRI_SNIPPETS_DEFAULT_VIEW`) |
| `compact`              | boolean | No       | false    | Return only metadata                                            |
| `include_line_numbers` | boolean | No       | false    | Prefix lines with numbers                                       |
| `range_source`         | string  | No       | -        | `"symbol"`, `"window"`, or `"clamped"` from `context_bundle`    |

### View Modes

| Mode     | Behavior                                             |
| -------- | ---------------------------------------------------- |
| `auto`   | Uses symbol boundaries if available, else line range |
| `symbol` | Forces symbol-based snippets (default behavior)      |
| `lines`  | Line-based retrieval (ignores symbols)               |
| `full`   | Returns entire file (500 line limit)                 |

> **Hint**: Pass the `rangeSource` emitted by `context_bundle` as `range_source` so that clamped windows stay compact even when the default view is symbol.

### Examples

**Get entire file:**

```json
{
  "path": "src/server/handlers.ts",
  "view": "full"
}
```

**Get specific function:**

```json
{
  "path": "src/server/handlers.ts",
  "start_line": 100,
  "view": "symbol"
}
```

**With line numbers:**

```json
{
  "path": "src/auth/login.ts",
  "include_line_numbers": true
}
```

---

## deps_closure

**Get dependency graph neighborhood**

Analyze file dependencies for impact analysis and refactoring.

### Parameters

| Parameter          | Type    | Required | Default | Description             |
| ------------------ | ------- | -------- | ------- | ----------------------- |
| `path`             | string  | Yes      | -       | Starting file path      |
| `direction`        | string  | Yes      | -       | "outbound" or "inbound" |
| `max_depth`        | number  | No       | 3       | Max traversal depth     |
| `include_packages` | boolean | No       | false   | Include npm packages    |

### Directions

- **outbound**: What does this file import?
- **inbound**: What files import this file?

### Examples

**Find consumers of a utility:**

```json
{
  "path": "src/utils/parser.ts",
  "direction": "inbound",
  "max_depth": 2
}
```

**Find dependencies:**

```json
{
  "path": "src/server/handlers.ts",
  "direction": "outbound",
  "max_depth": 3,
  "include_packages": true
}
```

---

## semantic_rerank

**Re-rank candidates by semantic similarity**

Refine search results by semantic relevance to your specific query.

### Parameters

| Parameter    | Type   | Required | Default | Description                       |
| ------------ | ------ | -------- | ------- | --------------------------------- |
| `text`       | string | Yes      | -       | Query or goal text for comparison |
| `candidates` | array  | Yes      | -       | Array of `{path, score?}` objects |
| `k`          | number | No       | all     | Number of top results             |

### Example

```json
{
  "text": "user authentication with OAuth2",
  "candidates": [
    { "path": "src/auth/oauth.ts", "score": 0.8 },
    { "path": "src/auth/jwt.ts", "score": 0.7 },
    { "path": "src/utils/crypto.ts", "score": 0.6 }
  ],
  "k": 2
}
```

---

## Token-Saving Workflow

Recommended two-tier approach for minimal token usage:

1. **Explore** with `context_bundle` (compact mode, default)
2. **Read details** with `snippets_get` for specific files

```
context_bundle (compact: true)  →  List of relevant paths (~2.5K tokens)
         ↓
snippets_get (path: "...")      →  Full code for selected file
```

This approach reduces token usage by 95% compared to fetching full previews upfront.
