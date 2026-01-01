#!/usr/bin/env tsx
import { isAbsolute } from "node:path";
import process from "node:process";

import { BaselineService } from "../../external/assay-kit/packages/assay-kit/src/baseline/service.ts";
import type { PromotePayload } from "../../external/assay-kit/packages/assay-kit/src/baseline/types.ts";
import { loadMetricsFromFile } from "../../external/assay-kit/packages/assay-kit/src/baseline/utils.ts";
import { resolveSafePath } from "../../src/shared/fs/safePath.ts";

interface CliOptions {
  target: string;
  notes?: string;
  version?: string;
  failOnRegression?: boolean;
}

function parseFlags(args: string[]): CliOptions {
  const options: CliOptions = {
    target: "vscode-golden",
  };
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (typeof token !== "string" || !token.startsWith("--")) {
      continue;
    }
    const [flag, inlineValue] = token.split("=", 2);
    let resolvedValue = inlineValue;
    if (resolvedValue === undefined) {
      const peek = args[i + 1];
      if (peek !== undefined && !peek.startsWith("--")) {
        resolvedValue = peek;
        i++;
      }
    }
    switch (flag) {
      case "--target":
        if (!resolvedValue) throw new Error("--target requires a value");
        options.target = resolvedValue;
        break;
      case "--notes":
        if (!resolvedValue) throw new Error("--notes requires a value");
        options.notes = resolvedValue;
        break;
      case "--version":
        if (!resolvedValue) throw new Error("--version requires a value");
        options.version = resolvedValue;
        break;
      case "--fail-on-regression":
        options.failOnRegression = true;
        break;
      default:
        throw new Error(`Unknown flag ${flag}`);
    }
  }
  return options;
}

async function promote(runPath: string, options: CliOptions): Promise<void> {
  const metrics = await loadMetricsFromFile(runPath);
  const payload: PromotePayload = {
    snapshot: {
      metrics,
      metadata: {
        source: runPath,
        timestamp: new Date().toISOString(),
      },
    },
  };
  if (options.notes) payload.notes = options.notes;
  if (options.version) payload.versionId = options.version;
  const service = new BaselineService({ cwd: process.cwd() });
  const version = await service.promote(options.target, payload);
  console.log(`Stored baseline version ${version.id} for target ${options.target}`);
}

async function compare(runPath: string, options: CliOptions): Promise<void> {
  const metrics = await loadMetricsFromFile(runPath);
  const service = new BaselineService({ cwd: process.cwd() });
  const comparison = await service.compare(options.target, metrics);
  console.log(
    `Baseline comparison for ${options.target}: passed=${comparison.passed}, regressions=${comparison.regressions.length}, improvements=${comparison.improvements.length}`
  );
  for (const regression of comparison.regressions) {
    console.log(
      `  ✗ ${regression.metric}: current=${regression.current} baseline=${regression.baseline} Δ=${regression.delta}`
    );
  }
  if (options.failOnRegression && !comparison.passed) {
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const [mode, rawRunPath = "var/assay/latest.json", ...rest] = process.argv.slice(2);
  if (!mode || (mode !== "promote" && mode !== "compare")) {
    console.error(
      "Usage: pnpm exec tsx scripts/assay/baseline.ts <promote|compare> [metrics.json] [--target=<id>] [--notes=<text>] [--version=<id>] [--fail-on-regression]"
    );
    process.exit(1);
    return;
  }
  const options = parseFlags(rest);
  const allowExternalPaths = process.env.KIRI_ALLOW_UNSAFE_PATHS === "1";
  if (!allowExternalPaths && isAbsolute(rawRunPath)) {
    throw new Error(`Absolute metrics path '${rawRunPath}' requires KIRI_ALLOW_UNSAFE_PATHS=1.`);
  }
  const runPath = resolveSafePath(rawRunPath, { allowOutsideBase: allowExternalPaths });
  if (mode === "promote") {
    await promote(runPath, options);
  } else {
    await compare(runPath, options);
  }
}

main().catch((error) => {
  console.error(
    `Baseline script failed: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});
