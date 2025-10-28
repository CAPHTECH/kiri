import process from "node:process";

export interface ServerOptions {
  port: number;
}

export function startServer(options: ServerOptions): void {
  const { port } = options;
  // TODO: implement MCP server bootstrap
  console.info(`[stub] KIRI MCP server listening on port ${port}`);
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

if (process.argv[1] && process.argv[1].endsWith("main.ts")) {
  const port = parsePort(process.argv);
  startServer({ port });
}
