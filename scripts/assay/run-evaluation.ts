#!/usr/bin/env tsx
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  loadDataset,
  Runner,
  JsonReporter,
  MarkdownReporter,
  ConsoleReporter,
} from "../../external/assay-kit/src/index.ts";
import { PluginRegistry } from "../../external/assay-kit/src/plugins/registry.ts";

import { createKiriAdapter } from "./kiri-variants.js";
import contextCoverageMetric from "./plugins/context-coverage-metric.js";

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const databasePath = join(repoRoot, "var/index.duckdb");
  const datasetPath = join(
    repoRoot,
    "external/assay-kit/examples/kiri-integration/datasets/kiri-golden.yaml"
  );
  const resultsDir = join(repoRoot, "var/assay");

  if (!existsSync(databasePath)) {
    throw new Error(
      `DuckDB not found at ${databasePath}. Run \`pnpm exec kiri index --repo . --db ${databasePath}\` first.`
    );
  }
  if (!existsSync(datasetPath)) {
    throw new Error(`Dataset not found at ${datasetPath}.`);
  }
  if (!existsSync(resultsDir)) {
    mkdirSync(resultsDir, { recursive: true });
  }

  console.log("📖 Loading Assay dataset...");
  const dataset = await loadDataset(datasetPath);
  console.log(`  Loaded ${dataset.queries.length} queries from ${dataset.name}`);

  const adapter = createKiriAdapter("default", databasePath, repoRoot);
  const runner = new Runner({
    adapter,
    warmupRuns: 1,
    concurrency: 3,
    maxRetries: 2,
  });

  console.log("🚀 Running Assay evaluation (Phase 2 baseline)...\n");
  const result = await runner.evaluate(dataset);

  const timestamp = new Date().toISOString().split("T")[0];
  const jsonPath = join(resultsDir, `eval-${timestamp}.json`);
  const mdPath = join(resultsDir, `eval-${timestamp}.md`);

  const jsonReporter = new JsonReporter(jsonPath);
  await jsonReporter.write(result);

  const mdReporter = new MarkdownReporter(mdPath);
  await mdReporter.write(result);

  const consoleReporter = new ConsoleReporter({ verbosity: "normal" });
  await consoleReporter.write(result);

  console.log(`\n📄 Results written to:\n  JSON: ${jsonPath}\n  Markdown: ${mdPath}\n`);

  // Demonstrate plugin system registration (Phase 2.2)
  const registry = new PluginRegistry();
  await registry.register(contextCoverageMetric, {
    config: { threshold: 0.8 },
    timeout: 2000,
  });
  console.log(
    "🔌 Loaded metric plugins:",
    registry
      .getAll("metric")
      .map((plugin) => plugin.plugin.meta.name)
      .join(", ")
  );
  await registry.disposeAll("evaluation-complete");

  process.exit(0);
}

main().catch((error) => {
  console.error(
    `\n❌ Assay evaluation failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});
