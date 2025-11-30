---
doc_id: "GUIDE-008"
title: "Configuration Guide"
category: "guide"
tags:
  - configuration
  - environment
  - settings
  - advanced
service: "kiri"
---

# KIRI Configuration Guide

Environment variables and advanced configuration options.

## Environment Variables

### Core Settings

| Variable                     | Default        | Description                                                              |
| ---------------------------- | -------------- | ------------------------------------------------------------------------ |
| `KIRI_DAEMON_READY_TIMEOUT`  | `240`          | Daemon initialization timeout (seconds). Increase for large repositories |
| `KIRI_SOCKET_DIR`            | OS tmp dir     | Directory for Unix socket fallback when repo paths are too long          |
| `KIRI_TOKENIZATION_STRATEGY` | `phrase-aware` | Tokenization strategy for search                                         |
| `KIRI_SCORE_THRESHOLD`       | `0.05`         | Minimum score threshold for search results                               |
| `KIRI_ENABLE_DOMAIN_TERMS`   | `0`            | Enable domain-specific term expansion (`1` to enable)                    |
| `KIRI_HINT_LOG`              | `0`            | Enable hint expansion logging (`1` to enable)                            |
| `KIRI_SERVER_COMMAND`        | -              | Override MCP server binary (e.g., `npx -y kiri-mcp-server@0.10.0`)       |
| `DEBUG`                      | -              | Enable verbose logging (set to `kiri:*`)                                 |

### Dart Analysis Server

For projects containing Dart code:

| Variable                       | Default | Description                                  |
| ------------------------------ | ------- | -------------------------------------------- |
| `DART_SDK_DETECT_TIMEOUT_MS`   | `5000`  | SDK detection timeout                        |
| `DART_ANALYSIS_MAX_CLIENTS`    | `8`     | Maximum concurrent analysis server processes |
| `DART_ANALYSIS_CLIENT_WAIT_MS` | `10000` | Max wait time for available analysis server  |
| `DART_ANALYSIS_IDLE_MS`        | `60000` | Idle time before disposing unused server     |
| `DART_FILE_QUEUE_TTL_MS`       | `30000` | TTL for file-level request queues            |

**Tuning recommendations:**

- **Large Dart projects (>500 files)**: Increase `DART_ANALYSIS_MAX_CLIENTS` to 16-32
- **Network/UNC path issues**: Decrease `DART_SDK_DETECT_TIMEOUT_MS` to 2000
- **Memory constraints**: Decrease `DART_ANALYSIS_MAX_CLIENTS` to 4
- **Monorepo with many workspaces**: Increase `DART_ANALYSIS_CLIENT_WAIT_MS` to 30000

## Tokenization Strategies

Control how KIRI tokenizes and matches compound terms:

```bash
export KIRI_TOKENIZATION_STRATEGY=phrase-aware  # default
```

| Strategy       | Behavior                                                                  | Best For                      |
| -------------- | ------------------------------------------------------------------------- | ----------------------------- |
| `phrase-aware` | Compound terms (kebab-case, snake_case) treated as phrases with 2× weight | Consistent naming conventions |
| `legacy`       | Traditional word-by-word tokenization                                     | Backward compatibility        |
| `hybrid`       | Both phrase and word-level matching                                       | Maximum flexibility           |

## Scoring Profiles

Configure file type boosting in `config/scoring-profiles.yml`:

```yaml
default:
  docPenaltyMultiplier: 0.5 # 50% reduction for docs
  configPenaltyMultiplier: 0.05 # 95% reduction for config files
  implBoostMultiplier: 1.3 # 30% boost for implementation
  blacklistPenaltyMultiplier: 0.01
  testPenaltyMultiplier: 0.02
  lockPenaltyMultiplier: 0.01
```

## Denylist Configuration

Create `.kiri/denylist.yml` to exclude files from indexing:

```yaml
patterns:
  # Minified files
  - "**/*.min.js"
  - "**/*.min.css"

  # Vendor directories
  - "**/vendor/**"
  - "**/node_modules/**"

  # Build output
  - "**/dist/**"
  - "**/build/**"

  # Large generated files
  - "**/*.generated.*"
```

**Note**: KIRI automatically respects `.gitignore` patterns.

## Database Options

### Auto-Gitignore

KIRI automatically creates `.gitignore` in database directories:

```typescript
const db = await DuckDBClient.connect({
  databasePath: ".kiri/index.duckdb",
  autoGitignore: true, // default: true
});
```

Set `autoGitignore: false` to disable.

### Connection Options

```typescript
const db = await DuckDBClient.connect({
  databasePath: ".kiri/index.duckdb",
  ensureDirectory: true, // Auto-create parent directories
  autoGitignore: true, // Create .gitignore in db directory
});
```

## Domain Terms Dictionary

Enable domain-specific term expansion:

```bash
export KIRI_ENABLE_DOMAIN_TERMS=1
```

Configure in `config/domain-terms.yml`:

```yaml
terms:
  auth:
    aliases: [authentication, authorization, login, session]
  db:
    aliases: [database, duckdb, sqlite, postgres]
  api:
    aliases: [endpoint, handler, route, rest]
```

## Stop Words Configuration

Configure stop words in `config/stop-words.yml`:

```yaml
version: "1.0"
default_language: "en"

languages:
  en:
    words:
      - the
      - a
      - an
      - is
      - are
      # ... (see full list in config/stop-words.yml)

  ja:
    words:
      # Particles (joshi)
      - ha # は
      - ga # が
      - wo # を
      - ni # に
      - no # の
      # ... (see full list in config/stop-words.yml)

custom: [] # Add repository-specific stop words
```

> **Note**: Japanese stop words are stored in hiragana in the actual config file. See `config/stop-words.yml` for the complete list.

**Features:**

- Multi-language support (English, Japanese)
- NFKC normalization
- Katakana to Hiragana conversion for Japanese
- Custom stop words per repository

## CLI Options

### Server Modes

```bash
# stdio mode (MCP - default)
kiri --repo . --db .kiri/index.duckdb

# HTTP mode (testing/debugging)
kiri --repo . --db .kiri/index.duckdb --port 8765

# Force re-indexing
kiri --repo . --db .kiri/index.duckdb --reindex

# Full index rebuild
kiri --repo . --db .kiri/index.duckdb --full

# Watch mode
kiri --repo . --db .kiri/index.duckdb --watch

# Custom debounce
kiri --repo . --db .kiri/index.duckdb --watch --debounce 1000
```

### Indexer Options

```bash
# Skip cochange analysis
kiri --repo . --db .kiri/index.duckdb --no-cochange

# Security verification
kiri security verify --db .kiri/index.duckdb
```

## Security Configuration

KIRI automatically filters sensitive files:

**Excluded patterns:**

- `.env*`
- `*.pem`
- `secrets/**`

**Response masking:**

Sensitive values in MCP responses are masked with `***`.

## Performance Tuning

### Large Repositories (>10,000 files)

```json
{
  "env": {
    "KIRI_DAEMON_READY_TIMEOUT": "480"
  }
}
```

### Deep Directory Paths

If you encounter `listen EINVAL` errors:

```bash
export KIRI_SOCKET_DIR=/var/run/kiri
```

### Memory-Constrained Environments

- Reduce `DART_ANALYSIS_MAX_CLIENTS`
- Increase debounce timing
- Use denylist to exclude large directories
