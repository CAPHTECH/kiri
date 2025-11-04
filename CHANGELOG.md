# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2025-01-04

### Changed

- **BREAKING**: Renamed all MCP tool names from dot notation to underscore notation to comply with MCP API naming requirements (`^[a-zA-Z0-9_-]+$`)
  - `context.bundle` → `context_bundle`
  - `semantic.rerank` → `semantic_rerank`
  - `files.search` → `files_search`
  - `snippets.get` → `snippets_get`
  - `deps.closure` → `deps_closure`
- Updated all error messages, documentation, and configuration files to reflect new tool names
- This change resolves compatibility issues with codex CLI and other MCP clients that enforce strict tool name validation

### Migration Guide

If you have existing code or scripts that reference the old tool names, update them as follows:

```diff
- const result = await mcp.call("context.bundle", { goal: "..." })
+ const result = await mcp.call("context_bundle", { goal: "..." })

- const files = await mcp.call("files.search", { query: "..." })
+ const files = await mcp.call("files_search", { query: "..." })
```

Configuration files should also be updated:

```diff
mcp:
  tools:
-   - context.bundle
-   - files.search
+   - context_bundle
+   - files_search
```

## [0.3.0] - 2025-01-03

### Added

- Initial public release
- Context bundle extraction with keyword matching and semantic similarity
- Files search with FTS support
- Snippets retrieval with symbol boundaries
- Dependency closure analysis
- Semantic reranking capabilities
- Degrade-first architecture with fallback search
- Security features including sensitive token masking
- Daemon mode for persistent background operation
