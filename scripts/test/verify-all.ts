#!/usr/bin/env tsx
/* global fetch */
/**
 * KIRI Comprehensive Test & Verification Script
 *
 * This script performs comprehensive testing including:
 * - Unit tests (all categories)
 * - Integration tests
 * - MCP tools actual operation tests
 * - Watch mode functionality tests
 * - End-to-end workflow verification
 */

import { spawn, execSync } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { IndexWatcher } from "../../src/indexer/watch.js";
import { DuckDBClient } from "../../src/shared/duckdb.js";

interface TestResult {
  category: string;
  passed: boolean;
  duration: number;
  error?: string;
  details?: string;
}

type VerificationCategory = "unit" | "integration" | "dart" | "eval" | "tools" | "watch" | "all";

interface VerificationOptions {
  category: VerificationCategory;
  retry: number;
  skipCoverage: boolean;
  verbose: boolean;
}

const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

function buildVitestArgs(suites: string[], enableCoverage: boolean): string[] {
  const args = [
    "exec",
    "vitest",
    "run",
    enableCoverage ? "--coverage" : "--no-coverage",
    "--pool=forks",
    "--poolOptions.forks.singleFork",
    "--poolOptions.forks.maxForks=1",
    "--poolOptions.forks.minForks=1",
  ];

  if (suites.length > 0) {
    args.push(...suites);
  }

  return args;
}

function log(message: string, color?: keyof typeof COLORS): void {
  const colorCode = color ? COLORS[color] : "";
  console.log(`${colorCode}${message}${COLORS.reset}`);
}

function runCommand(
  command: string,
  args: string[],
  options?: { timeout?: number; cwd?: string }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd: options?.cwd || process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    const timeoutId = options?.timeout
      ? setTimeout(() => {
          proc.kill("SIGTERM");
        }, options.timeout)
      : null;

    proc.on("close", (code) => {
      if (timeoutId) clearTimeout(timeoutId);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

async function runUnitTests(options: VerificationOptions): Promise<TestResult> {
  log("\n📦 Running Unit Tests...", "cyan");
  const start = Date.now();

  const args = buildVitestArgs(
    ["tests/indexer", "tests/server", "tests/shared", "tests/client", "tests/daemon"],
    !options.skipCoverage
  );

  try {
    const result = await runCommand("pnpm", args, {
      timeout: options.skipCoverage ? 150000 : 210000,
    });
    const duration = Date.now() - start;

    if (result.exitCode === 0) {
      log("✓ Unit tests passed", "green");
      return { category: "unit", passed: true, duration };
    } else {
      return {
        category: "unit",
        passed: false,
        duration,
        error: "Unit tests failed",
        details: result.stderr,
      };
    }
  } catch (error) {
    return {
      category: "unit",
      passed: false,
      duration: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runDartTests(_options: VerificationOptions): Promise<TestResult> {
  log("\n🎯 Running Dart Analysis Server Tests...", "cyan");
  const start = Date.now();

  const args = buildVitestArgs(["tests/indexer/dart"], false);

  try {
    const result = await runCommand("pnpm", args, { timeout: 60000 });
    const duration = Date.now() - start;

    if (result.exitCode === 0) {
      log("✓ Dart tests passed", "green");
      return { category: "dart", passed: true, duration };
    } else {
      return {
        category: "dart",
        passed: false,
        duration,
        error: "Dart tests failed",
        details: result.stderr,
      };
    }
  } catch (error) {
    return {
      category: "dart",
      passed: false,
      duration: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runIntegrationTests(_options: VerificationOptions): Promise<TestResult> {
  log("\n🔗 Running Integration Tests...", "cyan");
  const start = Date.now();

  const args = buildVitestArgs(["tests/integration"], false);

  try {
    const result = await runCommand("pnpm", args, { timeout: 120000 });
    const duration = Date.now() - start;

    if (result.exitCode === 0) {
      log("✓ Integration tests passed", "green");
      return { category: "integration", passed: true, duration };
    } else {
      return {
        category: "integration",
        passed: false,
        duration,
        error: "Integration tests failed",
        details: result.stderr,
      };
    }
  } catch (error) {
    return {
      category: "integration",
      passed: false,
      duration: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runMCPToolsTests(_options: VerificationOptions): Promise<TestResult> {
  log("\n🛠️  Running MCP Tools Actual Operation Tests...", "cyan");
  const start = Date.now();

  const testDbPath = join(process.cwd(), "var", "test-tools-verify.duckdb");
  const testRepoPath = join(process.cwd(), "var", "test-tools-repo");

  try {
    // Cleanup previous artifacts
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    if (existsSync(testRepoPath)) {
      rmSync(testRepoPath, { recursive: true, force: true });
    }

    mkdirSync(testRepoPath, { recursive: true });
    execSync("git init", { cwd: testRepoPath });
    execSync('git config user.email "test@example.com"', { cwd: testRepoPath });
    execSync('git config user.name "Test User"', { cwd: testRepoPath });
    mkdirSync(join(testRepoPath, "src"), { recursive: true });
    writeFileSync(
      join(testRepoPath, "src", "index.ts"),
      ["export function hello(name: string) {", "  return `hello ${name}`;", "}", ""].join("\n")
    );
    writeFileSync(
      join(testRepoPath, "README.md"),
      "# Sample Repo\n\nUsed for MCP verification tests.\n"
    );
    execSync("git add .", { cwd: testRepoPath });
    execSync('git commit -m "Initial commit"', { cwd: testRepoPath });

    // Step 1: Index a test repository
    log("  → Indexing test repository...", "blue");
    const indexResult = await runCommand(
      "tsx",
      ["src/indexer/cli.ts", "--repo", testRepoPath, "--db", testDbPath, "--full"],
      { timeout: 30000 }
    );

    if (indexResult.exitCode !== 0) {
      throw new Error(`Indexing failed: ${indexResult.stderr}`);
    }

    // Step 2: Start MCP server
    log("  → Starting MCP server...", "blue");
    const serverProc = spawn(
      "tsx",
      ["src/server/main.ts", "--port", "9999", "--db", testDbPath, "--repo", testRepoPath],
      {
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let serverLogs = "";
    serverProc.stdout?.on("data", (data) => {
      serverLogs += data.toString();
    });
    serverProc.stderr?.on("data", (data) => {
      serverLogs += data.toString();
    });

    // Wait for server to be ready
    await new Promise((resolve) => setTimeout(resolve, 3000));

    try {
      // Step 3: Test each MCP tool
      const tools = [
        { name: "files_search", method: "files_search", params: { query: "hello" } },
        { name: "context_bundle", method: "context_bundle", params: { goal: "hello" } },
        { name: "snippets_get", method: "snippets_get", params: { path: "src/index.ts" } },
        {
          name: "deps_closure",
          method: "deps_closure",
          params: { path: "src/index.ts", direction: "outbound" },
        },
      ];

      async function requestWithRetry(payload: unknown, attempts = 5): Promise<unknown> {
        let lastError: unknown;
        for (let i = 0; i < attempts; i++) {
          try {
            const response = await fetch("http://localhost:9999", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
            return await response.json();
          } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
        throw lastError ?? new Error("fetch failed");
      }

      for (const tool of tools) {
        log(`  → Testing ${tool.name}...`, "blue");
        const result = (await requestWithRetry({
          jsonrpc: "2.0",
          id: 1,
          method: tool.method,
          params: tool.params,
        })) as { error?: { message: string } };

        if (result?.error) {
          throw new Error(
            `${tool.name} failed: ${result.error.message}\nServer logs:\n${serverLogs}`
          );
        }

        log(`    ✓ ${tool.name} returned valid response`, "green");
      }

      serverProc.kill();
      await new Promise((resolve) => setTimeout(resolve, 1000));

      log("✓ MCP tools tests passed", "green");
      return { category: "tools", passed: true, duration: Date.now() - start };
    } catch (error) {
      serverProc.kill();
      throw error;
    }
  } catch (error) {
    return {
      category: "tools",
      passed: false,
      duration: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // Cleanup
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    if (existsSync(testRepoPath)) {
      rmSync(testRepoPath, { recursive: true, force: true });
    }
  }
}

async function runWatchModeTests(_options: VerificationOptions): Promise<TestResult> {
  log("\n👀 Running Watch Mode Tests...", "cyan");
  const start = Date.now();

  const testDbPath = join(process.cwd(), "var", "test-watch-verify.duckdb");
  const testRepoPath = join(process.cwd(), "var", "test-watch-repo");

  try {
    // Setup test repository
    if (existsSync(testRepoPath)) {
      rmSync(testRepoPath, { recursive: true, force: true });
    }
    mkdirSync(testRepoPath, { recursive: true });

    // Initialize git repo
    execSync("git init", { cwd: testRepoPath });
    execSync('git config user.email "test@example.com"', { cwd: testRepoPath });
    execSync('git config user.name "Test User"', { cwd: testRepoPath });

    // Create initial file
    const initialFile = join(testRepoPath, "index.ts");
    writeFileSync(initialFile, "export const initial = 'test';");
    execSync("git add .", { cwd: testRepoPath });
    execSync('git commit -m "Initial commit"', { cwd: testRepoPath });

    // Cleanup previous test database
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }

    // Step 1: Initial indexing
    log("  → Initial indexing...", "blue");
    const indexResult = await runCommand(
      "tsx",
      ["src/indexer/cli.ts", "--repo", testRepoPath, "--db", testDbPath, "--full"],
      { timeout: 30000 }
    );

    if (indexResult.exitCode !== 0) {
      throw new Error(`Initial indexing failed: ${indexResult.stderr}`);
    }

    // Step 2: Start IndexWatcher directly for deterministic verification
    log("  → Starting IndexWatcher...", "blue");
    const watcher = new IndexWatcher({
      repoRoot: testRepoPath,
      databasePath: testDbPath,
      debounceMs: 200,
    });

    await watcher.start();

    try {
      // Step 3: Modify file and verify re-indexing
      log("  → Modifying file to trigger re-index...", "blue");
      const modifiedContent = "export const modified = 'updated';";
      writeFileSync(initialFile, modifiedContent);

      // Wait for watcher debounce and incremental indexing
      await new Promise((resolve) => setTimeout(resolve, 5000));

      log("  → Verifying re-indexing...", "blue");
      const db = await DuckDBClient.connect({ databasePath: testDbPath });
      const rows = await db.all<{ content: string }>(
        "SELECT content FROM blob WHERE content LIKE '%modified%'"
      );
      await db.close();

      if (rows.length === 0) {
        throw new Error("Watch mode did not re-index changed file");
      }

      log("✓ Watch mode tests passed", "green");
      return { category: "watch", passed: true, duration: Date.now() - start };
    } finally {
      await watcher.stop().catch(() => {
        /* ignore */
      });
    }
  } catch (error) {
    return {
      category: "watch",
      passed: false,
      duration: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // Cleanup
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    if (existsSync(testRepoPath)) {
      rmSync(testRepoPath, { recursive: true, force: true });
    }
  }
}

async function runEvalTests(_options: VerificationOptions): Promise<TestResult> {
  log("\n📊 Running Evaluation Tests...", "cyan");
  const start = Date.now();

  const args = buildVitestArgs(["tests/eval"], false);

  try {
    const result = await runCommand("pnpm", args, { timeout: 60000 });
    const duration = Date.now() - start;

    if (result.exitCode === 0) {
      log("✓ Evaluation tests passed", "green");
      return { category: "eval", passed: true, duration };
    } else {
      return {
        category: "eval",
        passed: false,
        duration,
        error: "Evaluation tests failed",
        details: result.stderr,
      };
    }
  } catch (error) {
    return {
      category: "eval",
      passed: false,
      duration: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function printSummary(results: TestResult[]): void {
  log("\n" + "=".repeat(60), "cyan");
  log("📋 Test Summary", "cyan");
  log("=".repeat(60), "cyan");

  let totalPassed = 0;
  let totalFailed = 0;
  let totalDuration = 0;

  for (const result of results) {
    const status = result.passed ? "✓ PASS" : "✗ FAIL";
    const color = result.passed ? "green" : "red";
    const duration = (result.duration / 1000).toFixed(2);

    log(`${status} ${result.category.padEnd(15)} (${duration}s)`, color);

    if (result.passed) {
      totalPassed++;
    } else {
      totalFailed++;
      if (result.error) {
        log(`  Error: ${result.error}`, "red");
      }
      if (result.details && result.details.length < 500) {
        log(`  Details: ${result.details}`, "yellow");
      }
    }

    totalDuration += result.duration;
  }

  log("=".repeat(60), "cyan");
  log(`Total: ${totalPassed} passed, ${totalFailed} failed`, totalFailed === 0 ? "green" : "red");
  log(`Duration: ${(totalDuration / 1000).toFixed(2)}s`, "cyan");
  log("=".repeat(60), "cyan");

  if (totalFailed > 0) {
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options: VerificationOptions = {
    category: "all",
    retry: 0,
    skipCoverage: false,
    verbose: false,
  };

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--category") {
      const categoryArg = args[i + 1];
      if (typeof categoryArg === "string") {
        options.category = categoryArg as VerificationCategory;
        i++;
      }
    } else if (arg === "--retry") {
      const retryArg = args[i + 1];
      if (typeof retryArg === "string") {
        options.retry = parseInt(retryArg, 10);
        i++;
      }
    } else if (arg === "--skip-coverage") {
      options.skipCoverage = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    }
  }

  log("\n🚀 KIRI Comprehensive Verification", "cyan");
  log(`Category: ${options.category}`, "blue");
  log(`Retry: ${options.retry}`, "blue");
  log(`Coverage: ${options.skipCoverage ? "disabled" : "enabled"}`, "blue");

  const results: TestResult[] = [];

  if (options.category === "all" || options.category === "unit") {
    results.push(await runUnitTests(options));
  }

  if (options.category === "all" || options.category === "dart") {
    results.push(await runDartTests(options));
  }

  if (options.category === "all" || options.category === "integration") {
    results.push(await runIntegrationTests(options));
  }

  if (options.category === "all" || options.category === "tools") {
    results.push(await runMCPToolsTests(options));
  }

  if (options.category === "all" || options.category === "watch") {
    results.push(await runWatchModeTests(options));
  }

  if (options.category === "all" || options.category === "eval") {
    results.push(await runEvalTests(options));
  }

  printSummary(results);
}

main().catch((error) => {
  log(`\n❌ Verification failed: ${error.message}`, "red");
  process.exit(1);
});
