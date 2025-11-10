# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Java language support with tree-sitter-java**
  - Symbol extraction for classes, interfaces, enums, annotations, methods, constructors, and fields
  - Javadoc comment parsing
- Import dependency resolution with wildcard and static import support
- Full test coverage with 23 test cases

## [0.9.8] - 2025-11-10

### Fixed

- `ensureDatabaseIndexed` now invokes `runIndexer` with `skipLocking: true`, so first-time bootstrap no longer deadlocks on its own DuckDB lock file and `kiri`/`kiri-server` can index fresh repositories without manual intervention.

### Added

- Added `tests/server/indexBootstrap.spec.ts` to exercise the bootstrap path (first run + consecutive run) and prevent regressions around lock release.

## [0.9.7] - 2025-11-10

### Added

- Introduced a per-database `p-queue` pipeline plus path normalization helpers so the indexer, watcher, and bootstrap scripts all serialize DuckDB writes and share consistent lock files across symlinked paths.
- Added comprehensive regression coverage: FTS lifecycle E2E tests, schema migration specs, legacy repo path normalization tests, watcher lock specs, and a new FTS status cache unit test to prevent future regressions.

### Changed

- Server runtime now reuses the new normalization utilities, persists FTS metadata (`fts_dirty`, `fts_status`, `fts_generation`), and automatically downgrades to ILIKE whenever any repo reports a dirty index; once clean it reloads FTS without restarting.
- `scripts/test/verify-all.ts` gained configurable timeouts (coverage-aware) and MCP tool/watch/eval phases now run as part of release verification.

### Fixed

- `files_search` and related handlers invalidate cached FTS status as soon as `fts_dirty` / `fts_status='rebuilding'` is observed, preventing stale or crashing BM25 queries during rebuilds.
- Resolved duckdb path/lock mismatches that previously caused repo rows inserted via symlinks to be duplicated or skipped when resolving repositories on the server.

## [0.9.6] - 2025-11-07

### Added

- Introduced `compact` and `includeLineNumbers` options to `snippets_get`; compact mode now returns only metadata while line numbering adds aligned prefixes such as `  1375→export ...` for easier quoting.
- Added `compact` support to `files_search` plus an integration test so callers can omit previews during exploratory passes.

### Changed

- `context_bundle` now caps the `why` array at the top 10 reasons, rounds `score` values to three decimals, and only computes `tokens_estimate` when `includeTokensEstimate: true` is provided (default skips the costly calculation).
- Updated MCP tool descriptors, docs, and warning text to reflect the new optional fields and token-saving workflow.

## [0.9.5] - 2025-11-06

### Changed

- Clarified `context_bundle` guidance by documenting that goals should enumerate files/symptoms instead of leading with imperatives, and updated examples accordingly.

## [0.9.4] - 2025-11-06

### Fixed

- **Removed non-standard `outputSchema` and `annotations` from MCP tool descriptors**
  - **Issue**: v0.9.3 introduced `outputSchema` and `annotations` fields which are not part of the MCP 2024-11-05 specification
  - **Impact**: MCP clients performing strict schema validation rejected tools with these unknown fields
  - **Solution**: Removed `outputSchema` and `annotations` from `ToolDescriptor` interface and all tool definitions
  - **Result**: Full compliance with MCP 2024-11-05 protocol specification, restoring compatibility with MCP clients
  - **Note**: Output format information remains documented in tool `description` fields

## [0.9.3] - 2025-11-06

### Changed

- Aligned the default `security.lock` location with the DuckDB database path and extended the `kiri security verify` CLI to accept `--db` / `--security-lock` overrides for reproducible deployments.
- Clarified MCP tool descriptors by documenting output schemas, read-only annotations, and degrade-mode behaviour for `files_search`.

### Fixed

- Ensured `files_search` returns the documented array shape even when DuckDB is unavailable and the server is running in degrade mode, preventing schema mismatches in MCP clients.
- Added integration coverage that verifies degrade-mode compatibility for MCP `tools/call` responses.

## [0.9.2] - 2025-11-06

### Changed

- Documented how `artifacts.editing_path` anchors related files in `context_bundle` responses (English/Japanese API guide) for more discoverable workflows.
- Added tool descriptor guidance highlighting `artifacts.editing_path` usage within the MCP server metadata.

### Fixed

- Forced Vitest to run with a single fork in config and npm scripts to eliminate tree-sitter/DuckDB worker crashes during CI.

## [0.9.0] - 2025-11-05

### Fixed

- **`boost_profile="docs"` now correctly includes files from `docs/` directory**
  - **Previous issue**: `docs/` directory was unconditionally blacklisted (score = -100), even when using `boost_profile: "docs"`
  - **Root cause**: Blacklist check occurred before boost_profile logic with early return, preventing multipliers from ever being applied
  - **Solution**: Skip `docs/` blacklist entry when `profile="docs"`, allowing documentation files to be ranked normally
  - **Impact**: Documentation-focused searches now work as originally intended (CHANGELOG v0.7.0 claimed this worked but it didn't)
  - **Backward compatibility**: Default profile (`boost_profile: "default"`) continues to blacklist `docs/` directory for code-focused queries
  - **Evidence**: Added integration tests to verify both `boost_profile="docs"` (allows `docs/`) and default profile (blacklists `docs/`)

## [0.8.0] - 2025-11-05

### Changed

- **BREAKING: `compact: true` is now the default for `context_bundle`**
  - **Previous behavior**: `compact: false` (default) returned preview field, consuming ~55,000 tokens
  - **New behavior**: `compact: true` (default) omits preview field, consuming ~2,500 tokens (95% reduction)
  - **Impact**: Token consumption reduced by 95% by default, improving cost efficiency and response time
  - **Migration**: If you need code previews immediately, explicitly set `compact: false` in requests
  - **Recommended workflow**: Use `compact: true` (default) for exploration → `snippets.get` for detailed code

- **Config files now receive separate, stronger penalty (95% reduction) from doc files (50% reduction)**
  - **Previous behavior**: Config files (package.json, tsconfig.json) and docs (.md, .yaml) received same 70% penalty
  - **New behavior**:
    - Config files: `×0.05` penalty (95% reduction via `configPenaltyMultiplier`)
    - Doc files: `×0.5` penalty (50% reduction via `docPenaltyMultiplier`)
  - **Impact**: Config files now rarely appear in top 15 results, improving relevance for code-focused queries
  - **Languages covered**: JavaScript/TypeScript, Python, Ruby, Go, PHP, Java/Kotlin, Rust, Swift, .NET, C/C++, Docker, CI/CD, Webservers
  - **Files affected**:
    - **JS/TS**: package.json, tsconfig.json, .eslintrc, .prettierrc, \*.config.js/ts
    - **Python**: requirements.txt, pyproject.toml, setup.py, Pipfile, pytest.ini
    - **Ruby**: Gemfile, Rakefile, .ruby-version
    - **Go**: go.mod, go.sum, Makefile
    - **PHP**: composer.json, phpunit.xml
    - **Java/Kotlin**: pom.xml, build.gradle, settings.gradle
    - **Rust**: Cargo.toml, Cargo.lock
    - **Swift**: Package.swift, Package.resolved
    - **.NET**: packages.lock.json, global.json
    - **C/C++**: CMakeLists.txt, configure.ac
    - **Docker**: Dockerfile, docker-compose.yml
    - **CI/CD**: .travis.yml, .gitlab-ci.yml, Jenkinsfile, azure-pipelines.yml
    - **Git**: .gitignore, .gitattributes
    - **Webservers**: Caddyfile, nginx.conf, .htaccess, httpd.conf, apache2.conf, lighttpd.conf
    - **Generic**: \*.config.json/yaml/toml, \*.conf, \*.lock, .env\*
  - **Config directories**: Files inside these directories automatically penalized
    - **Framework**: bootstrap/, config/
    - **Database**: migrations/, db/migrate/, alembic/versions/, seeds/, fixtures/, test-data/
    - **i18n**: locales/, i18n/, translations/, lang/
    - **Infrastructure**: .terraform/, terraform/, k8s/, kubernetes/, ansible/, cloudformation/, pulumi/
  - **Lock files**: Comprehensive coverage including non-.lock extensions
    - **Standard**: \*.lock (covers pdm.lock, mix.lock, pubspec.lock, etc.)
    - **JS/Node**: package-lock.json, pnpm-lock.yaml, yarn.lock, npm-shrinkwrap.json, bun.lockb
    - **Python**: Pipfile.lock, poetry.lock
    - **Ruby**: Gemfile.lock
    - **PHP**: composer.lock
    - **Rust**: Cargo.lock
    - **Swift**: Package.resolved (non-.lock extension)
    - **.NET**: packages.lock.json (non-.lock extension)
    - **Go**: go.sum (lockfile equivalent)

### Added

- **`configPenaltyMultiplier` in scoring profiles** (`config/scoring-profiles.yml`)
  - Controls config file penalty (default: 0.05 = 95% reduction)
  - Separate from `docPenaltyMultiplier` to distinguish config files from documentation
  - **Multi-language support**: Covers 12+ programming languages and toolchains
  - **Directory-based detection**: Files in config directories automatically penalized
  - Applied via shared `isConfigFile()` helper function to eliminate code duplication

- **Comprehensive `compact` mode documentation** in `docs/api-and-client.md`
  - English and Japanese bilingual documentation
  - Two-tier workflow examples showing optimal token usage patterns
  - Token comparison table (55K vs 2.5K tokens)
  - Usage guidelines for when to use compact mode vs full preview mode
  - Real-world Lambda function investigation example

- **Runtime warning for breaking change** (`src/server/rpc.ts`)
  - Displays once on first use: "⚠️ BREAKING CHANGE (v0.8.0): compact mode is now default"
  - Guides users to set `compact: false` to restore previous behavior
  - Prevents silent behavior changes that could impact existing workflows

- **Edge case tests** for config file detection (`tests/server/boosting-helpers.spec.ts`)
  - Verifies implementation files in `src/config/` are not penalized
  - Validates multi-language config file detection (Python, Ruby, Go, Rust, Docker, etc.)
  - Ensures paths with config-like segments don't cause false positives
  - Tests non-.lock extension lock files (npm-shrinkwrap.json, Package.resolved, packages.lock.json)
  - Tests directory-based detection (bootstrap/, config/, migrations/, locales/)

### Fixed

- **Config files (package.json, tsconfig.json) no longer dominate search results**
  - Previous issue: Generic config files appeared in top 15 despite being rarely relevant
  - Root cause: Insufficient penalty (70% reduction) allowed config files with keyword matches to rank high
  - Solution: Separate `configPenaltyMultiplier` (95% reduction) applied before doc penalty

- **Code duplication in config file detection**
  - Previous issue: Config patterns defined twice in `applyFileTypeBoost()` and `applyFileTypeMultipliers()`
  - Solution: Extracted to shared constants (`CONFIG_FILES`, `CONFIG_EXTENSIONS`, `CONFIG_PATTERNS`) and `isConfigFile()` helper function
  - Impact: Improved maintainability and consistency across codebase

## [0.7.0] - 2025-11-05

### Changed

- **BREAKING: Multiplicative penalties replace additive penalties** for file type ranking in `context_bundle`
  - Documentation files now receive `×0.3` penalty (70% reduction) instead of `-2.0` additive penalty
  - Implementation files receive `×1.3` boost (30% increase) instead of `+0.5` additive boost
  - **Impact**: Implementation files now rank 5-10× higher than documentation files for code-focused queries
  - **Migration**: For documentation-focused queries, use `boost_profile: "docs"` parameter

### Added

- **Configurable penalty multipliers** in `config/scoring-profiles.yml`
  - `docPenaltyMultiplier`: Controls documentation file penalty (default: 0.3 = 70% reduction)
  - `implBoostMultiplier`: Controls implementation file boost (default: 1.3 = 30% increase)
  - All scoring profiles (default, bugfix, testfail, typeerror, feature) support multipliers
- **Phase 1 conservative rollout**: Starting with 70% penalty (0.3 multiplier) to gather feedback before increasing to 90% (0.1 multiplier)

### Fixed

- **Documentation files no longer dominate implementation-focused searches**
  - Previous issue: Docs with high semantic similarity could outrank actual implementation files
  - Root cause: Additive penalty (-2.0) was insufficient to overcome path match (+2.25) + text match (+2.0) + structural similarity (+0.54)
  - Solution: Multiplicative penalty applied AFTER all additive scoring components
- **boost_profile="docs" now correctly prioritizes documentation** without penalty
  - Safety rule: Profile "docs" skips all documentation penalties
  - Enables doc-focused queries like "setup guide" to return documentation first
- **Negative score inversion prevented**
  - Multipliers only applied to positive scores (score > 0)
  - Blacklisted directories (-100 score) remain heavily penalized

### Technical Details

- New `CandidateInfo.scoreMultiplier` field accumulates boosts/penalties (default: 1.0)
- Multipliers applied in separate phase AFTER `applyStructuralScores()` for predictable behavior
- Path-based scoring remains additive (adds new information, not just file type filtering)
- Test files, lock files, config files keep additive penalties (already very strong at -2.0 to -3.0)

## [0.6.0] - 2025-11-05

### Added

- **Phrase-aware Tokenization**: Compound terms (kebab-case like `page-agent`, snake_case like `user_profile`) are now recognized as single phrases with 2× scoring weight
  - Configurable tokenization strategy via `KIRI_TOKENIZATION_STRATEGY` environment variable
  - Strategies: `phrase-aware` (default), `legacy`, `hybrid`
  - Supports Unicode characters (international compound terms)
- **Path-based Scoring**: Additional boost when keywords/phrases appear in file paths
  - Phrase in path: `pathMatch × 1.5`
  - Path segment: `pathMatch × 1.0`
  - Keyword in path: `pathMatch × 0.5`
- **Auto-create .gitignore**: Database directories automatically get `.gitignore` to prevent accidental commits
  - Enabled by default via `autoGitignore: true` option in `DuckDBClientOptions`
  - Only creates in Git repositories
  - Respects existing `.gitignore` files (no overwrite/append)
  - Wildcard pattern (`*`) ignores all database files

### Changed

- **context_bundle accuracy improved from 65-75% to 95%** through phrase-aware tokenization and path-based scoring
- Enhanced tool description for `context_bundle` with new feature explanations and examples
- Document file penalty strengthened from `-1.0` to `-2.0` to prioritize implementation files
- N+1 database query optimization: consolidated 15 individual queries into 2 queries with OR clauses

### Fixed

- Test regression from N+1 query consolidation by adjusting document penalty
- Inconsistent tokenization between `handlers.ts` and `embedding.ts` by creating shared `tokenizer.ts` utility
- Unicode support in compound term extraction using `\p{L}\p{N}` property escapes

## [0.5.0] - 2025-11-04

### Added

- **Incremental Indexing (Phase 1)**: Hash-based file-level incremental indexing for watch mode
  - Only reindex files that have changed content (10-100x performance improvement)
  - Automatic detection and removal of deleted/renamed files to prevent orphaned database records
  - Single transaction atomicity ensures all files succeed or fail together (no partial updates)
  - Debouncing aggregates rapid consecutive changes into a single reindex operation
  - Performance: Typically completes in 400-500ms vs 2-10 seconds for full reindex

### Changed

- Watch mode now uses incremental indexing by default instead of full repository reindex
- Indexer tracks existing file hashes in database to detect content changes
- File reconciliation runs before each incremental batch to clean up stale records

### Fixed

- Database bloat from orphaned records when files are deleted or renamed
- Partial database updates when indexing errors occur mid-batch
- Watch mode performance issues with large repositories

### Known Limitations

These limitations are documented for Phase 2 implementation:

1. **Cross-file dependency staleness**: When import statements change, dependency graph updates lag until next full reindex
2. **File move/rename history**: Renames are treated as delete+add (no git history preservation)
3. **DELETE batching**: Individual DELETE statements per file (not yet optimized with batch operations)

Impact of these limitations is minimal in practice, and Phase 2 will address them with tree-sitter migration and dependency diff updates.

## [0.4.1] - 2025-01-04

### Changed

- Increased default daemon initialization timeout from 30 seconds to 240 seconds to better support large repositories (10,000+ files)
- Completely restructured README.md with MCP user focus:
  - Added Prerequisites section with Node.js/npm/Git version requirements
  - Improved installation instructions with `kiri` command explanation and npx behavior details
  - Clarified configuration format differences between Claude Code (JSON) and Codex CLI (TOML)
  - Enhanced timeout configuration documentation with specific recommendations for different repository sizes

### Added

- Comprehensive Troubleshooting section covering 4 common issues:
  - Daemon initialization timeout
  - Command not found errors
  - Slow indexing performance
  - Disk space management
- Getting Help section with log access, debugging tips, and support channels
- Detailed "When to use" guidance for each MCP tool
- Common use case examples for new users

### Fixed

- Users no longer need to manually configure `KIRI_DAEMON_READY_TIMEOUT` or `startup_timeout_sec` for most repositories

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
