#!/usr/bin/env tsx
import { readFile } from "node:fs/promises";
import process from "node:process";

import yaml from "yaml";

import { tokenizeText } from "../../src/shared/tokenizer.js";

interface CliOptions {
  datasetPath: string;
  repoFilter?: string;
  idFilter?: string;
}

interface GoldenQuery {
  id: string;
  query?: string;
  goal?: string;
  repo?: string;
  expected?: {
    paths?: string[];
  };
  hints?: string[];
}

interface GoldenDataset {
  queries: GoldenQuery[];
}

function parseArgs(): CliOptions {
  const options: CliOptions = {
    datasetPath: "tests/eval/goldens/queries.yaml",
  };
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === "--dataset") {
      options.datasetPath = process.argv[i + 1] ?? options.datasetPath;
      i += 1;
    } else if (arg === "--repo") {
      const value = process.argv[i + 1];
      if (value !== undefined) options.repoFilter = value;
      i += 1;
    } else if (arg === "--id") {
      const value = process.argv[i + 1];
      if (value !== undefined) options.idFilter = value;
      i += 1;
    }
  }
  return options;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function extractPathSegments(paths: string[] | undefined): string[] {
  if (!paths || paths.length === 0) {
    return [];
  }
  const segments: string[] = [];
  for (const path of paths) {
    const parts = path
      .split(/[/.]/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 3);
    segments.push(...parts);
  }
  return unique(segments);
}

function logQueryInfo(query: GoldenQuery): void {
  const text = query.query ?? query.goal ?? "";
  const keywords = unique(tokenizeText(text));
  const pathSegments = extractPathSegments(query.expected?.paths);
  const hints = unique(query.hints ?? []);

  console.log(`\n=== ${query.id} (repo: ${query.repo ?? "default"}) ===`);
  console.log(`Query Text: ${text}`);
  console.log(`Keywords (${keywords.length}): ${keywords.join(", ") || "(none)"}`);
  console.log(`Path segments (${pathSegments.length}): ${pathSegments.join(", ") || "(none)"}`);
  console.log(`Hints (${hints.length}): ${hints.join(", ") || "(none)"}`);
}

async function main(): Promise<void> {
  const options = parseArgs();
  const raw = await readFile(options.datasetPath, "utf8");
  const dataset = yaml.parse(raw) as GoldenDataset;
  if (!dataset?.queries) {
    throw new Error(`Dataset at ${options.datasetPath} has no queries`);
  }

  const filtered = dataset.queries.filter((query) => {
    if (options.idFilter && query.id !== options.idFilter) {
      return false;
    }
    if (options.repoFilter && query.repo !== options.repoFilter) {
      return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    console.warn("No queries matched the provided filters.");
    return;
  }

  for (const query of filtered) {
    logQueryInfo(query);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
