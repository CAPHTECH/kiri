#!/usr/bin/env tsx
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  loadDataset,
  Runner,
  JsonReporter,
  MarkdownReporter,
  ConsoleReporter,
} from "../../external/assay-kit/packages/assay-kit/src/index.ts";
import { PluginRegistry } from "../../external/assay-kit/packages/assay-kit/src/plugins/registry.ts";

import { createKiriAdapter } from "./kiri-variants.js";
import contextCoverageMetric from "./plugins/context-coverage-metric.js";

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

function parseDatasetArg(defaultPath: string): string {
  const args = process.argv.slice(2);
  const index = args.indexOf("--dataset");
  if (index === -1) {
    return defaultPath;
  }
  const value = args[index + 1];
  if (!value) {
    throw new Error("Missing value for --dataset. Pass a path to a dataset YAML.");
  }
  return value;
}

function parseRepoArg(defaultPath: string): string {
  const args = process.argv.slice(2);
  const index = args.indexOf("--repo");
  if (index === -1) {
    return defaultPath;
  }
  const value = args[index + 1];
  if (!value) {
    throw new Error("Missing value for --repo. Pass a repo root path.");
  }
  return value;
}

function resolveDefaultDbPath(repoRoot: string): string {
  const candidate = join(repoRoot, ".kiri", "index.duckdb");
  if (existsSync(candidate)) {
    return candidate;
  }
  return join(repoRoot, "var/index.duckdb");
}

function parseDbArg(defaultPath: string): string {
  const args = process.argv.slice(2);
  const index = args.indexOf("--db");
  if (index === -1) {
    return defaultPath;
  }
  const value = args[index + 1];
  if (!value) {
    throw new Error("Missing value for --db. Pass a DuckDB path.");
  }
  return value;
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

  const workspaceRoot = process.cwd();
  const repoRoot = parseRepoArg(workspaceRoot);
  const databasePath = parseDbArg(resolveDefaultDbPath(repoRoot));
  const defaultDatasetPath = join(
    workspaceRoot,
    "external/assay-kit/examples/kiri-integration/datasets/kiri-golden.yaml"
  );
  const datasetPath = parseDatasetArg(defaultDatasetPath);
  const resultsDir = join(workspaceRoot, "var/assay");

  if (!existsSync(databasePath)) {
    throw new Error(
      `DuckDB not found at ${databasePath}. Run \`pnpm exec kiri index --repo ${repoRoot} --db ${databasePath}\` first.`
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

  const registry = new PluginRegistry();
  let enhancedResult: Awaited<ReturnType<Runner["evaluate"]>>;
  let pluginMetricsSummary: Record<string, unknown> | null = null;
  try {
    await registry.register(contextCoverageMetric, {
      config: { threshold: 0.8 },
      timeout: 2000,
    });

    const adapter = createKiriAdapter("default", databasePath, repoRoot);
    const runner = new Runner({
      adapter,
      warmupRuns: 1,
      concurrency: 3,
      maxRetries: 2,
    });

    console.log("🚀 Running Assay evaluation (Phase 2 baseline)...\n");
    const result = await runner.evaluate(dataset);

    const pluginMetrics: Record<string, unknown> = {};
    for (const handle of registry.getAll("metric")) {
      const capabilities = handle.capabilities;
      if (!capabilities?.calculate) {
        continue;
      }
      try {
        const values = await capabilities.calculate();
        if (values && Object.keys(values).length > 0) {
          pluginMetrics[handle.plugin.meta.name] = values;
        }
      } catch (error) {
        console.warn(
          `⚠️  Metric plugin '${handle.plugin.meta.name}' failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    if (Object.keys(pluginMetrics).length > 0) {
      pluginMetricsSummary = pluginMetrics;
      enhancedResult = {
        ...result,
        metadata: {
          ...(result.metadata ?? {}),
          pluginMetrics,
        },
      };
    } else {
      enhancedResult = result;
    }
  } finally {
    await registry.disposeAll("evaluation-complete");
  }

  const timestamp = new Date().toISOString().split("T")[0];
  const datasetSlug = dataset.name.replace(/[^a-zA-Z0-9_-]+/g, "-");
  const baseName = `eval-${profile}-${datasetSlug}-${timestamp}`;
  const jsonPath = join(resultsDir, `${baseName}.json`);
  const mdPath = join(resultsDir, `${baseName}.md`);
  const latestJsonPath = join(resultsDir, "latest.json");
  const latestMdPath = join(resultsDir, "latest.md");

  const jsonReporter = new JsonReporter({ outputPath: jsonPath });
  await jsonReporter.write(enhancedResult);
  const latestJsonReporter = new JsonReporter({ outputPath: latestJsonPath });
  await latestJsonReporter.write(enhancedResult);

  const mdReporter = new MarkdownReporter({ outputPath: mdPath });
  await mdReporter.write(enhancedResult);
  const latestMdReporter = new MarkdownReporter({ outputPath: latestMdPath });
  await latestMdReporter.write(enhancedResult);

  const consoleReporter = new ConsoleReporter({ verbosity: "normal" });
  await consoleReporter.write(enhancedResult);

  console.log(
    `\n📄 Results written to:\n  JSON: ${jsonPath}\n  Markdown: ${mdPath}\n  Latest JSON: ${latestJsonPath}\n  Latest Markdown: ${latestMdPath}\n`
  );

  if (pluginMetricsSummary) {
    console.log("🔌 Plugin metrics summary:");
    for (const [name, values] of Object.entries(pluginMetricsSummary)) {
      console.log(`  • ${name}:`, values);
    }
  } else {
    console.log("🔌 Loaded metric plugins: (none)");
  }

  process.exit(0);
}

main().catch((error) => {
  console.error(
    `\n❌ Assay evaluation failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});
