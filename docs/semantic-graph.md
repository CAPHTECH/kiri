---
doc_id: "ARCH-009"
title: "Semantic Graph"
category: "architecture"
tags:
  - design
  - dcca
  - semantic-graph
  - domain-model
service: "kiri"
---

# KIRI Semantic Graph

> Domain-Centric Contextual Analysis (DCCA) による KIRI プロジェクトの意味グラフ

## 1. Domain Overview

KIRI is a **Context Extraction Platform for LLMs** that indexes Git repositories into DuckDB and provides MCP (Model Context Protocol) tools for semantic code search.

**Key Design Principle**: Degrade-first architecture - the system must work without VSS/FTS extensions.

## 2. Bounded Contexts

```mermaid
graph TB
    subgraph "Indexer Context"
        IC[Indexer CLI]
        GS[Git Scanner]
        CI[CodeIntel]
        SM[Schema Manager]
        GM[Graph Metrics]
        CC[Cochange Analyzer]
    end

    subgraph "Server Context"
        MS[MCP Server]
        RPC[RPC Handler]
        HD[Handlers]
        SC[Scoring Engine]
        BP[Boost Profiles]
        DC[Degrade Controller]
    end

    subgraph "Shared Context"
        DB[(DuckDB Client)]
        TK[Tokenizer]
        EM[Embedding]
        LF[Lockfile]
    end

    subgraph "Client Context"
        PX[Proxy]
        DM[Daemon]
    end

    IC --> GS
    IC --> CI
    IC --> SM
    IC --> GM
    IC --> CC
    GS --> DB
    SM --> DB

    MS --> RPC
    RPC --> HD
    HD --> SC
    HD --> BP
    HD --> DC
    HD --> DB

    PX --> DM
    DM --> MS
```

## 3. Entity Relationship Diagram

```mermaid
erDiagram
    REPO ||--o{ FILE : contains
    REPO ||--o{ TREE : has_history
    REPO ||--o{ SYMBOL : indexes
    REPO ||--o{ SNIPPET : chunks
    REPO ||--o{ DEPENDENCY : tracks
    REPO ||--o{ DOCUMENT_METADATA : stores

    BLOB ||--o{ TREE : referenced_by
    BLOB ||--o{ FILE : content_of

    FILE ||--o{ SYMBOL : defines
    FILE ||--o{ SNIPPET : partitions
    FILE ||--o{ DEPENDENCY : imports

    SYMBOL ||--o| SNIPPET : bounds

    DOCUMENT_METADATA ||--o{ DOCUMENT_METADATA_KV : expands

    FILE ||--o{ MARKDOWN_LINK : links_from
    FILE ||--o{ MARKDOWN_LINK : links_to

    REPO {
        int id PK
        text root
        text normalized_root
        text default_branch
        timestamp indexed_at
        boolean fts_dirty
        text fts_status
    }

    BLOB {
        text hash PK
        int size_bytes
        int line_count
        text content
    }

    TREE {
        int repo_id PK
        text commit_hash PK
        text path PK
        text blob_hash FK
        text ext
        text lang
        boolean is_binary
    }

    FILE {
        int repo_id PK
        text path PK
        text blob_hash FK
        text ext
        text lang
        boolean is_binary
        timestamp mtime
    }

    SYMBOL {
        int repo_id PK
        text path PK
        bigint symbol_id PK
        text name
        text kind
        int range_start_line
        int range_end_line
        text signature
        text doc
    }

    SNIPPET {
        int repo_id PK
        text path PK
        bigint snippet_id PK
        int start_line
        int end_line
        bigint symbol_id FK
    }

    DEPENDENCY {
        int repo_id PK
        text src_path PK
        text dst_kind PK
        text dst PK
        text rel PK
    }

    DOCUMENT_METADATA {
        int repo_id PK
        text path PK
        text source PK
        json data
        timestamp updated_at
    }

    DOCUMENT_METADATA_KV {
        int repo_id PK
        text path PK
        text source PK
        text key PK
        text value PK
    }

    MARKDOWN_LINK {
        int repo_id PK
        text src_path PK
        text target PK
        text anchor_text PK
        text resolved_path
        text kind
    }
```

## 4. Core Domain Entities

### 4.1 Indexer Domain

```
[Semantic Graph: Indexer Domain]

## Entities
- Repository: Git repository to be indexed
  - id: INTEGER [PRIMARY KEY, AUTO_INCREMENT]
  - root: TEXT [NOT NULL, UNIQUE]
  - normalized_root: TEXT [UNIQUE]
  - indexed_at: TIMESTAMP

- Blob: Content-addressable file content
  - hash: TEXT [PRIMARY KEY, SHA256]
  - content: TEXT [nullable for binary]
  - size_bytes: INTEGER
  - line_count: INTEGER

- File: HEAD state of repository files
  - repo_id: INTEGER [FK -> Repository]
  - path: TEXT [relative to repo root]
  - blob_hash: TEXT [FK -> Blob]
  - lang: TEXT [detected language]
  - is_binary: BOOLEAN

- Symbol: AST-extracted code elements
  - symbol_id: BIGINT [sequential within file]
  - name: TEXT
  - kind: TEXT [function|class|method|interface|enum]
  - range_start_line: INTEGER [1-based]
  - range_end_line: INTEGER [1-based]
  - signature: TEXT [max 200 chars]
  - doc: TEXT [docstring/comment]

- Snippet: Line-range code chunks
  - snippet_id: BIGINT [sequential within file]
  - start_line: INTEGER [1-based]
  - end_line: INTEGER [1-based]
  - symbol_id: BIGINT [nullable, FK -> Symbol]

- Dependency: Import/require relationships
  - src_path: TEXT [importing file]
  - dst_kind: TEXT [path|package]
  - dst: TEXT [resolved path or package name]
  - rel: TEXT [import|require|include]

## Relationships
- Repository --[contains]--> File (1:N)
- File --[content_of]--> Blob (N:1)
- File --[defines]--> Symbol (1:N)
- File --[partitions]--> Snippet (1:N)
- Symbol --[bounds]--> Snippet (1:0..1)
- File --[imports]--> Dependency (1:N)

## Invariants
- Blob.hash must be SHA256 of content
- Symbol ranges must be within file line_count
- Snippet ranges must not overlap within file
- normalized_root is case-insensitive unique
```

### 4.2 Server Domain

```
[Semantic Graph: Server Domain]

## Entities
- ServerContext: Runtime context for request handling
  - db: DuckDBClient [connection pool]
  - repoId: INTEGER [resolved from repoRoot]
  - services: ServerServices [shared services]
  - features: FeatureFlags [fts enabled, etc.]
  - tableAvailability: TableAvailability [schema state]
  - warningManager: WarningManager [per-request]

- ServerServices: Shared service container
  - repoRepository: RepoRepository [data access]
  - repoResolver: RepoResolver [path -> id]
  - domainTerms: DomainTermsDictionary [aliases]
  - stopWords: StopWordsService [filtering]

- ScoringWeights: Ranking configuration
  - textMatch: FLOAT [keyword search weight]
  - pathMatch: FLOAT [path keyword weight]
  - editingPath: FLOAT [current file boost]
  - dependency: FLOAT [import relationship]
  - proximity: FLOAT [same directory]
  - structural: FLOAT [LSH similarity]
  - graphInbound: FLOAT [dependency graph]
  - graphImportance: FLOAT [PageRank-like]

- BoostProfile: File type scoring modifiers
  - name: TEXT [default|docs|balanced|code|none]
  - pathMultipliers: PathMultiplier[]
  - extensionPenalties: Map<ext, multiplier>

- DegradeState: Graceful degradation status
  - active: BOOLEAN
  - reason: TEXT [null if not degraded]
  - since: TIMESTAMP

## Relationships
- ServerContext --[uses]--> ServerServices (1:1)
- ServerContext --[contains]--> DuckDBClient (1:1)
- Handler --[reads]--> ScoringWeights (N:1)
- Handler --[applies]--> BoostProfile (N:1)
- RpcHandler --[monitors]--> DegradeState (N:1)

## Behaviors
- ServerContext.resolveRepo(): Resolve path to repoId
- ScoringWeights.calculateScore(): Compute ranked score
- DegradeController.enterDegrade(): Activate fallback mode
- WarningManager.warnOnce(): Deduplicated warnings
```

### 4.3 CodeIntel Domain

```
[Semantic Graph: CodeIntel Domain]

## Entities
- LanguageAnalyzer: Language-specific parser interface
  - language: TEXT [TypeScript|Swift|PHP|Java|Rust|Dart]
  - analyze(): AnalysisContext -> AnalysisResult
  - dispose(): void [optional cleanup]

- AnalysisContext: Parser input
  - pathInRepo: TEXT [relative path]
  - content: TEXT [file content]
  - fileSet: Set<TEXT> [indexed files for resolution]
  - workspaceRoot: TEXT [optional, for LSP]

- AnalysisResult: Parser output
  - symbols: SymbolRecord[]
  - snippets: SnippetRecord[]
  - dependencies: DependencyRecord[]
  - status: TEXT [success|error|sdk_unavailable]
  - error: TEXT [optional error message]

- LanguageRegistry: Central analyzer registry
  - analyzers: Map<lang, LanguageAnalyzer>
  - register(): Add analyzer
  - getAnalyzer(): Lookup by language

## Relationships
- LanguageRegistry --[manages]--> LanguageAnalyzer (1:N)
- LanguageAnalyzer --[produces]--> AnalysisResult (1:N)
- AnalysisResult --[contains]--> SymbolRecord (1:N)
- AnalysisResult --[contains]--> SnippetRecord (1:N)
- AnalysisResult --[contains]--> DependencyRecord (1:N)

## Invariants
- LanguageAnalyzer must be stateless or thread-safe
- Parse errors return empty result, never throw
- SymbolRecord.signature max 200 characters
```

## 5. MCP Tools (Aggregate Roots)

```mermaid
graph LR
    subgraph "MCP Tools"
        CB[context_bundle]
        FS[files_search]
        SG[snippets_get]
        DC[deps_closure]
        SR[semantic_rerank]
    end

    subgraph "Core Operations"
        KS[Keyword Search]
        RS[Ranking & Scoring]
        FI[File Filtering]
        DG[Dependency Graph]
        EM[Embedding]
    end

    CB --> KS
    CB --> RS
    CB --> FI
    CB --> DG

    FS --> KS
    FS --> FI

    SG --> FI

    DC --> DG

    SR --> EM
    SR --> RS
```

## 6. Data Flow Architecture

```mermaid
sequenceDiagram
    participant Client as MCP Client
    participant Server as KIRI Server
    participant RPC as RPC Handler
    participant Handler as Tool Handler
    participant DB as DuckDB
    participant Degrade as DegradeController

    Client->>Server: JSON-RPC Request
    Server->>RPC: parseRequest()
    RPC->>Degrade: checkDegradeState()

    alt FTS Available
        RPC->>Handler: contextBundle(params)
        Handler->>DB: FTS Query
    else Degrade Mode
        RPC->>Handler: contextBundle(params)
        Handler->>DB: ILIKE Fallback
    end

    DB-->>Handler: Raw Results
    Handler->>Handler: applyScoring()
    Handler->>Handler: applyBoostProfile()
    Handler-->>RPC: Ranked Results
    RPC-->>Server: JSON-RPC Response
    Server-->>Client: Response
```

## 7. Module Dependency Graph

```mermaid
graph TD
    subgraph "Entry Points"
        CLI[indexer/cli.ts]
        MAIN[server/main.ts]
        DAEMON[daemon/daemon.ts]
        PROXY[client/proxy.ts]
    end

    subgraph "Indexer Layer"
        SCHEMA[indexer/schema.ts]
        GIT[indexer/git.ts]
        CODEINTEL[indexer/codeintel.ts]
        LANG[indexer/language.ts]
        WATCH[indexer/watch.ts]
        GRAPHM[indexer/graph-metrics.ts]
        COCHANGE[indexer/cochange.ts]
    end

    subgraph "Server Layer"
        RPC[server/rpc.ts]
        HANDLERS[server/handlers.ts]
        CONTEXT[server/context.ts]
        SERVICES[server/services/index.ts]
        SCORING[server/scoring.ts]
        BOOST[server/boost-profiles.ts]
        IDF[server/idf-provider.ts]
        DEGRADE[server/fallbacks/degradeController.ts]
    end

    subgraph "Shared Layer"
        DUCKDB[shared/duckdb.ts]
        TOKENIZER[shared/tokenizer.ts]
        EMBEDDING[shared/embedding.ts]
        ADAPTIVEK[shared/adaptive-k.ts]
        LOCKFILE[shared/utils/lockfile.ts]
        PATHUTIL[shared/utils/path.ts]
    end

    CLI --> SCHEMA
    CLI --> GIT
    CLI --> CODEINTEL
    CLI --> WATCH
    CLI --> GRAPHM
    CLI --> COCHANGE
    CLI --> DUCKDB

    MAIN --> RPC
    MAIN --> HANDLERS
    MAIN --> WATCH

    RPC --> HANDLERS
    RPC --> DEGRADE
    HANDLERS --> CONTEXT
    HANDLERS --> SCORING
    HANDLERS --> BOOST
    HANDLERS --> IDF
    HANDLERS --> DUCKDB
    CONTEXT --> SERVICES
    SERVICES --> DUCKDB

    CODEINTEL --> LANG

    SCHEMA --> DUCKDB
    GIT --> PATHUTIL
    GRAPHM --> DUCKDB
    COCHANGE --> DUCKDB

    DAEMON --> MAIN
    PROXY --> DAEMON
```

## 8. Aggregates and Value Objects

### Aggregates (with their invariants)

| Aggregate Root   | Entities                                            | Invariants                                                                     |
| ---------------- | --------------------------------------------------- | ------------------------------------------------------------------------------ |
| `Repository`     | Blob, Tree, File, Symbol, Snippet, Dependency       | `normalized_root` must be unique; all child entities reference valid `repo_id` |
| `ServerContext`  | DuckDBClient, ServerServices, WarningManager        | `repoId` must exist in database; features reflect actual DB capabilities       |
| `AnalysisResult` | SymbolRecord[], SnippetRecord[], DependencyRecord[] | Symbol ranges must be valid; snippets must not overlap                         |
| `ScoringWeights` | (value object properties)                           | All weights >= 0; penalty multipliers <= 1.0; boost multipliers >= 1.0         |

### Value Objects

| Value Object        | Properties                                            | Constraints                 |
| ------------------- | ----------------------------------------------------- | --------------------------- |
| `PathMultiplier`    | prefix, multiplier                                    | multiplier > 0              |
| `SymbolRecord`      | symbolId, name, kind, range, signature, doc           | signature max 200 chars     |
| `SnippetRecord`     | startLine, endLine, symbolId                          | startLine <= endLine        |
| `DependencyRecord`  | dstKind, dst, rel                                     | dstKind in [path, package]  |
| `DegradeState`      | active, reason, since                                 | reason required when active |
| `FtsStatusCache`    | ready, schemaExists, anyDirty, lastChecked            | lastChecked is epoch ms     |
| `TableAvailability` | hasMetadataTables, hasLinkTable, hasGraphMetrics, ... | boolean flags               |

## 9. Cross-Cutting Concerns

### 9.1 Degrade-First Architecture

- System must function without FTS/VSS extensions
- `DegradeController` monitors extension availability
- Handlers fall back to ILIKE queries when FTS unavailable

### 9.2 Security

- `.env*`, `*.pem`, `secrets/**` patterns filtered by indexer
- Sensitive paths masked with `***` in MCP responses
- `maskValue()` applied to response data

### 9.3 Observability

- Prometheus metrics via `MetricsRegistry`
- Tracing via `withSpan()` wrapper
- Adaptive K selection metrics: `adaptive_k_selected_total`, `adaptive_k_deviation_total`

### 9.4 Performance

- Token efficiency: compact mode, snippets-on-demand
- IDF caching in `DuckDbIdfProvider`
- Scoring profile caching at startup
- WAL checkpointing on connection close
