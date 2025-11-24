#!/usr/bin/env tsx
/* global fetch */
/**
 * KIRI Golden Set Benchmark Script
 *
 * Evaluates search accuracy using representative queries and calculates:
 * - P@10 (Precision at K=10)
 * - TFFU (Time To First Useful result)
 *
 * Usage:
 *   pnpm run eval:golden
 *   tsx scripts/eval/run-golden.ts --k 10 --verbose
 */

import { spawn, type ChildProcess, execSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, isAbsolute, dirname } from "node:path";

import { parse as parseYAML } from "yaml";

import { evaluateRetrieval, type RetrievalEvent } from "../../src/eval/metrics.js";
import { resolveSafePath } from "../../src/shared/fs/safePath.ts";
import { encode as encodeGPT } from "../../src/shared/tokenizer.js";
import { matchesGlob } from "../../src/shared/utils/glob.ts";
import { withRetry } from "../../src/shared/utils/retry.ts";

const TOKEN_SAVINGS_TARGET = 0.4;
const FORCE_COMPACT_MODE =
  process.env.KIRI_FORCE_COMPACT?.toLowerCase() !== "false" &&
  process.env.KIRI_FORCE_COMPACT !== "0";

// ============================================================================
// Token & Hint Helpers
// ============================================================================

function isContextBundleResponse(payload: unknown): payload is ContextBundleResponsePayload {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const maybeContext = (payload as { context?: unknown }).context;
  return Array.isArray(maybeContext);
}

function estimateTokensFromText(content: string): number {
  try {
    return encodeGPT(content).length;
  } catch (error) {
    console.warn("Token encoding failed in eval script, using fallback", error);
    return Math.max(1, Math.ceil(content.length / 4));
  }
}

const tokenBaselineCache = new Map<string, number>();

function computeNaiveTokenBaseline(paths: string[], repoRoot: string): number | null {
  if (paths.length === 0) {
    return null;
  }
  let total = 0;
  const seen = new Set<string>();
  for (const relativePath of paths) {
    if (!relativePath || seen.has(relativePath)) {
      continue;
    }
    seen.add(relativePath);
    const absPath = join(repoRoot, relativePath);
    if (!existsSync(absPath)) {
      console.warn(`⚠️  Baseline token calc skipped. Missing path: ${absPath}`);
      return null;
    }
    try {
      let cached = tokenBaselineCache.get(absPath);
      if (cached === undefined) {
        const content = readFileSync(absPath, "utf8");
        cached = estimateTokensFromText(content);
        tokenBaselineCache.set(absPath, cached);
      }
      total += cached;
    } catch (error) {
      console.warn(`⚠️  Failed to read ${absPath} for token baseline`, error);
      return null;
    }
  }
  return total;
}

function recallAtK(retrieved: string[], relevant: Iterable<string>, k: number): number {
  const relevantSet = new Set(relevant);
  if (relevantSet.size === 0 || k <= 0) {
    return 0;
  }
  const limit = Math.min(k, retrieved.length);
  let hits = 0;
  for (let index = 0; index < limit; index += 1) {
    const id = retrieved[index];
    if (id !== undefined && relevantSet.has(id)) {
      hits += 1;
    }
  }
  return hits / relevantSet.size;
}

function computeHintCoverage(items: ContextBundleItemResponse[]): number | null {
  if (!items.length) {
    return null;
  }
  const hintHits = items.filter((item) =>
    Array.isArray(item.why) ? item.why.some((tag) => tag.startsWith("artifact:hint")) : false
  ).length;
  return items.length === 0 ? null : hintHits / items.length;
}

function computeAverage(values: Array<number | null | undefined>): number | null {
  const valid = values.filter(
    (value): value is number => typeof value === "number" && isFinite(value)
  );
  if (valid.length === 0) {
    return null;
  }
  const total = valid.reduce((sum, value) => sum + value, 0);
  return total / valid.length;
}

function computeCategoryComparisons(
  byCategory: BenchmarkResult["byCategory"]
): CategoryComparison[] {
  const comparisons: CategoryComparison[] = [];
  const categoryNames = Object.keys(byCategory);
  for (const variant of categoryNames) {
    if (!variant.endsWith("-plain")) {
      continue;
    }
    const baseline = variant.replace(/-plain$/, "");
    if (!byCategory[baseline]) {
      continue;
    }
    const baseStats = byCategory[baseline]!;
    const variantStats = byCategory[variant]!;
    const diff = (
      variantValue: number | null | undefined,
      baselineValue: number | null | undefined
    ): number | null => {
      if (variantValue == null || baselineValue == null) {
        return null;
      }
      return variantValue - baselineValue;
    };
    comparisons.push({
      baseline,
      variant,
      deltaPrecisionAtK: diff(variantStats.precisionAtK, baseStats.precisionAtK),
      deltaMetadataPassRate: diff(
        variantStats.metadataPassRate ?? null,
        baseStats.metadataPassRate ?? null
      ),
      deltaInboundPassRate: diff(
        variantStats.inboundPassRate ?? null,
        baseStats.inboundPassRate ?? null
      ),
    });
  }
  return comparisons;
}

// ============================================================================
// CI Guard
// ============================================================================

if (process.env.CI === "true") {
  console.error("❌ Golden set benchmarks are local-only. Set CI=false to override.");
  process.exit(1);
}

// ============================================================================
// Types
// ============================================================================

interface GoldenQuery {
  id: string;
  query: string;
  tool?: string;
  intent: string;
  category: string;
  hints?: string[];
  repo?: string;
  expected: {
    paths: string[];
    patterns?: string[];
  };
  params?: {
    boostProfile?: string;
    k?: number;
    timeoutMs?: number;
    scoringProfile?: string;
  };
  tags: string[];
  notes?: string;
  requiresMetadata?: boolean;
  requiresInboundLinks?: boolean;
}

interface RepoDefinition {
  repoPath: string;
  dbPath: string;
}

interface RepoRuntimeConfig extends RepoDefinition {
  id: string;
}

interface GoldenSet {
  schemaVersion: string;
  datasetVersion: string;
  description: string;
  defaultParams: {
    k: number;
    tool: string;
    boostProfile: string;
    timeoutMs: number;
  };
  defaultRepo?: string;
  repos?: Record<string, RepoDefinition>;
  queries: GoldenQuery[];
}

interface QueryResult {
  id: string;
  query: string;
  category: string;
  status: "success" | "timeout" | "error" | "empty";
  retrieved: string[];
  expected: string[];
  precisionAtK: number | null;
  recallAt5: number | null;
  timeToFirstUseful: number | null;
  retriedCount: number;
  error?: string;
  durationMs: number;
  tokensEstimate: number | null;
  tokensBaseline: number | null;
  tokenSavingsRatio: number | null;
  hintCoverage: number | null;
  metadataRequired?: boolean;
  inboundRequired?: boolean;
  metadataSatisfied?: boolean | null;
  inboundSatisfied?: boolean | null;
  whyByPath?: Record<string, string[]>;
}

interface BenchmarkResult {
  timestamp: string;
  version: string;
  gitSha: string;
  datasetVersion: string;
  k: number;
  startup: {
    maxMs: number;
  };
  overall: {
    precisionAtK: number;
    recallAt5: number;
    avgTTFU: number;
    totalQueries: number;
    successfulQueries: number;
    failedQueries: number;
    avgTokensEstimate: number | null;
    avgBaselineTokens: number | null;
    avgTokenSavingsRatio: number | null;
    avgHintCoverage: number | null;
    metadataPassRate: number | null;
    inboundPassRate: number | null;
  };
  byCategory: Record<
    string,
    {
      precisionAtK: number;
      recallAt5: number;
      avgTTFU: number;
      count: number;
      avgTokenSavingsRatio: number | null;
      avgHintCoverage: number | null;
      metadataPassRate: number | null;
      inboundPassRate: number | null;
    }
  >;
  queries: QueryResult[];
  comparisons?: CategoryComparison[];
  thresholdOverrides?: {
    minR5?: number | null;
  };
}

interface CategoryComparison {
  baseline: string;
  variant: string;
  deltaPrecisionAtK: number | null;
  deltaMetadataPassRate: number | null;
  deltaInboundPassRate: number | null;
}

interface BaselineData {
  version: string;
  gitSha: string;
  date: string;
  datasetVersion: string;
  thresholds: {
    minP10: number;
    maxTTFU: number;
    minR5?: number;
    minMetadataPassRate?: number;
    minInboundPassRate?: number;
  };
  overall: {
    precisionAtK: number | null;
    avgTTFU: number | null;
  };
}

interface BenchmarkOptions {
  k: number;
  dbPath: string;
  repoPath: string;
  outputPath: string;
  verbose: boolean;
  warmupRuns: number;
  maxRetries: number;
  repoOverride: boolean;
  dbOverride: boolean;
  categoryFilter: Set<string>;
  minR5: number | null;
  maxStartupMs: number | null;
  inspectQuery?: string;
  inspectTop: number;
}

interface ContextBundleItemResponse {
  path: string;
  range?: [number, number];
  why?: string[];
  preview?: string;
  score?: number;
}

interface ContextBundleResponsePayload {
  context: ContextBundleItemResponse[];
  tokens_estimate?: number;
}

// ============================================================================
// CLI Argument Parsing
// ============================================================================

function parseArgs(): BenchmarkOptions {
  const args = process.argv.slice(2);
  const options: BenchmarkOptions = {
    k: 10,
    dbPath: join(process.cwd(), "var", "index.duckdb"),
    repoPath: process.cwd(),
    outputPath: join(process.cwd(), "var", "eval"),
    verbose: false,
    warmupRuns: 2,
    maxRetries: 2,
    repoOverride: false,
    dbOverride: false,
    categoryFilter: new Set(),
    minR5: null,
    maxStartupMs: null,
    inspectQuery: undefined,
    inspectTop: 10,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--k":
        options.k = parseInt(args[++i] ?? "10", 10);
        break;
      case "--db":
        options.dbPath = args[++i] ?? options.dbPath;
        options.dbOverride = true;
        break;
      case "--repo":
        options.repoPath = args[++i] ?? options.repoPath;
        options.repoOverride = true;
        break;
      case "--out":
        options.outputPath = args[++i] ?? options.outputPath;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--warmup":
        options.warmupRuns = parseInt(args[++i] ?? "2", 10);
        break;
      case "--max-retries":
        options.maxRetries = parseInt(args[++i] ?? "2", 10);
        break;
      case "--categories": {
        const raw = args[++i] ?? "";
        const categories = raw
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
        options.categoryFilter = new Set(categories);
        break;
      }
      case "--min-r5":
        options.minR5 = Number.parseFloat(args[++i] ?? "");
        if (!Number.isFinite(options.minR5)) {
          options.minR5 = null;
        }
        break;
      case "--max-startup-ms":
        options.maxStartupMs = Number.parseInt(args[++i] ?? "", 10);
        if (!Number.isFinite(options.maxStartupMs)) {
          options.maxStartupMs = null;
        }
        break;
      case "--inspect-query":
        options.inspectQuery = args[++i];
        break;
      case "--inspect-top":
        options.inspectTop = Number.parseInt(args[++i] ?? "10", 10) || 10;
        break;
      case "--help":
        console.log(`
Usage: tsx scripts/eval/run-golden.ts [options]

Options:
  --k <number>           K value for P@K (default: 10)
  --db <path>            Database path (default: var/index.duckdb)
  --repo <path>          Repository root (default: current directory)
  --out <path>           Output directory (default: var/eval)
  --verbose              Enable verbose logging
  --warmup <number>      Warmup runs (default: 2)
  --max-retries <number> Max retries per query (default: 2)
  --categories <list>    Comma-separated category filter (e.g. docs,docs-plain)
  --min-r5 <number>      Minimum acceptable R@5 (0-1). Fail if below
  --max-startup-ms <ms>  Fail if MCP startup exceeds this many milliseconds
  --inspect-query <id>   Dump top candidates for a query id (debug only)
  --inspect-top <n>      Number of candidates to dump with --inspect-query (default: 10)
  --help                 Show this help message
`);
        process.exit(0);
    }
  }

  const allowUnsafe = process.env.KIRI_ALLOW_UNSAFE_PATHS === "1";
  if (!allowUnsafe) {
    const absoluteArg = [
      [options.dbPath, "--db"],
      [options.repoPath, "--repo"],
      [options.outputPath, "--out"],
    ].find(([value]) => typeof value === "string" && isAbsolute(value));
    if (absoluteArg) {
      const [value, flag] = absoluteArg;
      throw new Error(
        `${flag} received absolute path '${value}'. Set KIRI_ALLOW_UNSAFE_PATHS=1 to allow external locations.`
      );
    }
  }
  options.dbPath = resolveSafePath(options.dbPath, { allowOutsideBase: allowUnsafe });
  options.repoPath = resolveSafePath(options.repoPath, {
    allowOutsideBase: allowUnsafe,
  });
  options.outputPath = resolveSafePath(options.outputPath, {
    allowOutsideBase: allowUnsafe,
  });

  return options;
}

// ============================================================================
// MCP Server Management
// ============================================================================

class McpServerManager {
  private serverProc: ChildProcess | null = null;
  private readonly basePort = 19999;
  private assignedPort = this.basePort;
  private portShift = 0;
  private serverLogs = "";
  private cleanupHandlers: Array<[NodeJS.Signals | "exit", () => void]> = [];

  private lastRepoPath: string | null = null;

  private scoringConfigPath = join(process.cwd(), "config", "scoring-profiles.yml");

  private async verifyServerIdentity(dbPath: string): Promise<void> {
    const result = (await this.call("ping", { verbose: false, includeConfig: true }, 5000)) as
      | { db?: string; repo?: string }
      | undefined;
    const remoteDb = typeof result?.db === "string" ? result.db : undefined;
    const remoteRepo = typeof result?.repo === "string" ? result.repo : undefined;

    if (!remoteDb) {
      throw new Error(
        "Ping did not include db path; refusing to trust existing server. Restart with a clean port."
      );
    }

    const normalizedExpectedDb = resolveSafePath(dbPath, { allowOutsideBase: true });
    const normalizedRemoteDb = resolveSafePath(remoteDb, { allowOutsideBase: true });
    if (normalizedExpectedDb !== normalizedRemoteDb) {
      throw new Error(
        `Existing server uses different db: expected ${normalizedExpectedDb}, got ${normalizedRemoteDb}`
      );
    }

    if (remoteRepo) {
      const normalizedRemoteRepo = resolveSafePath(remoteRepo, { allowOutsideBase: true });
      const normalizedExpectedRepo = resolveSafePath(this.lastRepoPath ?? "", {
        allowOutsideBase: true,
      });
      if (normalizedExpectedRepo && normalizedExpectedRepo !== normalizedRemoteRepo) {
        throw new Error(
          `Existing server uses different repo: expected ${normalizedExpectedRepo}, got ${normalizedRemoteRepo}`
        );
      }
    }
  }

  async start(dbPath: string, repoPath: string, verbose: boolean, attempts = 0): Promise<number> {
    if (this.serverProc) {
      await this.stop();
    }
    this.lastRepoPath = repoPath;
    this.serverLogs = "";
    const startedAt = Date.now();
    if (verbose) {
      console.log(
        `  → Starting MCP server on port ${this.assignedPort} (db=${dbPath}, repo=${repoPath})...`
      );
    }

    const preferredPort = this.basePort + this.portShift;
    this.portShift = (this.portShift + 1) % 1000;
    this.assignedPort = await findAvailablePort(preferredPort);
    const lockPath = `${dbPath}.lock`;
    if (existsSync(lockPath)) {
      const message = `⚠️  Removing stale DuckDB lock file: ${lockPath}`;
      if (verbose) {
        console.warn(message);
      }
      try {
        rmSync(lockPath);
      } catch (error) {
        console.warn(`❌ Failed to remove ${lockPath}:`, error);
      }
    }
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (existsSync(this.scoringConfigPath) && !env.KIRI_SCORING_CONFIG) {
      env.KIRI_SCORING_CONFIG = this.scoringConfigPath;
    }

    this.serverProc = spawn(
      "tsx",
      [
        "src/server/main.ts",
        "--port",
        String(this.assignedPort),
        "--db",
        dbPath,
        "--repo",
        repoPath,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: process.cwd(),
        env,
      }
    );

    this.registerCleanupHandlers();

    this.serverProc.stdout?.on("data", (data) => {
      this.serverLogs += data.toString();
      if (verbose) {
        process.stdout.write(`[SERVER] ${data}`);
      }
    });

    this.serverProc.stderr?.on("data", (data) => {
      this.serverLogs += data.toString();
      if (verbose) {
        process.stderr.write(`[SERVER] ${data}`);
      }
    });

    const readyPromise = this.waitForReady(verbose);
    const errorPromise = once(this.serverProc, "error").then(([error]) => {
      throw error instanceof Error ? error : new Error(String(error));
    });

    try {
      await Promise.race([readyPromise, errorPromise]);
      await this.verifyServerIdentity(dbPath);
      return Date.now() - startedAt;
    } catch (error) {
      await this.stop();
      const isAddrInUse =
        error instanceof Error &&
        (error as NodeJS.ErrnoException).code === "EADDRINUSE" &&
        attempts < 5;
      if (isAddrInUse) {
        if (verbose) {
          console.warn(
            `⚠️  Port ${this.assignedPort} in use, retrying with next port (attempt ${
              attempts + 1
            }/5)...`
          );
        }
        // shift port and retry
        this.portShift = (this.portShift + 1) % 1000;
        return await this.start(dbPath, repoPath, verbose, attempts + 1);
      }
      throw error;
    }
  }

  private async waitForReady(verbose: boolean): Promise<void> {
    const maxAttempts = 30;
    const delayMs = 1000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await fetch(`http://localhost:${this.assignedPort}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 0,
            method: "ping",
            params: {},
          }),
        });

        if (response.ok) {
          if (verbose) {
            console.log(`  ✓ Server ready after ${attempt + 1} attempts`);
          }
          return;
        }
      } catch {
        // Server not ready yet
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    throw new Error(
      `MCP server failed to start within ${maxAttempts} seconds.\nServer logs:\n${this.serverLogs}`
    );
  }

  private registerCleanupHandlers(): void {
    this.removeCleanupHandlers();
    const events: Array<NodeJS.Signals | "exit"> = ["SIGINT", "SIGTERM", "SIGQUIT", "exit"];
    for (const event of events) {
      const handler = () => {
        void this.stop();
      };
      process.on(event, handler);
      this.cleanupHandlers.push([event, handler]);
    }
  }

  private removeCleanupHandlers(): void {
    for (const [event, handler] of this.cleanupHandlers) {
      process.off(event, handler);
    }
    this.cleanupHandlers = [];
  }

  async call(method: string, params: unknown, timeoutMs = 30000): Promise<unknown> {
    return await withRetry(
      async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(`http://localhost:${this.assignedPort}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: Math.random(),
              method,
              params,
            }),
            signal: controller.signal,
          });

          const result = (await response.json()) as {
            error?: { message: string };
            result?: unknown;
          };

          if (result.error) {
            throw new Error(result.error.message);
          }

          return result.result;
        } finally {
          clearTimeout(timeoutId);
        }
      },
      {
        maxAttempts: 3,
        delayMs: 1000,
        jitterMs: 300,
        isRetriable: (error) => {
          if (!(error instanceof Error)) {
            return false;
          }
          if (error.name === "AbortError") {
            return true;
          }
          return /ECONNREFUSED|ECONNRESET|fetch failed/i.test(error.message);
        },
      }
    );
  }

  async stop(): Promise<void> {
    this.removeCleanupHandlers();
    if (!this.serverProc) {
      return;
    }

    const proc = this.serverProc;
    this.serverProc = null;
    proc.kill("SIGTERM");

    try {
      await Promise.race([once(proc, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
    } catch (error) {
      console.warn("⚠️  Failed to confirm MCP server shutdown:", error);
    } finally {
      proc.removeAllListeners();
      this.assignedPort = this.basePort;
    }
  }

  getPort(): number {
    return this.assignedPort;
  }

  isRunning(): boolean {
    return this.serverProc !== null;
  }
}

async function findAvailablePort(preferred: number, retries = 10): Promise<number> {
  const net = await import("node:net");
  let port = preferred;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const isFree = await new Promise<boolean>((resolve) => {
      const tester = net.createServer();
      tester.once("error", () => resolve(false));
      tester.once("listening", () => tester.close(() => resolve(true)));
      tester.listen(port, "127.0.0.1");
    });
    if (isFree) {
      return port;
    }
    port += 1;
  }
  // Port 0 lets the OS assign a free port
  return new Promise<number>((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const freePort = typeof address === "object" && address ? address.port : preferred;
      server.close(() => resolve(freePort));
    });
  });
}

// ============================================================================
// Load Golden Set and Baseline
// ============================================================================

function loadGoldenSet(): GoldenSet {
  const path = join(process.cwd(), "tests", "eval", "goldens", "queries.yaml");
  if (!existsSync(path)) {
    throw new Error(`Golden set not found at ${path}`);
  }

  const content = readFileSync(path, "utf8");
  const goldenSet = parseYAML(content) as GoldenSet;

  // Schema version validation
  if (!goldenSet.schemaVersion) {
    throw new Error("Golden set missing schemaVersion");
  }

  const [major] = goldenSet.schemaVersion.split(".").map((v) => parseInt(v, 10));
  const supportedMajor = 1;

  if (major !== supportedMajor) {
    throw new Error(
      `Unsupported schema version ${goldenSet.schemaVersion}. Expected major version ${supportedMajor}.x.x`
    );
  }

  if (!goldenSet.queries || goldenSet.queries.length === 0) {
    throw new Error("Golden set has no queries");
  }

  return goldenSet;
}

function resolveRepoTargets(
  goldenSet: GoldenSet,
  options: BenchmarkOptions
): { repoMap: Map<string, RepoRuntimeConfig>; defaultRepoId: string } {
  const repoMap = new Map<string, RepoRuntimeConfig>();
  const allowUnsafe = process.env.KIRI_ALLOW_UNSAFE_PATHS === "1";

  if (goldenSet.repos) {
    for (const [id, config] of Object.entries(goldenSet.repos)) {
      if (!config?.repoPath || !config?.dbPath) {
        throw new Error(`Repository '${id}' must define repoPath and dbPath`);
      }
      if (!allowUnsafe && (isAbsolute(config.repoPath) || isAbsolute(config.dbPath))) {
        throw new Error(
          `Repository '${id}' specifies absolute paths but KIRI_ALLOW_UNSAFE_PATHS is not enabled.`
        );
      }
      repoMap.set(id, {
        id,
        repoPath: resolveSafePath(config.repoPath, { allowOutsideBase: allowUnsafe }),
        dbPath: resolveSafePath(config.dbPath, { allowOutsideBase: allowUnsafe }),
      });
    }
  }

  let defaultRepoId = goldenSet.defaultRepo ?? "default";

  // Allow CLI overrides to replace the default repo entry
  if (options.repoOverride || options.dbOverride) {
    repoMap.set(defaultRepoId, {
      id: defaultRepoId,
      repoPath: options.repoPath,
      dbPath: options.dbPath,
    });
  }

  if (!repoMap.size) {
    repoMap.set(defaultRepoId, {
      id: defaultRepoId,
      repoPath: options.repoPath,
      dbPath: options.dbPath,
    });
  }

  if (!repoMap.has(defaultRepoId)) {
    repoMap.set(defaultRepoId, {
      id: defaultRepoId,
      repoPath: options.repoPath,
      dbPath: options.dbPath,
    });
  }

  return { repoMap, defaultRepoId };
}

function validateRepoConfigs(repoMap: Map<string, RepoRuntimeConfig>): void {
  const setupDocs = "docs/testing.md#ゴールデンセット実行前チェックリスト";
  for (const config of repoMap.values()) {
    if (!existsSync(config.repoPath)) {
      throw new Error(
        `Repository '${config.id}' is missing at ${config.repoPath}. Follow ${setupDocs} to fetch the repo before running the benchmark.`
      );
    }
    if (!existsSync(config.dbPath)) {
      throw new Error(
        `DuckDB for repository '${config.id}' is missing at ${config.dbPath}. Run 'pnpm exec tsx src/indexer/cli.ts --repo ${config.repoPath} --db ${config.dbPath} --full' as documented in ${setupDocs}.`
      );
    }
    const lockPath = join(dirname(config.dbPath), "security.lock");
    if (!existsSync(lockPath)) {
      throw new Error(
        `Security lock missing for '${config.id}' at ${lockPath}. Execute 'pnpm exec tsx src/client/cli.ts security verify --db ${config.dbPath} --security-lock ${lockPath} --write-lock' (see ${setupDocs}).`
      );
    }
  }
}

function loadBaseline(): BaselineData {
  const path = join(process.cwd(), "tests", "eval", "goldens", "baseline.json");
  if (!existsSync(path)) {
    console.warn("⚠️  Baseline not found, using default thresholds");
    return {
      version: "",
      gitSha: "",
      date: "",
      datasetVersion: "",
      thresholds: { minP10: 0.7, maxTTFU: 1000 },
      overall: { precisionAtK: null, avgTTFU: null },
    };
  }

  const content = readFileSync(path, "utf8");
  return JSON.parse(content) as BaselineData;
}

// ============================================================================
// Main Benchmark Logic
// ============================================================================

async function main(): Promise<void> {
  const options = parseArgs();
  const goldenSet = loadGoldenSet();
  const baseline = loadBaseline();
  const queries =
    options.categoryFilter.size > 0
      ? goldenSet.queries.filter((query) => options.categoryFilter.has(query.category))
      : goldenSet.queries;

  if (queries.length === 0) {
    throw new Error("No queries match the selected category filter.");
  }

  console.log("\n🎯 KIRI Golden Set Benchmark");
  console.log("============================");
  console.log(`Dataset: ${goldenSet.datasetVersion}`);
  console.log(`Schema: ${goldenSet.schemaVersion}`);
  const filteredLabel =
    options.categoryFilter.size > 0 ? ` (filtered from ${goldenSet.queries.length})` : "";
  console.log(`Queries: ${queries.length}${filteredLabel}`);
  if (options.categoryFilter.size > 0) {
    console.log(`Categories: ${[...options.categoryFilter].join(", ")}`);
  }
  console.log(`K: ${options.k}`);
  console.log(`Warmup: ${options.warmupRuns} runs`);
  console.log("");

  // Ensure output directory exists
  if (!existsSync(options.outputPath)) {
    mkdirSync(options.outputPath, { recursive: true });
  }

  // Start MCP server
  const server = new McpServerManager();
  const { repoMap, defaultRepoId } = resolveRepoTargets(goldenSet, options);
  validateRepoConfigs(repoMap);

  const resolveQueryRepo = (query?: GoldenQuery): string => {
    const repoId = query?.repo ?? defaultRepoId;
    if (!repoMap.has(repoId)) {
      throw new Error(`Query ${query?.id ?? "unknown"} references unknown repo '${repoId}'.`);
    }
    return repoId;
  };

  let activeRepoId: string | null = null;
  let slowestStartupMs = 0;
  const ensureServerForRepo = async (repoId: string): Promise<void> => {
    if (activeRepoId === repoId && server.isRunning()) {
      return;
    }
    const config = repoMap.get(repoId);
    if (!config) {
      throw new Error(`Repository alias '${repoId}' is not configured.`);
    }
    const startupMs = await server.start(config.dbPath, config.repoPath, options.verbose);
    slowestStartupMs = Math.max(slowestStartupMs, startupMs);
    if (options.maxStartupMs !== null && startupMs > options.maxStartupMs) {
      throw new Error(
        `MCP server startup took ${startupMs}ms which exceeds --max-startup-ms=${options.maxStartupMs}`
      );
    }
    activeRepoId = repoId;
  };

  try {
    // Warmup phase (use first query's repo to prime caches)
    if (options.warmupRuns > 0 && queries.length > 0) {
      const warmupRepoId = resolveQueryRepo(queries[0]);
      await ensureServerForRepo(warmupRepoId);
      const warmupRepoPath = repoMap.get(warmupRepoId)?.repoPath;
      if (!warmupRepoPath) {
        throw new Error(`Repository path not found for warmup repo '${warmupRepoId}'.`);
      }
      console.log(`🔥 Warming up with ${options.warmupRuns} runs...`);
      for (let i = 0; i < options.warmupRuns; i++) {
        const warmupQuery = queries[0]!;
        await executeQuery(
          server,
          warmupQuery,
          goldenSet.defaultParams,
          options,
          warmupRepoPath,
          true
        );
      }
      console.log("  ✓ Warmup complete\n");
    }

    // Execute all queries
    console.log("📊 Running benchmark...\n");
    const queryResults: QueryResult[] = [];

    for (const query of queries) {
      const repoId = resolveQueryRepo(query);
      await ensureServerForRepo(repoId);
      const repoPath = repoMap.get(repoId)?.repoPath;
      if (!repoPath) {
        throw new Error(`Repository path missing for repo '${repoId}'.`);
      }
      console.log(
        `  → Executing ${query.id} on repo '${repoId}' (db=${repoMap.get(repoId)?.dbPath})`
      );
      const result = await executeQueryWithRetry(
        server,
        query,
        goldenSet.defaultParams,
        options,
        repoPath
      );
      if (options.verbose) {
        console.log(`    ↪ Retrieved paths: ${result.retrieved.slice(0, 5).join(", ")}`);
      }
      queryResults.push(result);

      const status = result.status === "success" ? "✓" : "✗";
      const p10Display = result.precisionAtK !== null ? result.precisionAtK.toFixed(2) : "N/A";
      const ttfuDisplay =
        result.timeToFirstUseful !== null
          ? `${Math.round(result.timeToFirstUseful * 1000)}ms`
          : "N/A";

      console.log(
        `  ${status} ${query.id.padEnd(15)} P@${options.k}=${p10Display} TFFU=${ttfuDisplay}`
      );
    }

    // Calculate overall metrics
    const successfulResults = queryResults.filter((r) => r.status === "success");
    const failedResults = queryResults.filter((r) => r.status !== "success");

    if (successfulResults.length === 0) {
      console.error("\n❌ All queries failed. Cannot generate results.");
      process.exit(1);
    }

    // Include failed queries as P@K=0 to reflect actual user experience
    const overallP10 =
      queryResults.reduce((sum, r) => sum + (r.precisionAtK ?? 0), 0) / queryResults.length;
    const overallR5 =
      queryResults.reduce((sum, r) => sum + (r.recallAt5 ?? 0), 0) / queryResults.length;

    // TFFU: Only average over successful queries (failures don't have timing)
    const validTTFU = successfulResults.filter(
      (r) => r.timeToFirstUseful !== null && isFinite(r.timeToFirstUseful)
    );
    const overallTTFU =
      validTTFU.length > 0
        ? (validTTFU.reduce((sum, r) => sum + (r.timeToFirstUseful ?? 0), 0) / validTTFU.length) *
          1000
        : 0;

    if (options.minR5 !== null && overallR5 < options.minR5) {
      const message = `Overall R@5 (${overallR5.toFixed(3)}) is below the required threshold (${options.minR5}).`;
      console.error(`❌ ${message}`);
      throw new Error(message);
    }

    // By-category metrics (include failures as P@K=0)
    const categories = [...new Set(queries.map((q) => q.category))];
    const byCategory: Record<
      string,
      {
        precisionAtK: number;
        recallAt5: number;
        avgTTFU: number;
        count: number;
        avgTokenSavingsRatio: number | null;
        avgHintCoverage: number | null;
        metadataPassRate: number | null;
        inboundPassRate: number | null;
      }
    > = {};

    for (const category of categories) {
      const catResults = queryResults.filter((r) => r.category === category);
      const catSuccessful = catResults.filter((r) => r.status === "success");

      if (catResults.length > 0) {
        // Filter for finite TFFU values in this category
        const catValidTTFU = catSuccessful.filter(
          (r) => r.timeToFirstUseful !== null && isFinite(r.timeToFirstUseful)
        );

        const catTokenSavings = computeAverage(catResults.map((r) => r.tokenSavingsRatio));
        const catHintCoverage = computeAverage(catResults.map((r) => r.hintCoverage));

        const catMetadataChecks = catResults.filter((r) => r.metadataRequired);
        const catInboundChecks = catResults.filter((r) => r.inboundRequired);

        byCategory[category] = {
          precisionAtK:
            catResults.reduce((sum, r) => sum + (r.precisionAtK ?? 0), 0) / catResults.length,
          recallAt5: catResults.reduce((sum, r) => sum + (r.recallAt5 ?? 0), 0) / catResults.length,
          avgTTFU:
            catValidTTFU.length > 0
              ? (catValidTTFU.reduce((sum, r) => sum + (r.timeToFirstUseful ?? 0), 0) /
                  catValidTTFU.length) *
                1000
              : 0,
          count: catResults.length,
          avgTokenSavingsRatio: catTokenSavings,
          avgHintCoverage: catHintCoverage,
          metadataPassRate:
            catMetadataChecks.length > 0
              ? catMetadataChecks.filter((r) => r.metadataSatisfied).length /
                catMetadataChecks.length
              : null,
          inboundPassRate:
            catInboundChecks.length > 0
              ? catInboundChecks.filter((r) => r.inboundSatisfied).length / catInboundChecks.length
              : null,
        };
      }
    }

    const avgTokensEstimate = computeAverage(queryResults.map((r) => r.tokensEstimate));
    const avgBaselineTokens = computeAverage(
      queryResults.map((r) => (r.tokensBaseline && r.tokensBaseline > 0 ? r.tokensBaseline : null))
    );
    const avgTokenSavingsRatio = computeAverage(queryResults.map((r) => r.tokenSavingsRatio));
    const avgHintCoverage = computeAverage(queryResults.map((r) => r.hintCoverage));
    const metadataChecks = queryResults.filter((r) => r.metadataRequired);
    const inboundChecks = queryResults.filter((r) => r.inboundRequired);
    const metadataPassRate =
      metadataChecks.length > 0
        ? metadataChecks.filter((r) => r.metadataSatisfied).length / metadataChecks.length
        : null;
    const inboundPassRate =
      inboundChecks.length > 0
        ? inboundChecks.filter((r) => r.inboundSatisfied).length / inboundChecks.length
        : null;

    // Get version info
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      version: string;
    };

    let gitSha = "unknown";
    try {
      gitSha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    } catch {
      // Git not available or not a git repository
    }

    const comparisons = computeCategoryComparisons(byCategory);

    const thresholdOverrides =
      options.minR5 !== null
        ? {
            minR5: options.minR5,
          }
        : undefined;
    const benchmarkResult: BenchmarkResult = {
      timestamp: new Date().toISOString(),
      version: packageJson.version,
      gitSha,
      datasetVersion: goldenSet.datasetVersion,
      k: options.k,
      startup: { maxMs: slowestStartupMs },
      overall: {
        precisionAtK: overallP10,
        recallAt5: overallR5,
        avgTTFU: overallTTFU,
        totalQueries: queryResults.length,
        successfulQueries: successfulResults.length,
        failedQueries: failedResults.length,
        avgTokensEstimate,
        avgBaselineTokens,
        avgTokenSavingsRatio,
        avgHintCoverage,
        metadataPassRate,
        inboundPassRate,
      },
      byCategory,
      queries: queryResults,
      ...(comparisons.length > 0 && { comparisons }),
      ...(thresholdOverrides && { thresholdOverrides }),
    };

    // Write output files
    const jsonPath = join(options.outputPath, "latest.json");
    const mdPath = join(options.outputPath, "latest.md");

    writeFileSync(jsonPath, JSON.stringify(benchmarkResult, null, 2));
    writeFileSync(mdPath, generateMarkdown(benchmarkResult, baseline));

    // Print summary
    console.log("\n" + "=".repeat(60));
    console.log("📋 Results Summary");
    console.log("=".repeat(60));
    console.log(
      `Overall:  P@${options.k} = ${overallP10.toFixed(3)} ${compareThreshold(overallP10, baseline.thresholds.minP10, true)}`
    );
    const r5Threshold = options.minR5 ?? baseline.thresholds.minR5 ?? null;
    if (r5Threshold !== null) {
      console.log(
        `          R@5 = ${overallR5.toFixed(3)} ${compareThreshold(overallR5, r5Threshold, true)}`
      );
    } else {
      console.log(`          R@5 = ${overallR5.toFixed(3)}`);
    }
    console.log(
      `          TFFU = ${Math.round(overallTTFU)}ms ${compareThreshold(overallTTFU, baseline.thresholds.maxTTFU, false)}`
    );
    if (avgTokenSavingsRatio !== null) {
      console.log(
        `          Token Savings = ${(avgTokenSavingsRatio * 100).toFixed(1)}% ${compareThreshold(avgTokenSavingsRatio, TOKEN_SAVINGS_TARGET, true)}`
      );
    }
    if (avgHintCoverage !== null) {
      console.log(`          Hint Coverage = ${(avgHintCoverage * 100).toFixed(1)}%`);
    }
    if (metadataPassRate !== null) {
      const threshold = baseline.thresholds.minMetadataPassRate ?? 1;
      console.log(
        `          Metadata Pass = ${(metadataPassRate * 100).toFixed(1)}% ${compareThreshold(metadataPassRate, threshold, true)}`
      );
    }
    if (inboundPassRate !== null) {
      const threshold = baseline.thresholds.minInboundPassRate ?? 1;
      console.log(
        `          Inbound Link Pass = ${(inboundPassRate * 100).toFixed(1)}% ${compareThreshold(inboundPassRate, threshold, true)}`
      );
    }
    console.log(`Queries:  ${successfulResults.length} successful, ${failedResults.length} failed`);
    console.log(`Startup:  max ${Math.round(slowestStartupMs)}ms`);
    console.log("=".repeat(60));

    // Baseline comparison
    if (baseline.overall.precisionAtK !== null) {
      console.log("\n📈 Baseline Comparison");
      console.log("=".repeat(60));
      const p10Delta = overallP10 - baseline.overall.precisionAtK;
      const ttfuDelta =
        baseline.overall.avgTTFU !== null ? overallTTFU - baseline.overall.avgTTFU : 0;

      console.log(
        `P@${options.k}:  ${baseline.overall.precisionAtK.toFixed(3)} → ${overallP10.toFixed(3)} (${p10Delta >= 0 ? "+" : ""}${(p10Delta * 100).toFixed(1)}%)`
      );
      if (baseline.overall.avgTTFU !== null) {
        console.log(
          `TFFU:   ${Math.round(baseline.overall.avgTTFU)}ms → ${Math.round(overallTTFU)}ms (${ttfuDelta >= 0 ? "+" : ""}${Math.round(ttfuDelta)}ms)`
        );
      }
      console.log("=".repeat(60));

      // Regression warnings
      if (p10Delta < -0.05) {
        console.warn(`⚠️  P@${options.k} regression: ${(p10Delta * 100).toFixed(1)}% decrease`);
      }
      if (baseline.overall.avgTTFU !== null && ttfuDelta > 200) {
        console.warn(`⚠️  TFFU regression: +${Math.round(ttfuDelta)}ms increase`);
      }
    }

    console.log(`\n✓ Results written to:`);
    console.log(`  JSON: ${jsonPath}`);
    console.log(`  MD:   ${mdPath}`);
    console.log("");
  } finally {
    await server.stop();
  }
}

function compareThreshold(value: number, threshold: number, higher: boolean): string {
  const passed = higher ? value >= threshold : value <= threshold;
  return passed ? "✅" : "❌";
}

async function executeQueryWithRetry(
  server: McpServerManager,
  query: GoldenQuery,
  defaultParams: GoldenSet["defaultParams"],
  options: BenchmarkOptions,
  repoRoot: string
): Promise<QueryResult> {
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      const result = await executeQuery(server, query, defaultParams, options, repoRoot, false);
      return { ...result, retriedCount: attempt };
    } catch (error) {
      if (attempt === options.maxRetries) {
        return {
          id: query.id,
          query: query.query,
          category: query.category,
          status: "error",
          retrieved: [],
          expected: query.expected.paths,
          precisionAtK: null,
          recallAt5: null,
          timeToFirstUseful: null,
          retriedCount: attempt,
          error: error instanceof Error ? error.message : String(error),
          durationMs: 0,
          tokensEstimate: null,
          tokensBaseline: null,
          tokenSavingsRatio: null,
          hintCoverage: null,
        };
      }
      // Exponential backoff with jitter
      const baseDelayMs = 1000;
      const jitter = Math.random() * 500; // 0-500ms jitter
      const delayMs = baseDelayMs * 2 ** attempt + jitter;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error("Unreachable");
}

async function executeQuery(
  server: McpServerManager,
  query: GoldenQuery,
  defaultParams: GoldenSet["defaultParams"],
  options: BenchmarkOptions,
  repoRoot: string,
  isWarmup: boolean
): Promise<QueryResult> {
  const tool = query.tool || defaultParams.tool;
  const isContextBundleTool = tool === "context_bundle";
  const k = query.params?.k || options.k;
  const boostProfile = query.params?.boostProfile || defaultParams.boostProfile;
  const scoringProfile = query.params?.scoringProfile;
  const timeoutMs = query.params?.timeoutMs || defaultParams.timeoutMs;

  // AdaptiveK: デフォルト有効。categoryベースでK値を決定させるためlimitを省略
  // 無効にするには KIRI_ADAPTIVE_K_ENABLED=0 または =false を設定
  const envValue = process.env.KIRI_ADAPTIVE_K_ENABLED?.toLowerCase();
  const adaptiveKEnabled = envValue !== "0" && envValue !== "false" && envValue !== "off";
  const params: Record<string, unknown> = {
    boost_profile: boostProfile,
  };
  if (!adaptiveKEnabled) {
    params.limit = k;
  } else {
    params.category = query.category;
  }

  const artifacts: { hints?: string[] } = {};
  if (query.hints && query.hints.length > 0) {
    artifacts.hints = query.hints;
  }

  if (isContextBundleTool) {
    params.goal = query.query;
    // AdaptiveK: カテゴリをhandlerに渡してK値調整に使用
    if (query.category) {
      params.category = query.category;
    }
    if (artifacts.hints) {
      params.artifacts = artifacts;
    }
    if (scoringProfile) {
      params.profile = scoringProfile;
    }
    if (FORCE_COMPACT_MODE) {
      params.compact = true;
    }
    params.includeTokensEstimate = true;
  } else if (tool === "files_search") {
    params.query = query.query;
  } else {
    throw new Error(`Unknown tool: ${tool}`);
  }

  if (process.env.KIRI_TRACE_QUERY === query.id) {
    console.log(`[trace] params for ${query.id}:`, JSON.stringify(params));
  }

  const startTime = process.hrtime.bigint();
  const rawResult = await server.call(tool, params, timeoutMs);
  const durationMs = Number((process.hrtime.bigint() - startTime) / 1000000n);

  if (process.env.KIRI_TRACE_QUERY === query.id) {
    console.log(
      `[trace] rawResult for ${query.id}:`,
      JSON.stringify(rawResult, null, 2).substring(0, 500)
    );
  }

  if (isWarmup) {
    return {
      id: query.id,
      query: query.query,
      category: query.category,
      status: "success",
      retrieved: [],
      expected: [],
      precisionAtK: null,
      recallAt5: null,
      timeToFirstUseful: null,
      retriedCount: 0,
      durationMs,
      tokensEstimate: null,
      tokensBaseline: null,
      tokenSavingsRatio: null,
      hintCoverage: null,
    };
  }

  const contextPayload =
    isContextBundleTool && isContextBundleResponse(rawResult)
      ? (rawResult as ContextBundleResponsePayload)
      : null;
  const contextItems = contextPayload?.context ?? [];
  const whyByPath: Record<string, string[]> = {};
  if (isContextBundleTool) {
    for (const item of contextItems) {
      if (!item.path) continue;
      if (Array.isArray(item.why) && item.why.length > 0) {
        whyByPath[item.path] = item.why;
      } else {
        whyByPath[item.path] = [];
      }
    }
  }
  const tokensEstimate =
    contextPayload && typeof contextPayload.tokens_estimate === "number"
      ? contextPayload.tokens_estimate
      : null;
  const hintCoverage = contextPayload ? computeHintCoverage(contextItems) : null;

  type MinimalResultItem = {
    path?: string;
    score?: number;
    combined?: number;
    base?: number;
  };
  const resultItems: MinimalResultItem[] = Array.isArray(rawResult)
    ? (rawResult as MinimalResultItem[])
    : contextItems;

  const retrieved = resultItems
    .map((item) => item.path)
    .filter((path): path is string => typeof path === "string");
  const metadataRequired = Boolean(query.requiresMetadata);
  const inboundRequired = Boolean(query.requiresInboundLinks);

  if (!isWarmup && options.inspectQuery && options.inspectQuery === query.id) {
    const topItems = resultItems.slice(0, options.inspectTop);
    console.log(`\n[inspect:${query.id}] top ${topItems.length} (tool=${tool})`);
    topItems.forEach((item, idx) => {
      const path = item.path ?? "<no-path>";
      const score = item.score ?? item.combined ?? item.base ?? "";
      const reasons = whyByPath[path] ?? [];
      console.log(`${idx + 1}. ${path}  score=${score}  reasons=${reasons.join("|")}`);
    });
  }

  let tokensBaseline: number | null = null;
  let tokenSavingsRatio: number | null = null;
  if (isContextBundleTool && retrieved.length > 0) {
    tokensBaseline = computeNaiveTokenBaseline(retrieved, repoRoot);
    if (tokensEstimate !== null && typeof tokensBaseline === "number" && tokensBaseline > 0) {
      const savings = 1 - tokensEstimate / tokensBaseline;
      tokenSavingsRatio = Math.max(0, Math.min(1, savings));
    }
  }

  if (retrieved.length === 0) {
    return {
      id: query.id,
      query: query.query,
      category: query.category,
      status: "empty",
      retrieved: [],
      expected: query.expected.paths,
      precisionAtK: 0,
      recallAt5: 0,
      timeToFirstUseful: null,
      retriedCount: 0,
      durationMs,
      tokensEstimate,
      tokensBaseline,
      tokenSavingsRatio,
      hintCoverage,
      metadataRequired,
      inboundRequired,
      metadataSatisfied: metadataRequired ? false : null,
      inboundSatisfied: inboundRequired ? false : null,
    };
  }

  // Calculate metrics
  // Build relevant set from exact paths and glob patterns
  const patterns = query.expected.patterns ?? [];

  // Relevant set includes:
  // 1. Exact expected paths (even if not retrieved)
  // 2. Retrieved paths matching glob patterns
  const relevantSet = new Set<string>([
    ...query.expected.paths,
    ...retrieved.filter((path) => patterns.some((pattern) => matchesGlob(path, pattern))),
  ]);

  // Use actual retrieval timing: approximate incremental arrival based on total duration
  const incrementMs = retrieved.length > 1 ? durationMs / retrieved.length : durationMs;
  const events: RetrievalEvent[] = retrieved.map((path, index) => ({
    id: path,
    timestampMs: incrementMs * (index + 1),
  }));

  const metrics = evaluateRetrieval({ items: events, relevant: relevantSet, k });
  const recall5 = recallAtK(retrieved, relevantSet, 5);

  const metadataSatisfied =
    metadataRequired === false
      ? null
      : isContextBundleTool
        ? retrieved.some((path) => {
            const tags = whyByPath[path] ?? [];
            // metadata:hint はインラインタグフィルタ（tag:xxx）によるメタデータ参照を示す
            // metadata:filter は strict フィルタ（docmeta.*）によるメタデータ参照を示す
            // boost:metadata は metadata_filters パラメータによるメタデータ参照を示す
            return (
              tags.includes("metadata:filter") ||
              tags.includes("boost:metadata") ||
              tags.includes("metadata:hint")
            );
          })
        : false;
  const inboundSatisfied =
    inboundRequired === false
      ? null
      : isContextBundleTool
        ? retrieved.some((path) => (whyByPath[path] ?? []).includes("boost:links"))
        : false;

  let status: QueryResult["status"] = "success";
  let error: string | undefined;
  if (metadataRequired && metadataSatisfied === false) {
    status = "error";
    error = "Metadata why tags missing";
  }
  if (inboundRequired && inboundSatisfied === false) {
    status = "error";
    error = error ? `${error}; inbound link why tags missing` : "Inbound link why tags missing";
  }

  const baseResult: QueryResult = {
    id: query.id,
    query: query.query,
    category: query.category,
    status,
    retrieved,
    expected: query.expected.paths,
    precisionAtK: metrics.precisionAtK,
    recallAt5: recall5,
    timeToFirstUseful: metrics.timeToFirstUseful,
    retriedCount: 0,
    durationMs,
    tokensEstimate,
    tokensBaseline,
    tokenSavingsRatio,
    hintCoverage,
    metadataRequired,
    inboundRequired,
    metadataSatisfied,
    inboundSatisfied,
  };
  if (Object.keys(whyByPath).length > 0) {
    baseResult.whyByPath = whyByPath;
  }
  if (error) {
    baseResult.error = error;
  }
  return baseResult;
}

function generateMarkdown(result: BenchmarkResult, baseline: BaselineData): string {
  const formatPercent = (value: number | null): string =>
    value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
  const formatNumber = (value: number | null): string =>
    value === null ? "N/A" : Math.round(value).toString();
  const tokenTargetPercent = (TOKEN_SAVINGS_TARGET * 100).toFixed(0);
  const formatDelta = (value: number | null): string =>
    value === null ? "N/A" : `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;

  let md = `# KIRI Golden Set Evaluation - ${result.timestamp.split("T")[0]}\n\n`;
  md += `**Version**: ${result.version} (${result.gitSha})\n`;
  md += `**Dataset**: ${result.datasetVersion}\n`;
  md += `**K**: ${result.k}\n\n`;

  md += `## Overall Metrics\n\n`;
  md += `| Metric | Value | Threshold | Status |\n`;
  md += `|--------|-------|-----------|--------|\n`;
  md += `| P@${result.k} | ${result.overall.precisionAtK.toFixed(3)} | ≥${baseline.thresholds.minP10} | ${result.overall.precisionAtK >= baseline.thresholds.minP10 ? "✅" : "❌"} |\n`;
  const mdR5Threshold = baseline.thresholds.minR5 ?? result.thresholdOverrides?.minR5 ?? null;
  if (mdR5Threshold !== null) {
    md += `| R@5 | ${result.overall.recallAt5.toFixed(3)} | ≥${mdR5Threshold} | ${result.overall.recallAt5 >= mdR5Threshold ? "✅" : "❌"} |\n`;
  } else {
    md += `| R@5 | ${result.overall.recallAt5.toFixed(3)} | - | - |\n`;
  }
  md += `| Avg TFFU | ${Math.round(result.overall.avgTTFU)}ms | ≤${baseline.thresholds.maxTTFU}ms | ${result.overall.avgTTFU <= baseline.thresholds.maxTTFU ? "✅" : "❌"} |\n`;
  const tokenStatus =
    result.overall.avgTokenSavingsRatio === null
      ? "-"
      : result.overall.avgTokenSavingsRatio >= TOKEN_SAVINGS_TARGET
        ? "✅"
        : "❌";
  md += `| Avg Token Savings | ${formatPercent(result.overall.avgTokenSavingsRatio)} | ≥${tokenTargetPercent}% | ${tokenStatus} |\n`;
  md += `| Avg Hint Coverage | ${formatPercent(result.overall.avgHintCoverage)} | - | - |\n`;
  if (result.overall.metadataPassRate !== null) {
    const metadataThreshold = baseline.thresholds.minMetadataPassRate ?? 1;
    md += `| Metadata Pass | ${formatPercent(result.overall.metadataPassRate)} | ≥${(metadataThreshold * 100).toFixed(0)}% | ${compareThreshold(result.overall.metadataPassRate, metadataThreshold, true)} |\n`;
  }
  if (result.overall.inboundPassRate !== null) {
    const inboundThreshold = baseline.thresholds.minInboundPassRate ?? 1;
    md += `| Inbound Link Pass | ${formatPercent(result.overall.inboundPassRate)} | ≥${(inboundThreshold * 100).toFixed(0)}% | ${compareThreshold(result.overall.inboundPassRate, inboundThreshold, true)} |\n`;
  }
  md += `| Avg Bundle Tokens | ${formatNumber(result.overall.avgTokensEstimate)} | - | - |\n`;
  md += `| Avg Baseline Tokens | ${formatNumber(result.overall.avgBaselineTokens)} | - | - |\n`;
  md += `| Max Startup | ${Math.round(result.startup.maxMs)}ms | - | - |\n`;
  md += `| Total Queries | ${result.overall.totalQueries} | - | - |\n`;
  md += `| Successful | ${result.overall.successfulQueries} | - | - |\n`;
  md += `| Failed | ${result.overall.failedQueries} | - | - |\n\n`;

  md += `## By Category\n\n`;
  md += `| Category | P@${result.k} | R@5 | Avg TFFU | Avg Token Savings | Avg Hint Coverage | Metadata Pass | Inbound Pass | Count |\n`;
  md += `|----------|------|-----|----------|-----------------|------------------|---------------|--------------|-------|\n`;
  for (const [category, metrics] of Object.entries(result.byCategory)) {
    md += `| ${category} | ${metrics.precisionAtK.toFixed(3)} | ${metrics.recallAt5.toFixed(3)} | ${Math.round(metrics.avgTTFU)}ms | ${formatPercent(metrics.avgTokenSavingsRatio ?? null)} | ${formatPercent(metrics.avgHintCoverage ?? null)} | ${formatPercent(metrics.metadataPassRate ?? null)} | ${formatPercent(metrics.inboundPassRate ?? null)} | ${metrics.count} |\n`;
  }
  md += `\n`;

  if (result.comparisons && result.comparisons.length > 0) {
    md += `## Category Δ Metrics\n\n`;
    md += `| Baseline | Variant | ΔP@${result.k} | ΔMetadata Pass | ΔInbound Pass |\n`;
    md += `|----------|---------|-----------|-----------------|----------------|\n`;
    for (const comparison of result.comparisons) {
      md += `| ${comparison.baseline} | ${comparison.variant} | ${formatDelta(comparison.deltaPrecisionAtK)} | ${formatDelta(comparison.deltaMetadataPassRate)} | ${formatDelta(comparison.deltaInboundPassRate)} |\n`;
    }
    md += `\n`;
  }

  // Failed queries
  const failed = result.queries.filter((q) => q.status !== "success");
  if (failed.length > 0) {
    md += `## Failed Queries\n\n`;
    md += `| ID | Status | Error |\n`;
    md += `|----|--------|-------|\n`;
    for (const q of failed) {
      md += `| ${q.id} | ${q.status} | ${q.error ?? "N/A"} |\n`;
    }
    md += `\n`;
  }

  return md;
}

// ============================================================================
// Entry Point
// ============================================================================

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(`\n❌ Benchmark failed: ${error.message}`);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  });
