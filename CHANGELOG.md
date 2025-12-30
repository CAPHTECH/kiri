# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.25.6] - 2025-12-30

### Fixed

- **Daemon startup deadlock caused by duplicate locking** (Issue from v0.25.5): Fix proxy-side startup lock acquisition that prevented daemon from starting
  - Problem: Proxy and daemon both tried to acquire the same startup lock, causing daemon to exit with "Another daemon is starting up"
  - Solution: Remove startup lock logic from proxy side; daemon-only lock management ensures single daemon invariant while allowing proper startup

## [0.25.5] - 2025-12-30

### Fixed

- **Daemon多重起動のレースコンディション防止** (PR #184): 複数MCPクライアントが同時にdaemonを起動しようとした際の競合を防止
  - スタートアップロックによる排他制御を追加
  - isProcessRunning: EPERM エラーを「プロセス存在」として正しく扱う
  - ディレクトリ作成順序修正でENOENTエラーを防止
  - logFileハンドルリーク修正
  - ポーリングロジックを共通化

## [0.25.4] - 2025-12-30

### Fixed

- **snippets_get content size handling**: Properly truncate snippet ranges according to `max_answer_chars` parameter
  - Align line range boundaries with content truncation
  - Cap output size before returning to client

## [0.25.3] - 2025-12-29

### Changed

- **Query language guidance in MCP tool descriptions** (PR #182): Clarified query language usage in `context_bundle` / `files_search` descriptions
  - Use repository's programming language for code searches
  - Use English or project language for documentation searches

## [0.25.2] - 2025-12-27

### Fixed

- **IO破損検知の自動リカバリ** (PR #181): DeserializeDeletes などのIO破損兆候を破損判定に含め、起動時の自動フル再インデックスを確実化

## [0.25.1] - 2025-12-25

### Fixed

- **Daemon idle shutdown behavior** (PR #180): avoid immediate shutdown when no clients are connected; keep daemon alive in watch mode
  - idle timeout now schedules a delayed shutdown instead of exiting immediately

### Tests

- **FTS watcher reindex stability** (PR #180): wait for blob visibility to reduce flakiness

## [0.25.0] - 2025-12-25

### Added

- **クライアント未接続時のdaemon自動停止** (PR #178): 全クライアント切断後にdaemonが自動停止
  - アイドルタイムアウト機能と連携し、リソース効率を改善

### Fixed

- **context_bundleファイルキャッシュ制限** (PR #179): メモリ使用量（RSS）の肥大化を防止
  - LRUキャッシュによる上限管理を導入
- **Dart stdinエラーガード** (PR #172): Dart解析時のstdinエラーを適切にハンドリング

## [0.24.4] - 2025-12-25

### Added

- **DB不整合の自動復旧** (PR #171): 起動時にDuckDBの破損/互換性エラーを検知したらバックアップ後にフル再インデックス
  - `KIRI_AUTO_REINDEX_ON_CORRUPTION` で自動復旧の有効/無効を切り替え可能（デフォルト有効）

### Fixed

- **バックアップ失敗時の安全性** (PR #171): 自動復旧のバックアップが完了しない場合はDB削除をスキップ

## [0.24.3] - 2025-12-23

### Fixed

- **tools/listレスポンスサイズを縮小** (PR #170): Claude Code互換性を改善
  - TOOL_DESCRIPTORSの説明を簡潔化（17KB → 4KB、75%削減）
  - `outputSchema`をtools/listレスポンスから除外（Claude CodeのMCPクライアントが8KB以上のJSONでパースエラー）
  - 必要なパラメータ（`artifacts`, `metadata_filters`等）は維持し、各ツールに使用例を追加

## [0.24.2] - 2025-12-23

### Fixed

- **ゾンビdaemon自動検出・クリーンアップ** (Issue #168, PR #169): プロセス生存 + ソケット消失状態のゾンビdaemonを検出しDuckDBロック競合時に自動クリーンアップ
  - `extractPidFromLockError()`: DuckDBエラーメッセージからPID抽出
  - `detectAndCleanupZombie()`: ゾンビ検出・SIGTERM→SIGKILL停止
  - カスタムソケットパス使用時のdaemon誤kill防止（ソケットファイル存在確認）
  - `ZombieMetrics` によるメトリクス追跡

## [0.24.1] - 2025-12-23

### Fixed

- **DaemonLifecycle stale lock検出機能** (PR #168): デーモン異常終了時の古いロックファイルを自動検出・クリーンアップ
  - `isProcessRunning()` ヘルパー関数を追加
  - `acquireStartupLock()` にstale lock検出を実装（TOCTOU対策付き）

## [0.24.0] - 2025-12-19

### Added

- **MCP接続の自動再接続機能** (Issue #156, PR #167): デーモン再起動時に自動再接続
  - `ConnectionManager`: ソケット接続の確立・維持・再接続を管理
  - `RequestQueue`: 再接続中のリクエストをバッファリングし、再接続後に自動再送信
  - 指数バックオフ付きリトライ戦略（初期500ms、最大30秒、ジッター100ms）
  - `createReconnectingBridge()`: 自動再接続対応のブリッジ関数を提供

## [0.23.0] - 2025-12-18

### Added

- **`--full` option for kiri command** (Issue #161, PR #166): Run full reindex directly from kiri CLI
  - Stops existing daemon if running
  - Runs full reindex in child process (ensures DuckDB lock is released)
  - Restarts daemon after indexing completes
  - Supports custom `--socket-path` for daemon detection

### Changed

- `isDaemonRunning()` now accepts optional `customSocketPath` parameter

## [0.22.4] - 2025-12-17

### Fixed

- **EMFILE error on large repositories** (PR #165): Replaced chokidar with @parcel/watcher for file watching
  - Uses OS-native APIs (FSEvents on macOS, inotify on Linux) instead of per-file watchers
  - Resolves "too many open files" error when watch mode is enabled on repos with 3000+ files
  - Added graceful degradation: daemon continues running even if watch mode fails to start

## [0.22.3] - 2025-12-17

### Fixed

- **Denylist filter using node-ignore library** (Issue #154): Replaced custom regex with battle-tested `ignore` library for proper gitignore compliance
  - Uses `ignore` (node-ignore) library version 7.0.5 for gitignore spec 2.22.1 compliance
  - Fixed pattern priority: denylist.yml patterns now correctly override .gitignore (applied last, "last match wins")
  - Added security validation: negation patterns (`!pattern`) are now forbidden in denylist.yml
  - Improved test coverage for edge cases (?, \*\*, nested directories)

## [0.22.2] - 2025-12-17

### Fixed

- **files_search path_prefix filter** (Issue #162): Fixed path_prefix parameter not filtering results correctly
  - Added normalization for leading slashes (`/src/` → `src/`)
  - Added normalization for backslashes (`src\server\` → `src/server/`)
  - Added normalization for dot-slash prefix (`./src/` → `src/`)
  - Uses shared `normalizePathPrefix` function for consistency with `context_bundle`

## [0.22.1] - 2025-12-16

### Fixed

- **FTS index WAL visibility** (Issue #158): Fixed incremental indexing not including new blobs in FTS search results
  - Added defensive CHECKPOINT before FTS index rebuild to flush WAL data
  - Ensures `match_bm25` can find newly added/modified content after incremental reindex

## [0.22.0] - 2025-12-16

### Changed

- **BREAKING: `files_search` response format** - Changed response from array to object format
  - Old: `[{path, matchLine, ...}, ...]`
  - New: `{results: [{path, matchLine, ...}, ...]}`
  - Reason: Claude Code MCP client requires `outputSchema.type` to be `"object"` (not `"array"`)
  - If you directly consume `files_search` results, update your code to access `.results`

### Fixed

- **MCP tool registration with Claude Code** - Fixed issue where Claude Code failed to register KIRI tools due to `files_search` outputSchema having `type: "array"` at top level

## [0.21.2] - 2025-12-16

### Fixed

- **Denylist filter gitignore compliance** (Issue #154): Fixed subdirectory `node_modules/` not being excluded
  - Patterns without slashes now match at any depth per gitignore spec
  - Fixed `?` wildcard to not match slashes (gitignore compliance)
  - Added validation for empty or overly broad patterns (`**`, `**/`, `/`)
- **graph_metrics retry logic**: Added retry logic to INSERT/UPDATE statements to resolve DuckDB lock conflicts during tests

Note: v0.21.1 was unpublished from npm. This release contains the same fixes.

## [0.21.1] - 2025-12-16 (unpublished)

### Fixed

- **Denylist filter gitignore compliance** (Issue #154): Fixed subdirectory `node_modules/` not being excluded
  - Patterns without slashes now match at any depth per gitignore spec
  - Fixed `?` wildcard to not match slashes (gitignore compliance)
  - Added validation for empty or overly broad patterns (`**`, `**/`, `/`)
- **graph_metrics retry logic**: Added retry logic to INSERT/UPDATE statements to resolve DuckDB lock conflicts during tests

## [0.21.0] - 2025-12-16

### Added

- **Daemon Watch Mode**: Added `--watch` flag for file monitoring and auto re-indexing (Issue #151)
  - Detects file changes and automatically triggers incremental indexing
  - Debounce mechanism handles rapid consecutive changes
  - Automatic fallback to polling mode on OS resource limits
  - Ignores DB files and temporary files to prevent infinite loops

### Fixed

- **Denylist optional config**: Daemon watch mode now works in repositories without `config/denylist.yml` (Issue #153)
  - Returns empty patterns when file is missing, allowing `.gitignore`-only filtering
  - Throws error when file exists but contains invalid content (detects configuration mistakes)

## [0.20.2] - 2025-12-12

### Fixed

- **Build artifact fix**: Rebuilt dist/ with English MCP Prompts (v0.20.1 was published with stale Japanese text)

## [0.20.1] - 2025-12-12

### Fixed

- **MCP Prompts translation**: Translated MCP Prompts text from Japanese to English

## [0.20.0] - 2025-12-12

### Added

- **MCP Prompts/Resources対応** (Issue #145)
  - MCP仕様のPrompts機能に対応（`kiri-overview`プロンプト）
  - MCP仕様のResources機能に対応
  - `AGENTS.md`をResourcesとして公開

### Changed

- **リファクタリング**: `fileExists`関数を共通化、YAML型ガードを追加

## [0.19.0] - 2025-12-11

### Added

- **MCP Structured Output対応**: MCP仕様（2025-06-18）の`outputSchema`フィールドに対応 (Issue #144)
  - 全6つのMCPツール（context_bundle, files_search, snippets_get, deps_closure, semantic_rerank）にJSON Schema出力スキーマを追加
  - LLMが型安全に結果をパースできるように

## [0.18.2] - 2025-12-06

### Fixed

- **Defensive JSON sanitization**: Added surrogate sanitization to `JSON.stringify` output in `persistDocumentMetadata` (Issue #141)
  - Complements v0.18.1 fix for more robust error prevention

## [0.18.1] - 2025-12-06

### Fixed

- **Unicodeサロゲートペア修正**: 不正なUnicodeサロゲートペアを含むファイルのインデックスが失敗する問題を修正 (Issue #141)
  - サロゲート処理の改善とテスト強化

### Added

- **DCCA分析と意味グラフ**: KIRIプロジェクトのDCCA（Dual-Channel Context Analysis）分析と意味グラフを追加
- **READMEにMRR 1.0の実績を追加**

### Changed

- **ドキュメント再編成**: DCCAドキュメントを`docs/dcca/`へ再編成
- **作業記録整理**: 作業記録ドキュメントを整理
- **README構成のリファクタリング**: 詳細ドキュメントを分離

## [0.18.0] - 2025-12-01

### Added

- **Rust code intelligence**: tree-sitter-rust based analyzer extracts symbols/snippets (struct/enum/trait/impl/fn/mod/const/static/type/macro) and resolves imports, module files, and extern crates for dependency graph integration
- **shirushi document ID management**: Introduced document ID uniqueness validation and management via shirushi linting

### Changed

- **Clean Architecture refactoring**: Reorganized language analyzers using Clean Architecture for improved extensibility and maintainability

### Fixed

- **Rust imports resolution**: Fixed resolution of Rust imports ending with items (`use foo::bar::item`)
- **TypeScript build error**: Fixed TypeScript build errors and improved test coverage
- **Build cleanup**: Clean dist directory before build to prevent stale files from persisting

## [0.17.0] - 2025-11-29

### Added

- **`code` boost_profile for implementation-focused search**: New boost profile that strongly deprioritizes documentation and config files (95% penalty) to focus search results on actual implementation code
  - Use `boost_profile: "code"` when you want to find implementation files only
  - Complements existing profiles: `default`, `docs`, `balanced`, `none`

### Fixed

- **Graph metrics retry logic**: Added retry logic for transient DuckDB errors during graph metrics computation
  - Prevents sporadic failures during indexing on systems with high I/O load
  - Automatically retries failed operations with exponential backoff

## [0.16.1] - 2025-11-28

### Fixed

- **Graceful degradation for graph layer tables**: Fixed server crash when `graph_metrics` and `cochange` tables are missing
  - Added `hasGraphMetrics` and `hasCochange` flags to `TableAvailability`
  - Table existence check at startup with warning logs when tables are missing
  - Scoring functions now skip gracefully when tables are unavailable

## [0.16.0] - 2025-11-28

### Changed

- **DuckDB client migration**: Migrated from deprecated `duckdb` package to `@duckdb/node-api`
  - Resolves native binding installation issues when using npx
  - Uses pre-built platform-specific binaries (no build required at install time)
  - Maintains full API compatibility with existing codebase
  - Improved type safety with explicit `DuckDBParams` type
  - Added ROLLBACK failure logging for debugging support

## [0.15.0] - 2025-11-28

### Added

- **`snippets_get` view parameter** (#117, #118): New `view` parameter for explicit retrieval strategy control
  - `auto`: Maintain current behavior (symbol boundaries if available, else line range)
  - `symbol`: Force symbol boundary-based snippets
  - `lines`: Line range-based snippets (ignore symbol boundaries)
  - `full`: Return entire file (500 line safety limit, truncated flag added)

- **VSS infrastructure and co-change scoring** (#82, #124):
  - Dependency graph with PageRank-like importance scoring
  - Co-change relationship extraction from git commit history
  - Graph layer scoring integration into search pipeline
  - Incremental update support for watch mode
  - Alloy and TLA+ formal specs for graph layer
  - Cochange scoring enabled by default (--no-cochange opt-out)

- **Stop words configurability and IDF-based keyword weighting** (#48):
  - StopWordsService with multi-language support (en/ja)
  - External config via config/stop-words.yml
  - NFKC normalization and katakana→hiragana conversion
  - DuckDbIdfProvider with BM25-style IDF calculation
  - Lazy computation with LRU cache (max 10K entries)

- **All tools inputSchema validation test** (#127): Comprehensive schema validation for all MCP tools

### Changed

- **Documentation**: Added metadata tables documentation and migration guide (#87)
- **Documentation**: Added pce-memory usage guide to AGENTS.md and CLAUDE.md

### Fixed

- **Evaluation**: Added metadata:hint tag to Metadata Pass judgment (#121)
- **Evaluation**: Corrected assay-kit expected paths for monorepo structure
- **Co-change**: Prevent confidence reset when no new commits processed

## [0.14.0] - 2025-11-25

### Changed

- **AdaptiveK enabled by default**: `context_bundle` now uses adaptive K sizing automatically without requiring explicit configuration
  - Previously required opt-in, now provides intelligent result sizing out of the box
  - Configurable limits remain available for fine-tuning

### Added

- **Category aliases for AdaptiveK**: Added convenience aliases for common query categories
  - Simplifies query categorization with human-readable aliases
  - Integrated with golden set evaluation system

### Fixed

- **Lint and type errors**: Resolved import ordering and type compatibility issues in adaptive-k module
- **WarningManager test**: Fixed test compatibility with adaptive-k changes
- **Port retry on benchmark**: Evaluation scripts now retry on `EADDRINUSE` errors

## [0.13.0] - 2025-11-24

### Added

- **AdaptiveK dynamic cluster sizing**: `context_bundle` now automatically adjusts result set size based on query characteristics
  - Automatic category detection for query types
  - P@10 improved by 31% through intelligent clustering
  - Configurable limits with hardened safety bounds
- **Domain Terms Dictionary support**: Enable domain-specific term expansion via `KIRI_ENABLE_DOMAIN_TERMS=1` environment variable
  - YAML-based domain term configuration (`config/domain-terms.yml`)
  - Automatic alias expansion for technical terminology
  - Validation and strict schema checking
- **`path_prefix` filter for `context_bundle`**: Filter results by directory path prefix
  - Normalized path handling for consistent behavior
  - Pushed filter into SQL queries for performance
- **Evaluation improvements**:
  - `--inspect-query` option for `run-golden.ts` to debug specific queries
  - Improved assay-dataset-loader query P@10 from 0.10 to 0.30

### Fixed

- **TypeScript build errors**: Fixed `Set<string>` to `string[]` conversion in domain-terms.ts
- **EmptyDict type assertion**: Fixed type compatibility for disabled domain terms dictionary
- **Adaptive K limit hardening**: Strengthened bounds checking and masked ping paths
- **files_search schema**: Removed non-standard `anyOf` from JSON schema
- **path_prefix filter**: Fixed import path for validation and pushed filter into queries

### Changed

- **Boost profiles**: Enhanced configuration capabilities and settings
- **Documentation**: Updated docs and moved PathPenalty formal specs to `docs/formal/`
- **Toolchain**: Aligned mise toolchain with Node 20 LTS
- **Dependencies**: Updated dependencies and tool configurations

## [0.12.0] - 2025-11-21

### Added

- **ContextBundleParams.requestId**: Optional request ID for tracing/debugging support

### Fixed

- **TypeScript type errors**: Fixed `exactOptionalPropertyTypes` compatibility by omitting `pathFallbackReason` in CandidateInfo initialization
- **Search precision**: Trim only fallback-only candidates to improve search accuracy
- **Tokenizer expansion**: Added camelCase/snake_case variant support

### Changed

- **Path penalties configuration**: Support merging path penalties from config files
- **Documentation**: Added path penalties user and developer guides (EN/JA)

## [0.11.0] - 2025-11-20

### ⚠️ BREAKING CHANGES

**Scoring system migrated from absolute penalties to multiplicative penalties**

This is a fundamental change to how file penalties are calculated and applied:

- Replaces absolute penalties (`-100`) with multiplicative penalties (e.g., `×0.01` for 99% reduction)
- Makes all penalties composable and predictable when combined with boost profiles
- Introduces score threshold filter (`SCORE_FILTER_THRESHOLD`) to remove extremely low-scored files

**Migration Guide:**

For users with custom scoring profiles, add these fields to `scoring-profiles.yml`:

```yaml
your-profile:
  blacklistPenaltyMultiplier: 0.01 # 99% reduction for blacklisted directories
  testPenaltyMultiplier: 0.02 # 98% reduction for test files
  lockPenaltyMultiplier: 0.01 # 99% reduction for lock files
```

**New Environment Variable:**

- `KIRI_SCORE_THRESHOLD` (default: `0.05`): Minimum score threshold for including files in results

### Added

- **Document Metadata自動マイグレーション**: 既存のデータベースに`document_metadata`テーブルを自動的に作成・適用
- **Multiplicative penalty system**: New `ScoringWeights` fields for configurable file penalties
- **Hint expansion system**: Re-architected `context_bundle` artifact hints with phase-based processing
  - `hint_expansion` and `hint_dictionary` tables for hint tracking
  - Dictionary-based hint promotion with `dictionary:hint:*` tags
  - Diagnostic tools: `dump-hints.ts`, `build-hint-dictionary.ts`, `cleanup-hints.ts`
- **Evaluation improvements**:
  - R@5 metrics in `scripts/eval/run-golden.ts`
  - `--min-r5` and `--max-startup-ms` options
  - Markdown output with startup time and R@5 tracking
- **Configuration**: `KIRI_SERVER_COMMAND` environment variable for MCP server binary switching
- **Low-value file penalties**: Restored penalties for syntax grammars, performance dumps, legal files, migrations
- **マイグレーション検証ツール**: `scripts/check-migration.ts` for database migration status checking
- **Test coverage**: Comprehensive migration detection tests (PR #102)

### Fixed

- **Config file noise reduction**: Enhanced `configPenaltyMultiplier` from 0.05 to 0.01 (99% reduction)
  - Added `eslint.config.js`, `.tmLanguage.json`, `.nls.json`, `/cli/` to config patterns
  - Token Savings improved from 93.8% to 95.0% (+1.2%)
- **Server stability**:
  - Eliminate race condition from global mutable state
  - Prevent SQL injection in metadata filter alias parameter
  - Improve `checkTableAvailability` robustness
- **Database**: デーモン終了時のデータベース破損問題を解決
- **Error handling**: DuckDBクライアントのエラーハンドリングを改善
- **Lint**: デバッグスクリプトのlint問題を修正 (`scripts/debug/test-vscode-query.ts`)
- **Validation**: Require at least one expected item per query
- **Type safety**: Resolve TypeScript compilation errors and add backward compatibility
- **Security**: Enhance security and error handling for metadata ingestion
- **Performance**: Optimize file deletion and prevent blob table bloat
- **Data integrity**: Prevent data orphaning in repo deduplication

### Changed

- **Scoring model fundamentals**:
  - Absolute penalties (`-100`) → Multiplicative penalties (`×0.01` for blacklist, `×0.02` for tests)
  - Blacklisted directories use `blacklistPenaltyMultiplier` instead of hard-coded `-100`
  - Test files use `testPenaltyMultiplier` instead of hard-coded `×0.2`
  - All penalties are composable and work predictably with boost profiles
- **Profile behavior**: Eliminated special case for `boost_profile="docs"`, simplified to declarative model
- **Evaluation baseline** (2025-11-17): P@10 = 0.136, R@5 = 0.966, TFFU = 0ms, Token Savings = 94.7%
- **Golden set corrected**: Removed 5 non-existent paths (35 → 30), R@5 improved from 0.852 to 0.966 (+13.4%)
- **Formatting**: Added `tmp/` to `.prettierignore` for temporary files
- **Dependencies**: Updated assay-kit submodule to latest upstream

### Deprecated

_The following entries (v1.0.0, v0.10.1) were planned but not released. Their changes are consolidated into v0.11.0 above._

## ~~[1.0.0]~~ - Not Released

### ⚠️ BREAKING CHANGES

**Scoring system migrated from absolute penalties to multiplicative penalties** ([#35](https://github.com/CAPHTECH/kiri/issues/35))

This is a fundamental change to how file penalties are calculated and applied. The new model:

- Replaces absolute penalties (`-100`) with multiplicative penalties (e.g., `×0.01` for 99% reduction)
- Makes all penalties composable and predictable when combined with boost profiles
- Introduces a score threshold filter (`SCORE_FILTER_THRESHOLD`) to remove extremely low-scored files

#### Migration Guide

**For users with custom scoring profiles:**

Add the following three new fields to your `scoring-profiles.yml`:

```yaml
your-profile:
  # ... existing fields ...
  blacklistPenaltyMultiplier: 0.01 # 99% reduction for blacklisted directories
  testPenaltyMultiplier: 0.02 # 98% reduction for test files
  lockPenaltyMultiplier: 0.01 # 99% reduction for lock files
```

If these fields are omitted, default values (shown above) will be automatically applied for backward compatibility.

**For programmatic users:**

The `ScoringWeights` interface now includes three additional required fields. However, the system provides default values if they are missing, so existing code will continue to work without modification.

#### New Environment Variable

- **`KIRI_SCORE_THRESHOLD`** (default: `0.05`): Controls the minimum score threshold for including files in results. Files with scores below this value (after all multiplicative penalties) are filtered out. Adjust this if you need to include more heavily penalized files.

#### Evaluation Results

Comparison between absolute penalty model (v0.10.0) and multiplicative penalty model (v1.0.0):

| Metric           | v0.10.0    | v1.0.0     | Change                  |
| ---------------- | ---------- | ---------- | ----------------------- |
| Success Rate     | 100% (5/5) | 100% (5/5) | ✅ Maintained           |
| Avg Latency      | 181ms      | 175ms      | ✅ **-3.3%** (improved) |
| Context Coverage | 85%        | 85%        | ✅ Maintained           |
| Path Overlap     | 72%        | 72%        | ✅ Maintained           |

**Result**: The new model maintains search quality while slightly improving performance.

### Added

- **Multiplicative penalty system** ([#35](https://github.com/CAPHTECH/kiri/issues/35))
  - New `ScoringWeights` fields: `blacklistPenaltyMultiplier`, `testPenaltyMultiplier`, `lockPenaltyMultiplier`
  - Score filtering threshold (`SCORE_FILTER_THRESHOLD`) to remove files with `score < 0.05`
  - Configurable via `KIRI_SCORE_THRESHOLD` environment variable
  - Backward compatible: default values provided for new fields
- **Low-value file penalties restored**
  - Syntax grammar files (`.tmlanguage`, `.plist`)
  - Performance data dumps (`.perf.data`)
  - Legal/inventory files (`ThirdPartyNotices`, `cgmanifest.json`)
  - Migration files (`migrate`, `migration` in path)
  - All penalized with `configPenaltyMultiplier` (95% reduction)

### Changed

- **Scoring model fundamentals**
  - Absolute penalties (`-100`) → Multiplicative penalties (`×0.01` for blacklist, `×0.02` for tests, `×0.01` for locks)
  - Blacklisted directories now use `blacklistPenaltyMultiplier` instead of hard-coded `-100`
  - Test files use `testPenaltyMultiplier` instead of hard-coded `×0.2`
  - All penalties are now composable and work predictably with boost profiles
- **Profile-specific behavior removed**
  - Eliminated special case for `boost_profile="docs"` in `applyAdditiveFilePenalties()`
  - Simplified control flow: penalties are always multiplicative, profile adjustments are declarative
  - `denylistOverrides` in `BoostProfileConfig` now handles profile-specific directory allowlists

## [0.10.1] - Unreleased

### Added

- Re-architected `context_bundle` のアーティファクトヒント処理をフェーズ化し、path/directory/dependency/substring それぞれに why タグを残すようにした。`KIRI_HINT_LOG=1` 時のみ `hint_expansion` に展開ログを保存し、`dictionary:hint:*` で辞書経由の昇格を可視化。
- `hint_expansion` と `hint_dictionary` テーブル、ならびに `scripts/diag/dump-hints.ts` / `scripts/diag/build-hint-dictionary.ts` / `scripts/diag/cleanup-hints.ts` を追加。辞書の再生成と TTL 削除がワンコマンドで行える。
- `scripts/eval/run-golden.ts` に R@5 集計、`--min-r5`/`--max-startup-ms` オプション、Markdown 出力への起動時間と R@5 の記録を追加。docs カテゴリだけを落とし穴なしでゲートできるようになった。
- `KIRI_SERVER_COMMAND` 環境変数で MCP サーバーバイナリを切り替え可能に（例: `npx -y kiri-mcp-server@0.10.0`）

### Fixed

- **Config file noise reduction**: `eslint.config.js`, `.tmLanguage.json`, `.nls.json`, `/cli/` を config patterns に追加し、`context_bundle` で `applyFileTypeMultipliers` を適用。`configPenaltyMultiplier` を 0.05 → 0.01 (99% 削減) に強化。Token Savings が 93.8% → 95.0% (+1.2%) に改善。

### Changed

- **New evaluation baseline established (2025-11-17)**: P@10 = 0.136, R@5 = 0.966, TFFU = 0ms, Token Savings = 94.7% (詳細: `var/eval/BASELINE.md`)
- **Golden set corrected**: 5 つの存在しないパスを削除 (expected paths: 35 → 30), R@5 が 0.852 → 0.966 (+13.4%) に改善

## [0.10.0] - 2025-11-13

### Added

- **"balanced" boost profile for equal weighting of docs and implementation**
  - New boost_profile option that applies 1.0x multiplier to both documentation and implementation files
  - Allows docs/ directory files (via blacklistExceptions)
  - Still penalizes config files (0.3x multiplier)
  - No path-specific multipliers (unlike "default" profile)
  - Works consistently across `files_search` and `context_bundle`
  - Addresses [#63](https://github.com/CAPHTECH/kiri/issues/63) - documentation discovery issues
- **Java language support with tree-sitter-java**
  - Symbol extraction for classes, interfaces, enums, annotations, methods, constructors, and fields
  - Javadoc comment parsing
- Import dependency resolution with wildcard and static import support
- Full test coverage with 23 test cases
- **Artifact hints for abstract query expansion ([#76](https://github.com/CAPHTECH/kiri/issues/76))**
  - `context_bundle` now accepts `artifacts.hints` (string arrays) so callers can pass function names or file paths as concrete breadcrumbs.
  - Hints are merged into keyword extraction, seeded as dependency candidates when path-like, and surface in `why` tags as `artifact:hint:*`.
  - Documented the new field (English/Japanese API guides) and published `datasets/kiri-ab.yaml` containing the two failing evaluation queries from the issue for future A/B runs.

### Changed

- **Refactored boost profile logic to use table-driven configuration**
  - Created centralized `src/server/boost-profiles.ts` module with `BoostProfileConfig` interface
  - Replaced scattered if-statements across 3 functions with configuration lookups
  - All boost profiles (default, docs, balanced, none) now use unified `BOOST_PROFILES` table
  - Improved maintainability: adding new profiles no longer requires modifying multiple functions
  - Added `isValidBoostProfile()` type guard for runtime validation
- Updated `boost_profile` parameter validation in RPC handlers to use centralized validation

### Deprecated

- **`config/scoring-profiles.yml` user configuration is now ignored**
  - The table-driven design uses fixed multipliers from `BOOST_PROFILES` constant
  - User-configured `docPenaltyMultiplier`, `configPenaltyMultiplier`, and `implBoostMultiplier` no longer have effect
  - This trade-off was made to improve maintainability and consistency across profiles
  - Future versions may re-introduce profile customization via a different mechanism

## [0.9.9] - 2025-11-10

### Added

- Byte-length aware Unix domain socket fallback that automatically shortens paths and honors the `KIRI_SOCKET_DIR` override for worktrees with deep prefixes.
- Regression tests covering fallback generation, multibyte paths, directory auto-creation, and debug messaging.

### Fixed

- `isDaemonRunning` and other passive health checks no longer attempt to create socket directories, preventing permission errors for non-privileged clients.

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

## [0.10.1] - 2025-11-15

### Added

- **Structured metadata ingestion**: the indexer now parses Markdown Front Matter, YAML, and JSON documents, storing normalized key/value pairs in DuckDB (`document_metadata*` tables) plus a lightweight Markdown link graph (`markdown_link`).
- **Metadata-aware search parameters**: both `files_search` and `context_bundle` accept `metadata_filters` (and inline syntax like `tag:observability`) so callers can filter/boost on front matter tags, categories, or custom YAML/JSON keys. Metadata-only queries (empty `query`) are supported for dashboards such as “which doc has `tags: sre`?”.
- **Link-graph ranking signal**: Markdown inline links are resolved to repo-relative paths and their inbound counts boost frequently referenced documentation, improving runbook discovery.

### Changed

- `files_search` merges metadata matches into the candidate set, boosts files whose metadata matches the textual query, and surfaces the new reasons (`boost:metadata`, `boost:links`).
- `context_bundle` strips metadata filter tokens from `goal`, filters candidates against the metadata tables, boosts structured matches, and records inbound-link bonuses alongside existing why-tags.
- Added migration guidance for the new tables to `docs/runbook.md` and documented the API surface (`metadata_filters`) in the client guide.
