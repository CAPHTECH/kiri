#!/usr/bin/env tsx
/**
 * Verify that all expected paths in golden set queries actually exist
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYAML } from "yaml";

interface GoldenQuery {
  id: string;
  query: string;
  category: string;
  repo?: string;
  expected: {
    paths: string[];
  };
}

interface RepoConfig {
  repoPath: string;
  dbPath: string;
}

interface GoldenSet {
  queries: GoldenQuery[];
  repos?: Record<string, RepoConfig>;
}

interface ValidationResult {
  totalQueries: number;
  totalExpectedPaths: number;
  missingPaths: Array<{
    queryId: string;
    repo: string;
    path: string;
    reason?: string;
  }>;
  queriesWithMissing: Set<string>;
}

function loadRepoRoots(goldenSet: GoldenSet): Record<string, string> {
  const repoRoots: Record<string, string> = {};

  if (goldenSet.repos) {
    for (const [name, config] of Object.entries(goldenSet.repos)) {
      repoRoots[name] = config.repoPath;
    }
  }

  // Fallback for repos not defined in golden set
  if (!repoRoots.vscode) {
    repoRoots.vscode = "external/vscode";
  }

  return repoRoots;
}

function main(): void {
  const goldenPath = join(process.cwd(), "tests/eval/goldens/queries.yaml");

  if (!existsSync(goldenPath)) {
    console.error(`❌ Golden set not found: ${goldenPath}`);
    process.exit(1);
  }

  const content = readFileSync(goldenPath, "utf8");
  const goldenSet = parseYAML(content) as GoldenSet;

  const REPO_ROOTS = loadRepoRoots(goldenSet);

  console.log("\n🔍 Verifying Golden Set Expected Paths...\n");

  const result: ValidationResult = {
    totalQueries: goldenSet.queries.length,
    totalExpectedPaths: 0,
    missingPaths: [],
    queriesWithMissing: new Set(),
  };

  for (const query of goldenSet.queries) {
    const repo = query.repo ?? "vscode";
    const repoRoot = REPO_ROOTS[repo];

    if (!repoRoot) {
      console.warn(`⚠️  Unknown repo '${repo}' for query '${query.id}'`);
      continue;
    }

    const expectedPaths = query.expected.paths ?? [];
    result.totalExpectedPaths += expectedPaths.length;

    for (const expectedPath of expectedPaths) {
      const fullPath = join(process.cwd(), repoRoot, expectedPath);

      try {
        if (!existsSync(fullPath)) {
          result.missingPaths.push({
            queryId: query.id,
            repo,
            path: expectedPath,
            reason: "File does not exist",
          });
          result.queriesWithMissing.add(query.id);
          continue;
        }

        const stats = statSync(fullPath);
        if (!stats.isFile()) {
          result.missingPaths.push({
            queryId: query.id,
            repo,
            path: expectedPath,
            reason: "Path exists but is not a file",
          });
          result.queriesWithMissing.add(query.id);
        }
      } catch (error) {
        result.missingPaths.push({
          queryId: query.id,
          repo,
          path: expectedPath,
          reason: error instanceof Error ? error.message : "Unknown error",
        });
        result.queriesWithMissing.add(query.id);
      }
    }
  }

  // Print results
  console.log(`Total queries: ${result.totalQueries}`);
  console.log(`Total expected paths: ${result.totalExpectedPaths}`);
  console.log(`Missing paths: ${result.missingPaths.length}`);
  console.log(`Queries with missing paths: ${result.queriesWithMissing.size}\n`);

  if (result.missingPaths.length === 0) {
    console.log("✅ All expected paths exist!\n");
    process.exit(0);
  }

  console.log("❌ Missing Paths:\n");

  // Group by query
  const byQuery = new Map<string, Array<{ repo: string; path: string; reason?: string }>>();
  for (const missing of result.missingPaths) {
    if (!byQuery.has(missing.queryId)) {
      byQuery.set(missing.queryId, []);
    }
    byQuery.get(missing.queryId)!.push({
      repo: missing.repo,
      path: missing.path,
      ...(missing.reason !== undefined && { reason: missing.reason }),
    });
  }

  for (const [queryId, paths] of byQuery.entries()) {
    console.log(`  Query: ${queryId}`);
    for (const { repo, path, reason } of paths) {
      const reasonSuffix = reason ? ` (${reason})` : "";
      console.log(`    - ${repo}: ${path}${reasonSuffix}`);
    }
    console.log();
  }

  console.log(
    `\n⚠️  Found ${result.missingPaths.length} missing paths in ${result.queriesWithMissing.size} queries.`
  );
  console.log(
    "   These queries may have incorrect expected paths or the repo structure has changed.\n"
  );

  process.exit(1);
}

main();
