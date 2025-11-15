#!/usr/bin/env tsx
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";

import {
  loadDataset,
  ComparisonRunner,
  JsonReporter,
  ComparisonReporter,
} from "../../external/assay-kit/src/index.ts";
import { createKiriAdapter, getVariantConfig, getAvailableVariants } from "./kiri-variants.js";

interface CLIOptions {
  dataset: string;
  variantA: string;
  variantB: string;
  concurrency: number;
  degradationThreshold: number;
  statsMethod: "auto" | "paired-t" | "independent-t" | "mann-whitney-u";
  statsAlpha: number;
  correction: "none" | "bonferroni" | "holm";
  dbLeft?: string;
  dbRight?: string;
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = {
    dataset: "datasets/kiri-ab.yaml",
    variantA: "default",
    variantB: "balanced",
    concurrency: 2,
    degradationThreshold: 0.3,
    statsMethod: "mann-whitney-u",
    statsAlpha: 0.05,
    correction: "holm",
  };

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--") {
      continue;
    }
    const value = args[i + 1];
    switch (flag) {
      case "--dataset":
        if (typeof value === "string" && value.length > 0) {
          options.dataset = value;
        }
        i += 1;
        break;
      case "--variant-a":
        if (typeof value === "string" && value.length > 0) {
          options.variantA = value;
        }
        i += 1;
        break;
      case "--variant-b":
        if (typeof value === "string" && value.length > 0) {
          options.variantB = value;
        }
        i += 1;
        break;
      case "--concurrency":
        options.concurrency = parseInt(value ?? String(options.concurrency), 10);
        i += 1;
        break;
      case "--degradation":
        options.degradationThreshold = parseFloat(value ?? String(options.degradationThreshold));
        i += 1;
        break;
      case "--stats":
        if (typeof value === "string" && value.length > 0) {
          options.statsMethod = value as CLIOptions["statsMethod"];
        }
        i += 1;
        break;
      case "--alpha":
        options.statsAlpha = parseFloat(value ?? String(options.statsAlpha));
        i += 1;
        break;
      case "--correction":
        if (typeof value === "string" && value.length > 0) {
          options.correction = value as CLIOptions["correction"];
        }
        i += 1;
        break;
      case "--db-left":
        if (typeof value === "string" && value.length > 0) {
          options.dbLeft = value;
        }
        i += 1;
        break;
      case "--db-right":
        if (typeof value === "string" && value.length > 0) {
          options.dbRight = value;
        }
        i += 1;
        break;
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        console.warn(`Unknown option: ${flag}`);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(
    `\n🔬 Assay ComparisonRunner (KIRI Integration)\n\nUsage:\n  pnpm run assay:compare -- [options]\n\nOptions:\n  --dataset <path>          Dataset path (default: datasets/kiri-ab.yaml)\n  --variant-a <name>        Variant name for adapter A (default: default)\n  --variant-b <name>        Variant name for adapter B (default: balanced)\n  --concurrency <n>         Runner concurrency (default: 2)\n  --degradation <ratio>     Degradation threshold (default: 0.3)\n  --stats <method>          Statistical test (auto|paired-t|independent-t|mann-whitney-u)\n  --alpha <value>           Significance level (default: 0.05)\n  --correction <method>    Multiple comparison correction (none|bonferroni|holm, default: holm)\n  --help                    Show this message\n\nAvailable variants: ${getAvailableVariants().join(", ")}\n`
  );
}

async function main(): Promise<void> {
  const options = parseArgs();
  const repoRoot = process.cwd();
  const defaultDbPath = join(repoRoot, "var/index.duckdb");
  const datasetPath = join(repoRoot, options.dataset);
  const resultsDir = join(repoRoot, "var/assay");

  if (!existsSync(options.dbLeft ?? defaultDbPath)) {
    throw new Error(
      `DuckDB not found at ${options.dbLeft ?? defaultDbPath}. Run kiri index first.`
    );
  }
  if (!existsSync(datasetPath)) {
    throw new Error(`Dataset not found at ${datasetPath}.`);
  }
  if (!existsSync(resultsDir)) {
    mkdirSync(resultsDir, { recursive: true });
  }

  const dbLeftPath = options.dbLeft ?? defaultDbPath;
  const dbRightPath =
    options.dbRight ??
    (options.variantB === options.variantA
      ? dbLeftPath
      : prepareVariantDbCopy(dbLeftPath, options.variantB));

  const statsMethodNormalized: "auto" | "paired-t" | "independent-t" | "mann-whitney" =
    options.statsMethod === "mann-whitney-u" ? "mann-whitney" : options.statsMethod;

  console.log("🔬 KIRI ComparisonRunner (Phase 2.1)");
  console.log(`  Dataset: ${datasetPath}`);
  console.log(`  Variant A: ${options.variantA} (db: ${dbLeftPath})`);
  console.log(`  Variant B: ${options.variantB} (db: ${dbRightPath})`);
  console.log(`  Stats Method: ${options.statsMethod} (α=${options.statsAlpha})`);
  console.log(`  Correction: ${options.correction}`);
  console.log("  Degradation Threshold:", `${(options.degradationThreshold * 100).toFixed(0)}%\n`);

  const dataset = await loadDataset(datasetPath);
  const configA = getVariantConfig(options.variantA);
  const configB = getVariantConfig(options.variantB);

  const adapterA = createKiriAdapter(options.variantA, dbLeftPath, repoRoot);
  const adapterB = createKiriAdapter(options.variantB, dbRightPath, repoRoot);

  const runner = new ComparisonRunner({
    left: { adapter: adapterA, maxRetries: 2, warmupRuns: 1 },
    right: { adapter: adapterB, maxRetries: 2, warmupRuns: 1 },
    comparisonId: `kiri-${options.variantA}-vs-${options.variantB}`,
    executionStrategy: "sequential",
    pairingPolicy: "lenient",
    degradationThreshold: options.degradationThreshold,
    statisticalAnalysis: {
      enabled: true,
      method: statsMethodNormalized,
      alpha: options.statsAlpha,
      correction: options.correction,
      metrics: [],
    },
    metadata: {
      variantA: configA,
      variantB: configB,
    },
  });

  console.log("📊 Running comparison...\n");
  const result = await runner.evaluate(dataset);

  const comparisonReporter = new ComparisonReporter({ verbosity: "verbose" });
  await comparisonReporter.write(result);

  const timestamp = new Date().toISOString().split("T")[0];
  const jsonPath = join(
    resultsDir,
    `comparison-${options.variantA}-vs-${options.variantB}-${timestamp}.json`
  );
  const jsonReporter = new JsonReporter({ outputPath: jsonPath });
  await jsonReporter.write(result);

  console.log(`\n📄 Comparison result saved to ${jsonPath}`);

  process.exit(0);
}

main().catch((error) => {
  console.error(
    `\n❌ Assay comparison failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});

function prepareVariantDbCopy(basePath: string, variant: string): string {
  const dir = dirname(basePath);
  const ext = extname(basePath) || ".duckdb";
  const target = join(dir, `index-${variant}${ext}`);
  copyFileSync(basePath, target);
  const walSource = `${basePath}.wal`;
  if (existsSync(walSource)) {
    copyFileSync(walSource, `${target}.wal`);
  }
  return target;
}
