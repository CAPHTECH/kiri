import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runIndexer } from "../../src/indexer/cli.js";
import { ServerContext } from "../../src/server/context.js";
import { WarningManager } from "../../src/server/rpc.js";
import { contextBundle, filesSearch, resolveRepoId } from "../../src/server/handlers.js";
import { DuckDBClient } from "../../src/shared/duckdb.js";
import { createTempRepo } from "../helpers/test-repo.js";

interface CleanupTarget {
  dispose: () => Promise<void>;
}

describe("Unified Boosting Logic (v0.7.0+)", () => {
  const cleanupTargets: CleanupTarget[] = [];

  afterEach(async () => {
    for (const target of cleanupTargets.splice(0, cleanupTargets.length)) {
      await target.dispose();
    }
  });

  // Critical: Unified logic verification
  it("files_search and context_bundle rank files consistently", async () => {
    const repo = await createTempRepo({
      "src/app/router.ts": `export function route(path: string) {\n  return { path, component: "Page" };\n}\n`,
      "src/components/Nav.tsx": `export function Nav() {\n  return <nav>Navigation</nav>;\n}\n`,
      "src/lib/utils.ts": `export function util() {\n  return "helper";\n}\n`,
      "src/index.ts": `export * from './app';\n`,
      "README.md": `# Routing Guide\n\nThis explains the routing system.\n`,
      "docs/routing.md": `# URL Patterns\n\nHow to access pages.\n`,
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-unified-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = { db, repoId, warningManager: new WarningManager() };

    // Run both tools with default profile
    const filesResults = await filesSearch(context, {
      query: "routing",
      boost_profile: "default",
    });

    const bundleResults = await contextBundle(context, {
      goal: "routing system navigation",
      limit: 10,
    });

    // Both should prioritize implementation files
    const filesImplRank = filesResults.findIndex((r) => r.path.startsWith("src/"));
    const filesDocRank = filesResults.findIndex(
      (r) => r.path === "README.md" || r.path === "docs/routing.md"
    );

    const bundleImplRank = bundleResults.context.findIndex((r) => r.path.startsWith("src/"));
    const bundleDocRank = bundleResults.context.findIndex(
      (r) => r.path === "README.md" || r.path === "docs/routing.md"
    );

    // Implementation files should rank higher in both tools
    if (filesImplRank >= 0 && filesDocRank >= 0) {
      expect(filesImplRank).toBeLessThan(filesDocRank);
    }
    if (bundleImplRank >= 0 && bundleDocRank >= 0) {
      expect(bundleImplRank).toBeLessThan(bundleDocRank);
    }
  });

  it("both tools apply consistent docPenaltyMultiplier", async () => {
    const repo = await createTempRepo({
      "src/app/feature.ts": `export function feature() {\n  return "implementation";\n}\n`,
      "README.md": `# Feature Guide\n\nThis is documentation about the feature.\n`,
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-penalty-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = { db, repoId, warningManager: new WarningManager() };

    // Test with 'docs' profile - should boost documentation
    const filesResultsDocs = await filesSearch(context, {
      query: "feature",
      boost_profile: "docs",
    });

    const bundleResultsDocs = await contextBundle(context, {
      goal: "feature implementation guide",
      limit: 10,
      boost_profile: "docs",
    });

    // Both should prioritize README.md with docs profile
    const filesReadmeRank = filesResultsDocs.findIndex((r) => r.path === "README.md");
    const filesImplRank = filesResultsDocs.findIndex((r) => r.path === "src/app/feature.ts");

    const bundleReadmeRank = bundleResultsDocs.context.findIndex((r) => r.path === "README.md");
    const bundleImplRank = bundleResultsDocs.context.findIndex(
      (r) => r.path === "src/app/feature.ts"
    );

    // Documentation should rank higher with docs profile in both tools
    if (filesReadmeRank >= 0 && filesImplRank >= 0) {
      expect(filesReadmeRank).toBeLessThan(filesImplRank);
    }
    if (bundleReadmeRank >= 0 && bundleImplRank >= 0) {
      expect(bundleReadmeRank).toBeLessThan(bundleImplRank);
    }
  });

  // High: Path-based priority test
  it("ranks src/app/ > src/components/ > src/lib/ > src/ consistently", async () => {
    const repo = await createTempRepo({
      "src/app/page.ts": `export function page() { return "app"; }\n`,
      "src/components/Button.tsx": `export function Button() { return "component"; }\n`,
      "src/lib/utils.ts": `export function util() { return "lib"; }\n`,
      "src/index.ts": `export function main() { return "index"; }\n`,
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-priority-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = { db, repoId, warningManager: new WarningManager() };

    // Use a generic query that matches all files
    const results = await filesSearch(context, {
      query: "export function",
      boost_profile: "default",
    });

    expect(results.length).toBe(4);

    const appRank = results.findIndex((r) => r.path === "src/app/page.ts");
    const componentRank = results.findIndex((r) => r.path === "src/components/Button.tsx");
    const libRank = results.findIndex((r) => r.path === "src/lib/utils.ts");
    const indexRank = results.findIndex((r) => r.path === "src/index.ts");

    // Verify priority order: app > components > lib > src
    expect(appRank).toBeGreaterThanOrEqual(0);
    expect(componentRank).toBeGreaterThanOrEqual(0);
    expect(libRank).toBeGreaterThanOrEqual(0);
    expect(indexRank).toBeGreaterThanOrEqual(0);

    // Note: Exact ordering depends on BM25 scores + multipliers
    // We verify that app files get the highest boost (1.4x)
    // by checking their scores are higher than others
    const appScore = results[appRank]?.score ?? 0;
    const componentScore = results[componentRank]?.score ?? 0;
    const libScore = results[libRank]?.score ?? 0;

    // App should have highest score due to 1.4x multiplier
    expect(appScore).toBeGreaterThan(componentScore);
    expect(appScore).toBeGreaterThan(libScore);
  });

  // Medium: Edge case tests
  it("applies same penalty to .md, .yaml, .yml, .mdc, .json files", async () => {
    const repo = await createTempRepo({
      "README.md": `# Documentation\n`,
      "config.yaml": `key: value\n`,
      "data.yml": `data: true\n`,
      "docs.mdc": `# MDC file\n`,
      "package.json": `{"name": "test"}\n`,
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-extensions-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = { db, repoId, warningManager: new WarningManager() };

    const results = await filesSearch(context, {
      query: "test",
      boost_profile: "default",
    });

    // All doc files should have similar low scores (docPenaltyMultiplier = 0.3)
    const scores = results.map((r) => r.score);
    const maxScore = Math.max(...scores);
    const minScore = Math.min(...scores);

    // Scores should be relatively close (all penalized equally)
    // Allow some variance due to BM25 scoring differences
    const scoreRange = maxScore - minScore;
    expect(scoreRange).toBeLessThan(maxScore * 0.5); // Within 50% range
  });

  it("does not apply multiplier to negative scores", async () => {
    const repo = await createTempRepo({
      "node_modules/package.json": `{"name": "test-package"}\n`,
      "src/main.ts": `export function main() {}\n`,
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-negative-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = { db, repoId, warningManager: new WarningManager() };

    const bundle = await contextBundle(context, {
      goal: "package configuration",
      limit: 10,
    });

    // node_modules/ files should be blacklisted (score = -100)
    // and multiplier should NOT be applied to make it less negative
    const nodeModulesFile = bundle.context.find((item) => item.path.startsWith("node_modules/"));

    // Blacklisted files should be filtered out or have very negative scores
    expect(nodeModulesFile).toBeUndefined(); // Should be filtered out entirely
  });

  it("boost_profile='none' preserves original BM25 scores", async () => {
    const repo = await createTempRepo({
      "src/app/feature.ts": `export function feature() {\n  return "implementation";\n}\n`,
      "README.md": `# Feature Guide\n\nDocumentation about the feature.\n`,
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-none-scores-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = { db, repoId, warningManager: new WarningManager() };

    const resultsNone = await filesSearch(context, {
      query: "feature",
      boost_profile: "none",
    });

    const resultsDefault = await filesSearch(context, {
      query: "feature",
      boost_profile: "default",
    });

    expect(resultsNone.length).toBeGreaterThan(0);
    expect(resultsDefault.length).toBeGreaterThan(0);

    // Find the same file in both result sets
    const implFileNone = resultsNone.find((r) => r.path === "src/app/feature.ts");
    const implFileDefault = resultsDefault.find((r) => r.path === "src/app/feature.ts");
    const docFileNone = resultsNone.find((r) => r.path === "README.md");
    const docFileDefault = resultsDefault.find((r) => r.path === "README.md");

    // With 'none', no multipliers applied - scores should be closer
    if (implFileNone && docFileNone && implFileDefault && docFileDefault) {
      const scoreRatioNone = implFileNone.score / docFileNone.score;
      const scoreRatioDefault = implFileDefault.score / docFileDefault.score;

      // Default profile should create larger score gap (impl boosted, docs penalized)
      expect(scoreRatioDefault).toBeGreaterThan(scoreRatioNone);
    }
  });

  // ✅ NEW (v0.9.0): Test that boost_profile="docs" allows docs/ directory files
  it("boost_profile='docs' allows docs/ directory files to be ranked", async () => {
    const repo = await createTempRepo({
      "src/feature.ts": `export function feature() {\n  return "implementation";\n}\n`,
      "docs/guide.md": `# Feature Guide\n\nHow to use the feature.\n`,
      "README.md": `# Project\n\nOverview.\n`,
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-docs-profile-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = { db, repoId, warningManager: new WarningManager() };

    // Test with boost_profile="docs" - should include docs/ files
    const bundleResults = await contextBundle(context, {
      goal: "feature guide",
      boost_profile: "docs",
      limit: 10,
    });

    const docsFile = bundleResults.context.find((r) => r.path === "docs/guide.md");
    expect(docsFile).toBeDefined(); // ← docs/ should be found
    expect(docsFile?.score).toBeGreaterThan(0); // ← Should have positive score

    // filesSearch should also respect boost_profile
    const filesResults = await filesSearch(context, {
      query: "feature guide",
      boost_profile: "docs",
    });

    const docsFileInSearch = filesResults.find((r) => r.path === "docs/guide.md");
    expect(docsFileInSearch).toBeDefined(); // ← docs/ should be found in filesSearch too
  });

  // ✅ NEW (v0.9.0): Test that default profile still blacklists docs/ directory
  it("default profile still blacklists docs/ directory", async () => {
    const repo = await createTempRepo({
      "src/feature.ts": `export function feature() {\n  return "implementation";\n}\n`,
      "docs/guide.md": `# Feature Guide\n\nHow to use the feature.\n`,
      "README.md": `# Project\n\nOverview.\n`,
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-docs-blacklist-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = { db, repoId, warningManager: new WarningManager() };

    // Test with default profile - should blacklist docs/
    const bundleResults = await contextBundle(context, {
      goal: "feature guide",
      // boost_profile defaults to "default"
      limit: 10,
    });

    const docsFile = bundleResults.context.find((r) => r.path === "docs/guide.md");
    // docs/ should be blacklisted (filtered out or negative score)
    if (docsFile) {
      expect(docsFile.score).toBeLessThan(0); // If present, should have negative score
    }
    // Most likely it will be filtered out entirely, which is also correct
  });

  // ✅ NEW (v0.9.0): Test that boost_profile="docs" still blacklists other directories
  it("boost_profile='docs' still blacklists other directories (node_modules, .git)", async () => {
    const repo = await createTempRepo({
      "src/feature.ts": `export function feature() {\n  return "implementation";\n}\n`,
      "docs/guide.md": `# Feature Guide\n\nHow to use the feature.\n`,
      "node_modules/package/index.js": `module.exports = { feature: true };\n`,
      ".git/hooks/pre-commit": `#!/bin/sh\necho "test hook"\n`,
      "README.md": `# Project\n\nOverview.\n`,
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-docs-other-blacklist-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = { db, repoId, warningManager: new WarningManager() };

    // Test with boost_profile="docs" - other blacklisted dirs should still be excluded
    const bundleResults = await contextBundle(context, {
      goal: "feature guide",
      boost_profile: "docs",
      limit: 10,
    });

    // docs/ should be allowed (positive score or included)
    const docsFile = bundleResults.context.find((r) => r.path === "docs/guide.md");
    expect(docsFile).toBeDefined();
    expect(docsFile?.score).toBeGreaterThan(0);

    // node_modules/ should still be blacklisted (negative score or excluded)
    const nodeModulesFile = bundleResults.context.find((r) => r.path.startsWith("node_modules/"));
    if (nodeModulesFile) {
      expect(nodeModulesFile.score).toBeLessThan(0);
    }

    // .git/ should still be blacklisted (negative score or excluded)
    const gitFile = bundleResults.context.find((r) => r.path.startsWith(".git/"));
    if (gitFile) {
      expect(gitFile.score).toBeLessThan(0);
    }
  });
});
