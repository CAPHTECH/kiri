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
import contextCoverageMetric from "./plugins/context-coverage-metric.js";
import { createKiriAdapter } from "./kiri-variants.js";

type EvalProfile = "current" | "release";

function parseProfileArg(): EvalProfile {
  const args = process.argv.slice(2);
  const index = args.indexOf("--profile");
  if (index === -1) {
    return "current";
  }
  const value = args[index + 1]?.toLowerCase();
  if (value === "release") {
    return "release";
  }
  if (value === "current" || value === undefined) {
    return "current";
  }
  throw new Error(`Unknown profile '${value}'. Use 'current' or 'release'.`);
}

function applyProfileEnv(profile: EvalProfile): void {
  const toggles = [
    "KIRI_SUPPRESS_NON_CODE",
    "KIRI_SUPPRESS_FINAL_RESULTS",
    "KIRI_CLAMP_SNIPPETS",
    "KIRI_FORCE_COMPACT",
    "KIRI_SNIPPET_WINDOW",
  ];

  if (profile === "release") {
    process.env.KIRI_SUPPRESS_NON_CODE = "0";
    process.env.KIRI_SUPPRESS_FINAL_RESULTS = "0";
    process.env.KIRI_CLAMP_SNIPPETS = "0";
    process.env.KIRI_FORCE_COMPACT = "0";
    process.env.KIRI_SNIPPET_WINDOW = "40";
    process.env.KIRI_ASSAY_PROFILE = "release";
    return;
  }

  for (const key of toggles) {
    delete process.env[key];
  }
  process.env.KIRI_ASSAY_PROFILE = "current";
}

async function main(): Promise<void> {
  const profile = parseProfileArg();
  applyProfileEnv(profile);

  console.log(`🎯 KIRI Integration Evaluation (profile: ${profile})\n`);

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
  const baseName = `eval-${profile}-${timestamp}`;
  const jsonPath = join(resultsDir, `${baseName}.json`);
  const mdPath = join(resultsDir, `${baseName}.md`);

  const jsonReporter = new JsonReporter({ outputPath: jsonPath });
  await jsonReporter.write(result);

  const mdReporter = new MarkdownReporter({ outputPath: mdPath });
  await mdReporter.write(result);

  const consoleReporter = new ConsoleReporter({ verbosity: "normal" });
  await consoleReporter.write(result);

  console.log(`\n📄 Results written to:\n  JSON: ${jsonPath}\n  Markdown: ${mdPath}\n`);

  // Demonstrate plugin system registration (Phase 2.2)
  const registry = new PluginRegistry();
  await registry.register(
    contextCoverageMetric as unknown as Parameters<typeof registry.register>[0],
    {
      config: { threshold: 0.8 },
      timeout: 2000,
    }
  );
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
