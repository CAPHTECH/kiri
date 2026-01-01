/* global fetch */

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { join, isAbsolute } from "node:path";

import type {
  SearchAdapter,
  SearchAdapterContext,
  Metrics,
  Query,
  Dataset,
} from "../../external/assay-kit/packages/assay-kit/src/index.ts";
import {
  evaluateRetrieval,
  type RetrievalMetrics,
} from "../../external/assay-kit/packages/assay-kit/src/index.ts";

const MAX_QUERY_HINTS = 8;
const TIMESTAMP_INTERVAL_MS = 10; // Interval between simulated result timestamps for metrics calculation

export interface KiriAdapterConfig {
  limit?: number;
  compact?: boolean;
  boostProfile?: string;
}

interface ExpectedItem {
  path: string;
  relevance: number;
}

interface KiriQueryMetadata extends Record<string, unknown> {
  hints?: string[];
  expected?: (string | ExpectedItem)[]; // Support both old and new formats
}

type KiriQuery = Query<Record<string, unknown>, KiriQueryMetadata>;

interface ContextBundleArtifactsPayload {
  hints: string[];
}

function normalizeQueryHints(hints?: unknown): string[] {
  if (!Array.isArray(hints)) {
    return [];
  }

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const hint of hints) {
    if (typeof hint !== "string") {
      continue;
    }
    const trimmed = hint.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    normalized.push(trimmed);
    seen.add(trimmed);
    if (normalized.length >= MAX_QUERY_HINTS) {
      break;
    }
  }

  return normalized;
}

/**
 * Prepares artifacts for the KIRI context_bundle API call.
 *
 * **Important**: hints are passed as "artifacts" to the MCP context_bundle tool.
 * The KIRI server prioritizes files/keywords in artifacts.hints when ranking results.
 * This can significantly boost certain files in search results.
 *
 * **Best Practice**: Ensure hints align with expected results to avoid misleading rankings.
 * Misaligned hints can cause NDCG to drop significantly (e.g., 0.871 → 0.098, -89%).
 *
 * See docs/testing.md#データセット設計のベストプラクティス for details.
 *
 * @param metadata - Query metadata containing hints array
 * @returns Artifacts object with hints array (max 8 items), or undefined if no hints
 */
function buildArtifactsFromMetadata(
  metadata?: KiriQueryMetadata
): ContextBundleArtifactsPayload | undefined {
  const hints = normalizeQueryHints(metadata?.hints);
  if (hints.length === 0) {
    return undefined;
  }
  return { hints };
}

export class KiriSearchAdapter implements SearchAdapter<KiriQuery, Metrics> {
  private serverProcess: ChildProcess | null = null;
  private readonly port: number;
  private serverLogs = "";
  private readonly config: Required<KiriAdapterConfig>;
  private cleanupHandlers: Array<[NodeJS.Signals | "exit", () => void]> = [];

  constructor(
    private readonly databasePath: string,
    private readonly repoRoot: string,
    private readonly kiriServerCommand?: string,
    port: number = 19999,
    config: KiriAdapterConfig = {}
  ) {
    this.port = port;
    this.config = {
      limit: config.limit ?? 10,
      compact: config.compact ?? true,
      boostProfile: config.boostProfile ?? "default",
    };
  }

  async warmup(dataset: Dataset<KiriQuery>): Promise<void> {
    console.log(`🚀 Starting KIRI server on port ${this.port}...`);

    this.registerCleanupHandlers();
    const { command, args: launcherArgs } = this.buildServerLauncher();
    const args = [
      ...launcherArgs,
      "src/server/main.ts",
      "--port",
      String(this.port),
      "--db",
      this.databasePath,
      "--repo",
      this.repoRoot,
    ];

    this.serverProcess = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: this.repoRoot,
      env: process.env,
    });

    this.serverProcess.stdout?.on("data", (data) => {
      this.serverLogs += data.toString();
    });

    this.serverProcess.stderr?.on("data", (data) => {
      this.serverLogs += data.toString();
    });

    this.serverProcess.on("error", (error) => {
      console.error("KIRI server process error:", error);
    });

    try {
      await this.waitForReady();
      console.log("✅ KIRI server ready");

      console.log(`🔥 Running warmup queries (${Math.min(3, dataset.queries.length)} queries)...`);
      for (const query of dataset.queries.slice(0, 3)) {
        try {
          await this.callKiri("context_bundle", { goal: query.text, limit: 5 }, 10000);
        } catch (error) {
          console.warn(`Warmup query failed: ${error}`);
        }
      }
      console.log("✅ Warmup completed");
    } catch (error) {
      await this.stop("warmup-failed");
      throw error;
    }
  }

  async execute(query: KiriQuery, ctx: SearchAdapterContext): Promise<Metrics> {
    const startTime = Date.now();

    if (ctx.signal.aborted) {
      throw new Error(`Query ${query.id} was cancelled`);
    }

    try {
      const requestedK = ctx.options.k;
      const k =
        typeof requestedK === "number" && Number.isFinite(requestedK) && requestedK > 0
          ? Math.floor(requestedK)
          : this.config.limit;

      const kiriParams: Record<string, unknown> = {
        goal: query.text,
        limit: k,
        compact: this.config.compact,
      };

      if (this.config.boostProfile && this.config.boostProfile !== "default") {
        kiriParams.boost_profile = this.config.boostProfile;
      }

      const artifacts = buildArtifactsFromMetadata(query.metadata);
      if (artifacts) {
        kiriParams.artifacts = artifacts;
      }

      const result = await this.callKiri(
        "context_bundle",
        kiriParams,
        ctx.options.timeoutMs ?? 30000,
        ctx.signal
      );

      const responseTimeMs = Date.now();
      const latencyMs = responseTimeMs - startTime;
      const context = this.extractContext(result);
      const retrievedPaths = context.map((item) => item.path);
      const expectedPaths = this.getExpectedPaths(query);

      // Build relevance grades map for NDCG calculation
      const { relevanceGrades, relevantPaths } = this.buildRelevanceGrades(query);

      // Use evaluateRetrieval() to calculate comprehensive metrics including MRR and NDCG
      const evaluateOptions: {
        items: Array<{ id: string; timestampMs: number }>;
        relevant: string[];
        k: number;
        startTimestampMs: number;
        relevanceGrades?: Map<string, number>;
      } = {
        items: retrievedPaths.map((path, i) => ({
          id: path,
          // Retrieval results arrive after the server response, not at query start.
          timestampMs: responseTimeMs + i * TIMESTAMP_INTERVAL_MS,
        })),
        relevant: relevanceGrades.size > 0 ? relevantPaths : expectedPaths,
        k,
        startTimestampMs: startTime,
      };

      if (relevanceGrades.size > 0) {
        evaluateOptions.relevanceGrades = relevanceGrades;
      }

      const retrievalMetrics: RetrievalMetrics = evaluateRetrieval(evaluateOptions);

      return {
        latencyMs,
        precision: retrievalMetrics.precisionAtK,
        recall: retrievalMetrics.recallAtK,
        extras: {
          resultCount: retrievedPaths.length,
          serverPort: this.port,
          k,
          // Include additional IR metrics
          mrr: retrievalMetrics.mrr,
          map: retrievalMetrics.map,
          hitsAtK: retrievalMetrics.hitsAtK,
          f1: retrievalMetrics.f1,
          tffu: retrievalMetrics.timeToFirstUseful,
          ndcg: retrievalMetrics.ndcg ?? 0, // Add NDCG (default to 0 if undefined)
        },
      };
    } catch (error) {
      throw new Error(
        `KIRI query failed for ${query.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async stop(reason?: string): Promise<void> {
    console.log(`🛑 Stopping KIRI server${reason ? `: ${reason}` : ""}...`);

    const proc = this.serverProcess;
    if (!proc) {
      console.log("✅ KIRI server stopped");
      return;
    }

    this.serverProcess = null;
    proc.kill("SIGTERM");

    try {
      await Promise.race([
        once(proc, "exit"),
        new Promise((resolve, reject) =>
          setTimeout(() => reject(new Error("server-stop-timeout")), 5000)
        ),
      ]);
    } catch {
      proc.kill("SIGKILL");
      try {
        await once(proc, "exit");
      } catch {
        // ignore
      }
    } finally {
      proc.removeAllListeners();
    }

    this.removeCleanupHandlers();
    console.log("✅ KIRI server stopped");
  }

  private async waitForReady(): Promise<void> {
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
          return;
        }
      } catch {
        // Not ready yet
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    throw new Error(
      `KIRI server failed to start within ${maxAttempts} seconds.\nServer logs:\n${this.serverLogs}`
    );
  }

  private buildServerLauncher(): { command: string; args: string[] } {
    if (this.kiriServerCommand) {
      const command = this.resolveLauncherCommand(this.kiriServerCommand);
      return { command, args: [] };
    }
    const cliPath = join(this.repoRoot, "node_modules/tsx/dist/cli.mjs");
    return { command: process.execPath, args: [cliPath] };
  }

  private resolveLauncherCommand(command: string): string {
    if (command.includes("/") || command.includes("\\")) {
      if (isAbsolute(command)) {
        return command;
      }
      return join(this.repoRoot, command);
    }
    return command;
  }

  private registerCleanupHandlers(): void {
    if (this.cleanupHandlers.length > 0) {
      return;
    }
    const events: Array<NodeJS.Signals | "exit"> = ["SIGINT", "SIGTERM", "SIGQUIT", "exit"];
    for (const event of events) {
      const handler = () => {
        void this.stop("process-exit");
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

  protected async callKiri(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    parentSignal?: AbortSignal
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    if (parentSignal?.aborted) {
      controller.abort();
    }
    parentSignal?.addEventListener("abort", () => controller.abort(), { once: true });

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

  private extractContext(result: unknown): Array<{ path: string }> {
    if (!result || typeof result !== "object") {
      return [];
    }

    if ("context" in result && Array.isArray((result as { context?: unknown }).context)) {
      return (result as { context: Array<{ path: string }> }).context;
    }

    if (Array.isArray(result)) {
      return result as Array<{ path: string }>;
    }

    return [];
  }

  /**
   * Builds relevance grades map from query metadata for NDCG calculation.
   *
   * Supports both old format (string array) and new format (object array with relevance).
   * Validates types and relevance ranges (0-3).
   *
   * @param query - Query with metadata.expected
   * @returns Object containing relevanceGrades map and relevantPaths array
   */
  private buildRelevanceGrades(query: KiriQuery): {
    relevanceGrades: Map<string, number>;
    relevantPaths: string[];
  } {
    const relevanceGrades = new Map<string, number>();
    const relevantPaths: string[] = [];

    const expected = query.metadata?.expected;
    if (!Array.isArray(expected)) {
      return { relevanceGrades, relevantPaths };
    }

    for (const item of expected) {
      if (typeof item === "object" && "path" in item && "relevance" in item) {
        const path = item.path;
        const relevance = item.relevance;

        // Validate types
        if (typeof path !== "string" || typeof relevance !== "number") {
          console.warn(
            `Invalid expected item in query ${query.id}: path=${path}, relevance=${relevance}`
          );
          continue;
        }

        // Validate relevance range (0-3)
        if (relevance < 0 || relevance > 3) {
          console.warn(`Relevance out of range (0-3) in query ${query.id}: ${relevance}`);
          continue;
        }

        relevanceGrades.set(path, relevance);
        if (relevance > 0) {
          relevantPaths.push(path);
        }
      } else if (typeof item === "string") {
        // Backward compatibility: string items are treated as relevance=1
        relevanceGrades.set(item, 1);
        relevantPaths.push(item);
      }
    }

    return { relevanceGrades, relevantPaths };
  }

  private getExpectedPaths(query: KiriQuery): string[] {
    const expected = query.metadata?.expected;
    if (!Array.isArray(expected)) {
      return [];
    }

    const paths: string[] = [];
    for (const item of expected) {
      if (typeof item === "string") {
        paths.push(item);
      } else if (typeof item === "object" && "path" in item) {
        paths.push(item.path as string);
      }
    }
    return paths;
  }
}
