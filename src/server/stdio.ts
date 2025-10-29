import { performance } from "node:perf_hooks";
import { stdin, stdout, stderr } from "node:process";
import { createInterface } from "node:readline";

import { JsonRpcRequest, createRpcHandler, errorResponse, validateJsonRpcRequest } from "./rpc.js";
import { createServerRuntime, type CommonServerOptions } from "./runtime.js";

export type StdioServerOptions = CommonServerOptions;

export async function startStdioServer(options: StdioServerOptions): Promise<void> {
  const runtime = await createServerRuntime(options);
  const handleRpc = createRpcHandler(runtime);
  const rl = createInterface({ input: stdin, crlfDelay: Infinity });

  const closeRuntime = async (): Promise<void> => {
    await runtime.close();
  };

  stderr.write("KIRI MCP stdio server ready\n");

  await new Promise<void>((resolve) => {
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      void (async () => {
        let payload: JsonRpcRequest;
        try {
          payload = JSON.parse(line) as JsonRpcRequest;
        } catch {
          const response = errorResponse(
            null,
            "Invalid JSON payload. Submit a JSON-RPC 2.0 compliant request."
          );
          stdout.write(JSON.stringify(response) + "\n");
          return;
        }

        const validationMessage = validateJsonRpcRequest(payload);
        if (validationMessage) {
          const response = errorResponse(payload.id ?? null, validationMessage);
          stdout.write(JSON.stringify(response) + "\n");
          return;
        }

        const start = performance.now();
        try {
          const result = await handleRpc(payload);
          stdout.write(JSON.stringify(result.response) + "\n");
        } catch (error) {
          stderr.write(`Unhandled stdio RPC error: ${String(error)}\n`);
          const response = errorResponse(
            payload.id ?? null,
            "Unexpected server error. Inspect server logs and retry the request."
          );
          stdout.write(JSON.stringify(response) + "\n");
        } finally {
          const elapsed = performance.now() - start;
          runtime.metrics.recordRequest(elapsed);
        }
      })().catch((error) => {
        stderr.write(`Failed to process RPC line: ${String(error)}\n`);
      });
    });

    rl.once("close", async () => {
      await closeRuntime();
      resolve();
    });

    stdin.once("end", () => {
      rl.close();
    });

    stdin.once("close", () => {
      rl.close();
    });

    stdin.once("error", (error) => {
      stderr.write(`STDIN error: ${error instanceof Error ? error.message : String(error)}\n`);
      rl.close();
    });
  });
}
