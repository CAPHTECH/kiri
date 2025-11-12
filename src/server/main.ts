#!/usr/bin/env node

import { createServer, IncomingMessage, Server } from "node:http";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { pathToFileURL } from "node:url";

import packageJson from "../../package.json" with { type: "json" };
import { IndexWatcher } from "../indexer/watch.js";
import { defineCli, type CliSpec } from "../shared/cli/args.js";
import { parsePositiveInt } from "../shared/utils/validation.js";

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
            errorResponse(0, "Only POST is supported. Send a JSON-RPC request via POST.")
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
              0,
              "Failed to read request body. Retry the call with a smaller payload.",
              -32000
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
            errorResponse(
              0,
              "Invalid JSON payload. Submit a JSON-RPC 2.0 compliant request.",
              -32700
            )
          )
        );
        return;
      }

      res.setHeader("Content-Type", "application/json");
      const validationMessage = validateJsonRpcRequest(payload);
      const hasResponseId = typeof payload.id === "string" || typeof payload.id === "number";
      if (validationMessage) {
        if (hasResponseId) {
          res.statusCode = 400;
          res.end(JSON.stringify(errorResponse(payload.id as string | number, validationMessage)));
        } else {
          res.statusCode = 204;
          res.end();
        }
        return;
      }

      const start = performance.now();
      try {
        const result = await handleRpc(payload);
        if (result) {
          res.statusCode = result.statusCode;
          res.end(JSON.stringify(result.response));
        } else {
          res.statusCode = 204;
          res.end();
        }
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

/**
 * CLI specification for kiri-server
 */
const SERVER_CLI_SPEC: CliSpec = {
  commandName: "kiri-server",
  description: "KIRI MCP Server - Serves MCP tools via HTTP or stdio",
  version: packageJson.version,
  usage: "kiri-server [options]",
  sections: [
    {
      title: "Repository / Database",
      options: [
        {
          flag: "repo",
          type: "string",
          description: "Repository root path",
          placeholder: "<path>",
          default: ".",
        },
        {
          flag: "db",
          type: "string",
          description: "Database file path",
          placeholder: "<path>",
          default: "var/index.duckdb",
        },
      ],
    },
    {
      title: "Server Mode",
      options: [
        {
          flag: "port",
          type: "string",
          description: "HTTP server port (default: 8765; omit for stdio mode)",
          placeholder: "<port>",
        },
      ],
    },
    {
      title: "Indexing",
      options: [
        {
          flag: "reindex",
          type: "boolean",
          description: "Force full re-indexing on startup",
          default: false,
        },
        {
          flag: "allow-degrade",
          type: "boolean",
          description: "Allow degraded mode without VSS/FTS extensions",
          default: false,
        },
      ],
    },
    {
      title: "Watch Mode",
      options: [
        {
          flag: "watch",
          type: "boolean",
          description: "Enable watch mode for automatic re-indexing",
          default: false,
        },
        {
          flag: "debounce",
          type: "string",
          description: "Debounce delay in milliseconds for watch mode",
          placeholder: "<ms>",
          default: "500",
        },
      ],
    },
    {
      title: "Security",
      options: [
        {
          flag: "security-config",
          type: "string",
          description: "Security configuration file path",
          placeholder: "<path>",
        },
        {
          flag: "security-lock",
          type: "string",
          description: "Security lock file path",
          placeholder: "<path>",
        },
      ],
    },
  ],
  examples: [
    "kiri-server --port 8765 --repo /path/to/repo",
    "kiri-server --watch --debounce 1000",
    "kiri-server --reindex --allow-degrade",
  ],
};

async function startHttpOrStdio(): Promise<void> {
  const { values } = defineCli(SERVER_CLI_SPEC);

  const repoRoot = (values.repo as string | undefined) ?? ".";
  const databasePath = (values.db as string | undefined) ?? "var/index.duckdb";
  const securityConfigPath = values["security-config"] as string | undefined;
  const securityLockPath = values["security-lock"] as string | undefined;
  const allowDegrade = (values["allow-degrade"] as boolean) || false;
  const forceReindex = (values.reindex as boolean) || false;
  const watch = (values.watch as boolean) || false;
  const debounceMs = parsePositiveInt(values.debounce as string | undefined, 500, "debounce delay");
  const port = parsePositiveInt(values.port as string | undefined, 8765, "port number");

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

  if (values.port) {
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
