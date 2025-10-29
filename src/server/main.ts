#!/usr/bin/env node

import { createServer, IncomingMessage, Server } from "node:http";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { IndexWatcher } from "../indexer/watch.js";
import { ensureDatabaseIndexed } from "./indexBootstrap.js";
import { writeMetricsResponse } from "./observability/metrics.js";
import { JsonRpcRequest, createRpcHandler, errorResponse, validateJsonRpcRequest } from "./rpc.js";
import { createServerRuntime, type CommonServerOptions } from "./runtime.js";
import { startStdioServer, type StdioServerOptions } from "./stdio.js";

export interface ServerOptions extends CommonServerOptions {
  port: number;
  watcher?: IndexWatcher | null;
}

async function readBody(request: IncomingMessage): Promise<string> {
  return await new Promise<string>((resolveBody, rejectBody) => {
    const chunks: Array<string> = [];
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolveBody(chunks.join(""));
    });
    request.on("error", (error) => {
      rejectBody(error);
    });
  });
}

export async function startServer(options: ServerOptions): Promise<Server> {
  const runtime = await createServerRuntime(options);
  const handleRpc = createRpcHandler(runtime);

  // Set up watcher metrics collection if watcher is provided
  let metricsInterval: NodeJS.Timeout | undefined;
  if (options.watcher) {
    const watcher = options.watcher;
    metricsInterval = setInterval(() => {
      const stats = watcher.getStatistics();
      runtime.metrics.updateWatcherMetrics({
        ...stats,
        isRunning: watcher.isRunning(),
      });
    }, 5000); // Update every 5 seconds
  }

  try {
    const server = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/metrics") {
        writeMetricsResponse(res, runtime.metrics);
        return;
      }

      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify(
            errorResponse(null, "Only POST is supported. Send a JSON-RPC request via POST.")
          )
        );
        return;
      }

      let body: string;
      try {
        body = await readBody(req);
      } catch {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify(
            errorResponse(
              null,
              "Failed to read request body. Retry the call with a smaller payload."
            )
          )
        );
        return;
      }

      let payload: JsonRpcRequest;
      try {
        payload = JSON.parse(body) as JsonRpcRequest;
      } catch {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify(
            errorResponse(null, "Invalid JSON payload. Submit a JSON-RPC 2.0 compliant request.")
          )
        );
        return;
      }

      res.setHeader("Content-Type", "application/json");
      const validationMessage = validateJsonRpcRequest(payload);
      if (validationMessage) {
        res.statusCode = 400;
        res.end(JSON.stringify(errorResponse(payload.id ?? null, validationMessage)));
        return;
      }

      const start = performance.now();
      try {
        const result = await handleRpc(payload);
        res.statusCode = result.statusCode;
        res.end(JSON.stringify(result.response));
      } finally {
        const elapsed = performance.now() - start;
        runtime.metrics.recordRequest(elapsed);
      }
    });

    await new Promise<void>((resolveListen) => {
      server.listen(options.port, () => {
        console.info(`KIRI MCP server listening on port ${options.port}`);
        resolveListen();
      });
    });

    server.on("close", () => {
      if (metricsInterval) {
        clearInterval(metricsInterval);
      }
      void runtime.close();
    });

    return server;
  } catch (error) {
    if (metricsInterval) {
      clearInterval(metricsInterval);
    }
    await runtime.close();
    throw error;
  }
}

function parseArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index >= 0) {
    return process.argv[index + 1];
  }
  return undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function parsePort(argv: string[]): number {
  const index = argv.indexOf("--port");
  if (index >= 0 && argv[index + 1]) {
    const parsed = Number(argv[index + 1]);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return 8765;
}

async function startHttpOrStdio(): Promise<void> {
  const repoRoot = parseArg("--repo") ?? ".";
  const databasePath = parseArg("--db") ?? "var/index.duckdb";
  const securityConfigPath = parseArg("--security-config");
  const securityLockPath = parseArg("--security-lock");
  const allowDegrade = hasFlag("--allow-degrade");
  const forceReindex = hasFlag("--reindex");
  const watch = hasFlag("--watch");
  const debounceMs = parseInt(parseArg("--debounce") ?? "500", 10);

  // Ensure database is indexed before starting server
  await ensureDatabaseIndexed(repoRoot, databasePath, allowDegrade, forceReindex);

  // Start watch mode in parallel with server if requested
  let watcher: IndexWatcher | null = null;

  if (watch) {
    const abortController = new AbortController();
    watcher = new IndexWatcher({
      repoRoot,
      databasePath,
      debounceMs,
      signal: abortController.signal,
    });

    // Handle graceful shutdown
    const shutdownHandler = () => {
      process.stderr.write("\n🛑 Received shutdown signal. Stopping watch mode...\n");
      abortController.abort();
    };
    process.on("SIGINT", shutdownHandler);
    process.on("SIGTERM", shutdownHandler);

    await watcher.start();
  }

  if (hasFlag("--port")) {
    const port = parsePort(process.argv);
    const options: ServerOptions = {
      port,
      repoRoot,
      databasePath,
      allowDegrade,
      watcher: watcher,
    };
    if (securityConfigPath) {
      options.securityConfigPath = securityConfigPath;
    }
    if (securityLockPath) {
      options.securityLockPath = securityLockPath;
    }

    await startServer(options);
    return;
  }

  const stdioOptions: StdioServerOptions = {
    repoRoot,
    databasePath,
    allowDegrade,
  };
  if (securityConfigPath) {
    stdioOptions.securityConfigPath = securityConfigPath;
  }
  if (securityLockPath) {
    stdioOptions.securityLockPath = securityLockPath;
  }

  // For stdio mode, we'll update watcher metrics via a simpler mechanism
  // since there's no /metrics endpoint
  await startStdioServer(stdioOptions);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startHttpOrStdio().catch((error) => {
    console.error("Failed to start MCP server. Check DuckDB path and repo index before retrying.");
    console.error(error);
    process.exitCode = 1;
  });
}
