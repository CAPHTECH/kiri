import { access, readFile } from "node:fs/promises";
import { posix, resolve, sep } from "node:path";
import process from "node:process";

import yaml from "yaml";

import { DuckDBClient } from "../../src/shared/duckdb.js";

type CoverageSource = "metadata" | "reference";

interface CliOptions {
  datasetPath: string;
  dbPath: string;
  repoRoot: string;
  json: boolean;
}

interface CoverageRecord {
  path: string;
  queryIds: Set<string>;
  sources: Set<CoverageSource>;
  existsOnDisk?: boolean;
  indexedInDb?: boolean;
}

interface DatasetFile {
  queries?: Array<{
    id?: string;
    metadata?: {
      expected?: unknown;
    };
  }>;
  expected?: Array<{
    id?: string;
    reference?: {
      paths?: unknown;
    };
  }>;
}

interface CoverageSummary {
  records: CoverageRecord[];
  missingOnDisk: CoverageRecord[];
  missingInDb: CoverageRecord[];
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    datasetPath: "datasets/kiri-ab.yaml",
    dbPath: "var/index.duckdb",
    repoRoot: ".",
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      break;
    }
    switch (arg) {
      case "--dataset": {
        const value = argv[i + 1];
        if (!value) {
          throw new Error("--dataset requires a path");
        }
        options.datasetPath = value;
        i += 1;
        break;
      }
      case "--db": {
        const value = argv[i + 1];
        if (!value) {
          throw new Error("--db requires a path");
        }
        options.dbPath = value;
        i += 1;
        break;
      }
      case "--repo": {
        const value = argv[i + 1];
        if (!value) {
          throw new Error("--repo requires a path");
        }
        options.repoRoot = value;
        i += 1;
        break;
      }
      case "--json":
        options.json = true;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown option: ${arg}`);
        }
    }
  }

  return options;
}

function normalizeRepoPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") {
    return "";
  }
  const normalized = posix.normalize(trimmed).replace(/^(\.\/)+/, "");
  return normalized.startsWith("/") ? normalized.slice(1) : normalized;
}

function addCoverageRecord(
  map: Map<string, CoverageRecord>,
  path: string,
  queryId: string,
  source: CoverageSource
): void {
  const normalized = normalizeRepoPath(path);
  if (!normalized) {
    return;
  }
  if (!map.has(normalized)) {
    map.set(normalized, {
      path: normalized,
      queryIds: new Set(),
      sources: new Set(),
    });
  }
  const record = map.get(normalized);
  if (!record) {
    return;
  }
  record.queryIds.add(queryId);
  record.sources.add(source);
}

function extractPaths(entry: unknown): string[] {
  if (!entry) {
    return [];
  }
  if (typeof entry === "string") {
    return [entry];
  }
  if (Array.isArray(entry)) {
    return entry.flatMap((item) => extractPaths(item));
  }
  if (typeof entry === "object") {
    const result: string[] = [];
    const record = entry as Record<string, unknown>;
    if (typeof record.path === "string") {
      result.push(record.path);
    }
    if (Array.isArray(record.paths)) {
      for (const item of record.paths) {
        if (typeof item === "string") {
          result.push(item);
        }
      }
    }
    if (typeof record.reference === "object" && record.reference !== null) {
      const reference = record.reference as { paths?: unknown };
      result.push(...extractPaths(reference.paths));
    }
    return result;
  }
  return [];
}

function collectCoverageTargets(dataset: DatasetFile): Map<string, CoverageRecord> {
  const map = new Map<string, CoverageRecord>();

  if (Array.isArray(dataset.queries)) {
    for (const query of dataset.queries) {
      const queryId = typeof query.id === "string" ? query.id : "unknown";
      const expected = query.metadata?.expected;
      if (!expected) {
        continue;
      }
      for (const path of extractPaths(expected)) {
        addCoverageRecord(map, path, queryId, "metadata");
      }
    }
  }

  if (Array.isArray(dataset.expected)) {
    for (const referenceEntry of dataset.expected) {
      const queryId = typeof referenceEntry.id === "string" ? referenceEntry.id : "reference";
      for (const path of extractPaths(referenceEntry.reference?.paths)) {
        addCoverageRecord(map, path, queryId, "reference");
      }
    }
  }

  return map;
}

async function pathExists(pathToCheck: string): Promise<boolean> {
  try {
    await access(pathToCheck);
    return true;
  } catch {
    return false;
  }
}

async function ensureDbExists(dbPath: string): Promise<void> {
  try {
    await access(dbPath);
  } catch {
    throw new Error(`DuckDB database not found at ${dbPath}. Run the indexer first.`);
  }
}

async function analyzeCoverage(options: CliOptions): Promise<CoverageSummary> {
  const repoRoot = resolve(options.repoRoot);
  const repoRootWithSep = repoRoot.endsWith(sep) ? repoRoot : `${repoRoot}${sep}`;
  const datasetPath = resolve(repoRoot, options.datasetPath);
  const dbPath = resolve(repoRoot, options.dbPath);

  const datasetContent = await readFile(datasetPath, "utf-8");
  const dataset = yaml.parse(datasetContent) as DatasetFile;
  const coverageMap = collectCoverageTargets(dataset);
  const records = [...coverageMap.values()].sort((a, b) => a.path.localeCompare(b.path));

  for (const record of records) {
    const absolute = resolve(repoRoot, record.path);
    if (!absolute.startsWith(repoRootWithSep)) {
      throw new Error(`Path ${record.path} escapes repository root ${repoRoot}`);
    }
    record.existsOnDisk = await pathExists(absolute);
  }

  await ensureDbExists(dbPath);
  const db = await DuckDBClient.connect({ databasePath: dbPath });
  try {
    await db.run("PRAGMA table_info('file')");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`DuckDB at ${dbPath} is missing table 'file'. ${message}`);
  }

  try {
    for (const record of records) {
      const result = await db.all<{ count: number }>(
        "SELECT COUNT(*) as count FROM file WHERE path = ?",
        [record.path]
      );
      const count = result[0]?.count ?? 0;
      record.indexedInDb = count > 0;
    }
  } finally {
    await db.close();
  }

  return {
    records,
    missingOnDisk: records.filter((record) => record.existsOnDisk === false),
    missingInDb: records.filter((record) => record.indexedInDb === false),
  };
}

function formatRecord(record: CoverageRecord) {
  return {
    path: record.path,
    queries: Array.from(record.queryIds).join(", "),
    sources: Array.from(record.sources).join(", "),
    existsOnDisk: record.existsOnDisk ? "✅" : "❌",
    indexedInDb: record.indexedInDb ? "✅" : "❌",
  };
}

function summarizeByRoot(records: CoverageRecord[]): Record<string, number> {
  const summary = new Map<string, number>();
  for (const record of records) {
    const [root] = record.path.split("/", 1);
    const key = root ?? "(unknown)";
    summary.set(key, (summary.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...summary.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const summary = await analyzeCoverage(options);

  if (options.json) {
    console.info(
      JSON.stringify(
        {
          totals: {
            expectedPaths: summary.records.length,
            missingOnDisk: summary.missingOnDisk.length,
            missingInDb: summary.missingInDb.length,
          },
          missingOnDisk: summary.missingOnDisk.map((record) => ({
            path: record.path,
            queries: Array.from(record.queryIds),
          })),
          missingInDb: summary.missingInDb.map((record) => ({
            path: record.path,
            queries: Array.from(record.queryIds),
          })),
        },
        null,
        2
      )
    );
  } else {
    console.info(`Dataset: ${options.datasetPath}`);
    console.info(`DuckDB:  ${options.dbPath}`);
    console.info(`Repo:    ${options.repoRoot}`);
    console.info("");
    console.info(`Total expected paths: ${summary.records.length}`);
    console.info(`Missing on disk:      ${summary.missingOnDisk.length}`);
    console.info(`Missing in DuckDB:    ${summary.missingInDb.length}`);
    console.info("");
    if (summary.missingOnDisk.length > 0) {
      console.info("⚠️  Missing on disk:");
      console.table(summary.missingOnDisk.map((record) => formatRecord(record)));
      console.info("Buckets:", summarizeByRoot(summary.missingOnDisk));
      console.info("");
    }
    if (summary.missingInDb.length > 0) {
      console.info("⚠️  Missing in DuckDB:");
      console.table(summary.missingInDb.map((record) => formatRecord(record)));
      console.info("Buckets:", summarizeByRoot(summary.missingInDb));
      console.info("");
    }
  }

  if (summary.missingOnDisk.length > 0 || summary.missingInDb.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
