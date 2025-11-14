import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type {
  SearchAdapter,
  SearchAdapterContext,
  Metrics,
  Query,
  Dataset,
} from "../../external/assay-kit/src/index.ts";
import { precisionAtK, recallAtK } from "../../external/assay-kit/src/index.ts";

export interface KiriAdapterConfig {
  limit?: number;
  compact?: boolean;
  boostProfile?: string;
}

export class KiriSearchAdapter implements SearchAdapter<Query, Metrics> {
  private serverProcess: ChildProcess | null = null;
  private readonly port: number;
  private serverLogs = "";
  private readonly config: Required<KiriAdapterConfig>;

  constructor(
    private readonly databasePath: string,
    private readonly repoRoot: string,
    private readonly kiriServerCommand: string = "node_modules/.bin/tsx",
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

  async warmup(dataset: Dataset<Query>): Promise<void> {
    console.log(`🚀 Starting KIRI server on port ${this.port}...`);

    const cliPath = join(this.repoRoot, "node_modules/tsx/dist/cli.mjs");
    const args = [
      cliPath,
      "src/server/main.ts",
      "--port",
      String(this.port),
      "--db",
      this.databasePath,
      "--repo",
      this.repoRoot,
    ];

    this.serverProcess = spawn(process.execPath, args, {
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

  async execute(query: Query, ctx: SearchAdapterContext): Promise<Metrics> {
    const startTime = Date.now();

    if (ctx.signal.aborted) {
      throw new Error(`Query ${query.id} was cancelled`);
    }

    try {
      const kiriParams: Record<string, unknown> = {
        goal: query.text,
        limit: this.config.limit,
        compact: this.config.compact,
      };

      if (this.config.boostProfile && this.config.boostProfile !== "default") {
        kiriParams.boost_profile = this.config.boostProfile;
      }

      const result = await this.callKiri(
        "context_bundle",
        kiriParams,
        ctx.options.timeoutMs ?? 30000,
        ctx.signal
      );

      const latencyMs = Date.now() - startTime;
      const context = this.extractContext(result);
      const retrievedPaths = context.map((item) => item.path);
      const k = this.config.limit;
      const expectedPaths = this.getExpectedPaths(query);

      const precision = precisionAtK(retrievedPaths, expectedPaths, k);
      const recall = recallAtK(retrievedPaths, expectedPaths, k);

      return {
        latencyMs,
        precision,
        recall,
        extras: {
          resultCount: retrievedPaths.length,
          serverPort: this.port,
          k,
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

    if (this.serverProcess) {
      this.serverProcess.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      this.serverProcess = null;
    }

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

  private async callKiri(
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

  private getExpectedPaths(query: Query): string[] {
    const expected = query.metadata?.expected;
    if (Array.isArray(expected)) {
      return expected as string[];
    }
    return [];
  }
}
