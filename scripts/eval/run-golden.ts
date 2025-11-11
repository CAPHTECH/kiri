#!/usr/bin/env tsx
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

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess, execSync } from "node:child_process";
import { parse as parseYAML } from "yaml";

import {
  evaluateRetrieval,
  type RetrievalEvent,
  type RetrievalMetrics,
} from "../../src/eval/metrics.js";

// ============================================================================
// Glob Pattern Matching
// ============================================================================

/**
 * Simple glob matcher supporting ** and * wildcards
 * Examples:
 *   - "src/**\/*.ts" matches "src/handlers.ts", "src/server/handlers.ts", "src/a/b/c.ts"
 *   - "config/*.yml" matches "config/settings.yml" but not "config/sub/settings.yml"
 *   - "**\/test.ts" matches "test.ts", "src/test.ts", "src/sub/test.ts"
 */
function matchesGlob(path: string, pattern: string): boolean {
  // Normalize paths
  const normalizedPath = path.replace(/^\.\//, "");
  const normalizedPattern = pattern.replace(/^\.\//, "");

  // Convert glob pattern to regex
  // Escape special regex characters except * and /
  let regexPattern = normalizedPattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    // Handle ** patterns (must be done before single * replacement)
    .replace(/\*\*\//g, "DOUBLESTAR_SLASH") // **/ → zero or more dirs
    .replace(/\/\*\*/g, "SLASH_DOUBLESTAR") // /** → optional path
    .replace(/\*\*/g, "DOUBLESTAR") // ** at start/end
    // Handle single * (matches filename segment)
    .replace(/\*/g, "[^/]*")
    // Convert placeholders to regex
    .replace(/DOUBLESTAR_SLASH/g, "(?:.*/)?") // **/ allows zero dirs: a/**/b matches a/b
    .replace(/SLASH_DOUBLESTAR/g, "(?:/.*)?") // /** optional suffix
    .replace(/DOUBLESTAR/g, ".*"); // ** alone matches anything

  // Ensure full match
  regexPattern = `^${regexPattern}$`;

  const regex = new RegExp(regexPattern);
  return regex.test(normalizedPath);
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
  expected: {
    paths: string[];
    patterns?: string[];
  };
  params?: {
    boostProfile?: string;
    k?: number;
    timeoutMs?: number;
  };
  tags: string[];
  notes?: string;
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
  timeToFirstUseful: number | null;
  retriedCount: number;
  error?: string;
  durationMs: number;
}

interface BenchmarkResult {
  timestamp: string;
  version: string;
  gitSha: string;
  datasetVersion: string;
  k: number;
  overall: {
    precisionAtK: number;
    avgTTFU: number;
    totalQueries: number;
    successfulQueries: number;
    failedQueries: number;
  };
  byCategory: Record<string, { precisionAtK: number; avgTTFU: number; count: number }>;
  queries: QueryResult[];
}

interface BaselineData {
  version: string;
  gitSha: string;
  date: string;
  datasetVersion: string;
  thresholds: {
    minP10: number;
    maxTTFU: number;
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
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--k":
        options.k = parseInt(args[++i] ?? "10", 10);
        break;
      case "--db":
        options.dbPath = args[++i] ?? options.dbPath;
        break;
      case "--repo":
        options.repoPath = args[++i] ?? options.repoPath;
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
  --help                 Show this help message
`);
        process.exit(0);
    }
  }

  return options;
}

// ============================================================================
// MCP Server Management
// ============================================================================

class McpServerManager {
  private serverProc: ChildProcess | null = null;
  private readonly port = 19999; // Use different port to avoid conflicts
  private serverLogs = "";

  async start(dbPath: string, repoPath: string, verbose: boolean): Promise<void> {
    if (verbose) {
      console.log(`  → Starting MCP server on port ${this.port}...`);
    }

    this.serverProc = spawn(
      "tsx",
      ["src/server/main.ts", "--port", String(this.port), "--db", dbPath, "--repo", repoPath],
      {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: process.cwd(),
      }
    );

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

    // Wait for server to be ready
    await this.waitForReady(verbose);
  }

  private async waitForReady(verbose: boolean): Promise<void> {
    const maxAttempts = 30;
    const delayMs = 1000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await fetch(`http://localhost:${this.port}`, {
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

  async call(method: string, params: unknown, timeoutMs = 30000): Promise<unknown> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`http://localhost:${this.port}`, {
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
  }

  async stop(): Promise<void> {
    if (this.serverProc) {
      this.serverProc.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  getPort(): number {
    return this.port;
  }
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

  console.log("\n🎯 KIRI Golden Set Benchmark");
  console.log("============================");
  console.log(`Dataset: ${goldenSet.datasetVersion}`);
  console.log(`Schema: ${goldenSet.schemaVersion}`);
  console.log(`Queries: ${goldenSet.queries.length}`);
  console.log(`K: ${options.k}`);
  console.log(`Warmup: ${options.warmupRuns} runs`);
  console.log("");

  // Ensure output directory exists
  if (!existsSync(options.outputPath)) {
    mkdirSync(options.outputPath, { recursive: true });
  }

  // Start MCP server
  const server = new McpServerManager();
  try {
    await server.start(options.dbPath, options.repoPath, options.verbose);

    // Warmup phase
    if (options.warmupRuns > 0 && goldenSet.queries.length > 0) {
      console.log(`🔥 Warming up with ${options.warmupRuns} runs...`);
      for (let i = 0; i < options.warmupRuns; i++) {
        const warmupQuery = goldenSet.queries[0]!;
        await executeQuery(server, warmupQuery, goldenSet.defaultParams, options, true);
      }
      console.log("  ✓ Warmup complete\n");
    }

    // Execute all queries
    console.log("📊 Running benchmark...\n");
    const queryResults: QueryResult[] = [];

    for (const query of goldenSet.queries) {
      const result = await executeQueryWithRetry(server, query, goldenSet.defaultParams, options);
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

    // TFFU: Only average over successful queries (failures don't have timing)
    const validTTFU = successfulResults.filter(
      (r) => r.timeToFirstUseful !== null && isFinite(r.timeToFirstUseful)
    );
    const overallTTFU =
      validTTFU.length > 0
        ? (validTTFU.reduce((sum, r) => sum + (r.timeToFirstUseful ?? 0), 0) / validTTFU.length) *
          1000
        : 0;

    // By-category metrics (include failures as P@K=0)
    const categories = [...new Set(goldenSet.queries.map((q) => q.category))];
    const byCategory: Record<string, { precisionAtK: number; avgTTFU: number; count: number }> = {};

    for (const category of categories) {
      const catResults = queryResults.filter((r) => r.category === category);
      const catSuccessful = catResults.filter((r) => r.status === "success");

      if (catResults.length > 0) {
        // Filter for finite TFFU values in this category
        const catValidTTFU = catSuccessful.filter(
          (r) => r.timeToFirstUseful !== null && isFinite(r.timeToFirstUseful)
        );

        byCategory[category] = {
          precisionAtK:
            catResults.reduce((sum, r) => sum + (r.precisionAtK ?? 0), 0) / catResults.length,
          avgTTFU:
            catValidTTFU.length > 0
              ? (catValidTTFU.reduce((sum, r) => sum + (r.timeToFirstUseful ?? 0), 0) /
                  catValidTTFU.length) *
                1000
              : 0,
          count: catResults.length,
        };
      }
    }

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

    const benchmarkResult: BenchmarkResult = {
      timestamp: new Date().toISOString(),
      version: packageJson.version,
      gitSha,
      datasetVersion: goldenSet.datasetVersion,
      k: options.k,
      overall: {
        precisionAtK: overallP10,
        avgTTFU: overallTTFU,
        totalQueries: queryResults.length,
        successfulQueries: successfulResults.length,
        failedQueries: failedResults.length,
      },
      byCategory,
      queries: queryResults,
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
    console.log(
      `          TFFU = ${Math.round(overallTTFU)}ms ${compareThreshold(overallTTFU, baseline.thresholds.maxTTFU, false)}`
    );
    console.log(`Queries:  ${successfulResults.length} successful, ${failedResults.length} failed`);
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
  options: BenchmarkOptions
): Promise<QueryResult> {
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      const result = await executeQuery(server, query, defaultParams, options, false);
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
          timeToFirstUseful: null,
          retriedCount: attempt,
          error: error instanceof Error ? error.message : String(error),
          durationMs: 0,
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
  isWarmup: boolean
): Promise<QueryResult> {
  const tool = query.tool || defaultParams.tool;
  const k = query.params?.k || options.k;
  const boostProfile = query.params?.boostProfile || defaultParams.boostProfile;
  const timeoutMs = query.params?.timeoutMs || defaultParams.timeoutMs;

  const params: Record<string, unknown> = {
    limit: k,
    boost_profile: boostProfile,
  };

  if (tool === "context_bundle") {
    params.goal = query.query;
  } else if (tool === "files_search") {
    params.query = query.query;
  } else {
    throw new Error(`Unknown tool: ${tool}`);
  }

  const startTime = process.hrtime.bigint();
  const rawResult = await server.call(tool, params, timeoutMs);
  const durationMs = Number((process.hrtime.bigint() - startTime) / 1000000n);

  // Type guard for result
  const result: { context: Array<{ path: string }> } | Array<{ path: string }> =
    rawResult && typeof rawResult === "object" && "context" in rawResult
      ? (rawResult as { context: Array<{ path: string }> })
      : Array.isArray(rawResult)
        ? (rawResult as Array<{ path: string }>)
        : { context: [] };

  if (isWarmup) {
    return {
      id: query.id,
      query: query.query,
      category: query.category,
      status: "success",
      retrieved: [],
      expected: [],
      precisionAtK: null,
      timeToFirstUseful: null,
      retriedCount: 0,
      durationMs,
    };
  }

  // Extract paths
  const items = Array.isArray(result) ? result : result.context;
  const retrieved = items.map((item) => item.path);

  if (retrieved.length === 0) {
    return {
      id: query.id,
      query: query.query,
      category: query.category,
      status: "empty",
      retrieved: [],
      expected: query.expected.paths,
      precisionAtK: 0,
      timeToFirstUseful: null,
      retriedCount: 0,
      durationMs,
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

  return {
    id: query.id,
    query: query.query,
    category: query.category,
    status: "success",
    retrieved,
    expected: query.expected.paths,
    precisionAtK: metrics.precisionAtK,
    timeToFirstUseful: metrics.timeToFirstUseful,
    retriedCount: 0,
    durationMs,
  };
}

function generateMarkdown(result: BenchmarkResult, baseline: BaselineData): string {
  let md = `# KIRI Golden Set Evaluation - ${result.timestamp.split("T")[0]}\n\n`;
  md += `**Version**: ${result.version} (${result.gitSha})\n`;
  md += `**Dataset**: ${result.datasetVersion}\n`;
  md += `**K**: ${result.k}\n\n`;

  md += `## Overall Metrics\n\n`;
  md += `| Metric | Value | Threshold | Status |\n`;
  md += `|--------|-------|-----------|--------|\n`;
  md += `| P@${result.k} | ${result.overall.precisionAtK.toFixed(3)} | ≥${baseline.thresholds.minP10} | ${result.overall.precisionAtK >= baseline.thresholds.minP10 ? "✅" : "❌"} |\n`;
  md += `| Avg TFFU | ${Math.round(result.overall.avgTTFU)}ms | ≤${baseline.thresholds.maxTTFU}ms | ${result.overall.avgTTFU <= baseline.thresholds.maxTTFU ? "✅" : "❌"} |\n`;
  md += `| Total Queries | ${result.overall.totalQueries} | - | - |\n`;
  md += `| Successful | ${result.overall.successfulQueries} | - | - |\n`;
  md += `| Failed | ${result.overall.failedQueries} | - | - |\n\n`;

  md += `## By Category\n\n`;
  md += `| Category | P@${result.k} | Avg TFFU | Count |\n`;
  md += `|----------|------|----------|-------|\n`;
  for (const [category, metrics] of Object.entries(result.byCategory)) {
    md += `| ${category} | ${metrics.precisionAtK.toFixed(3)} | ${Math.round(metrics.avgTTFU)}ms | ${metrics.count} |\n`;
  }
  md += `\n`;

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

main().catch((error) => {
  console.error(`\n❌ Benchmark failed: ${error.message}`);
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
