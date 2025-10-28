import { resolve } from "node:path";

interface IndexerOptions {
  repoRoot: string;
  databasePath: string;
  full: boolean;
  since?: string;
}

export async function runIndexer(options: IndexerOptions): Promise<void> {
  // TODO: wire up DuckDB ingestion pipeline
  console.info(
    `[stub] indexer invoked repoRoot=${options.repoRoot} db=${options.databasePath} full=${options.full} since=${options.since ?? "HEAD"}`
  );
}

if (process.argv[1] && process.argv[1].endsWith("cli.ts")) {
  const repoRoot = resolve(process.cwd(), process.argv[process.argv.indexOf("--repo") + 1] ?? ".");
  const databasePath = resolve(
    process.cwd(),
    process.argv[process.argv.indexOf("--db") + 1] ?? "var/index.duckdb"
  );
  const full = process.argv.includes("--full");
  const sinceIndex = process.argv.indexOf("--since");
  const since = sinceIndex >= 0 ? process.argv[sinceIndex + 1] : undefined;

  void runIndexer({ repoRoot, databasePath, full, since });
}
