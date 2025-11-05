import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runIndexer } from "../../src/indexer/cli.js";
import { ServerContext } from "../../src/server/context.js";
import { contextBundle, resolveRepoId } from "../../src/server/handlers.js";
import { DuckDBClient } from "../../src/shared/duckdb.js";
import { createTempRepo } from "../helpers/test-repo.js";

interface CleanupTarget {
  dispose: () => Promise<void>;
}

/**
 * Tests for helper functions extracted in v0.7.0 refactoring:
 * - applyPathBasedScoring
 * - applyAdditiveFilePenalties
 * - applyFileTypeMultipliers
 *
 * Since these are internal functions, we test them through the public API
 * with carefully designed scenarios that isolate each function's behavior.
 */
describe("Boosting Helper Functions (v0.7.0+)", () => {
  const cleanupTargets: CleanupTarget[] = [];

  afterEach(async () => {
    for (const target of cleanupTargets.splice(0, cleanupTargets.length)) {
      await target.dispose();
    }
  });

  describe("applyPathBasedScoring", () => {
    it("boosts files with phrase in path by 1.5x pathMatch weight", async () => {
      const repo = await createTempRepo({
        "src/page-agent/handler.ts": `export function pageAgent() {\n  return "handler";\n}\n`,
        "src/canvas-agent/handler.ts": `export function canvasAgent() {\n  return "handler";\n}\n`,
        "src/handler.ts": `export function handler() {\n  return "generic";\n}\n`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-phrase-path-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);
      const context: ServerContext = { db, repoId };

      // Query with hyphenated phrase
      const bundle = await contextBundle(context, {
        goal: "page-agent handler implementation",
        limit: 10,
      });

      // File with "page-agent" in path should rank highest
      const pageAgentFile = bundle.context.find((item) => item.path.includes("page-agent"));
      const canvasAgentFile = bundle.context.find((item) => item.path.includes("canvas-agent"));
      const genericFile = bundle.context.find((item) => item.path === "src/handler.ts");

      expect(pageAgentFile).toBeDefined();

      // page-agent should have highest score due to phrase match in path
      if (pageAgentFile && canvasAgentFile) {
        const pageRank = bundle.context.indexOf(pageAgentFile);
        const canvasRank = bundle.context.indexOf(canvasAgentFile);
        expect(pageRank).toBeLessThan(canvasRank);
      }

      if (pageAgentFile && genericFile) {
        const pageRank = bundle.context.indexOf(pageAgentFile);
        const genericRank = bundle.context.indexOf(genericFile);
        expect(pageRank).toBeLessThan(genericRank);
      }
    });

    it("boosts files with path segment match by 1.0x pathMatch weight", async () => {
      const repo = await createTempRepo({
        "src/auth/login.ts": `export function login() {\n  return "authenticate";\n}\n`,
        "src/auth/logout.ts": `export function logout() {\n  return "signout";\n}\n`,
        "src/utils/auth-helper.ts": `export function authHelper() {\n  return "helper";\n}\n`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-segment-path-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);
      const context: ServerContext = { db, repoId };

      const bundle = await contextBundle(context, {
        goal: "auth authentication system",
        limit: 10,
      });

      // Files in "auth" directory should rank higher
      const authFiles = bundle.context.filter((item) => item.path.includes("src/auth/"));
      const helperFile = bundle.context.find((item) => item.path.includes("auth-helper"));

      expect(authFiles.length).toBeGreaterThan(0);

      // Auth directory files should rank higher than helper file
      if (authFiles.length > 0 && helperFile && authFiles[0]) {
        const authRank = bundle.context.indexOf(authFiles[0]);
        const helperRank = bundle.context.indexOf(helperFile);
        expect(authRank).toBeLessThan(helperRank);
      }
    });

    it("boosts files with keyword in path by 0.5x pathMatch weight", async () => {
      const repo = await createTempRepo({
        "src/router.ts": `export function route() {\n  return "routing";\n}\n`,
        "src/components/Nav.tsx": `export function Nav() {\n  return "navigation";\n}\n`,
        "src/utils.ts": `export function util() {\n  return "helper";\n}\n`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-keyword-path-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);
      const context: ServerContext = { db, repoId };

      const bundle = await contextBundle(context, {
        goal: "router routing system",
        limit: 10,
      });

      // File with "router" in filename should rank highest
      const routerFile = bundle.context.find((item) => item.path.includes("router"));
      const utilsFile = bundle.context.find((item) => item.path.includes("utils"));

      expect(routerFile).toBeDefined();

      if (routerFile && utilsFile) {
        const routerRank = bundle.context.indexOf(routerFile);
        const utilsRank = bundle.context.indexOf(utilsFile);
        expect(routerRank).toBeLessThan(utilsRank);
      }
    });
  });

  describe("applyAdditiveFilePenalties", () => {
    it("applies -100 penalty for blacklisted directories", async () => {
      const repo = await createTempRepo({
        ".cursor/config.json": `{"setting": "value"}\n`,
        ".devcontainer/devcontainer.json": `{"name": "test"}\n`,
        "node_modules/package/index.js": `module.exports = {};\n`,
        "dist/bundle.js": `var app = {};\n`,
        "coverage/index.html": `<html></html>\n`,
        "src/main.ts": `export function main() {}\n`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-blacklist-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);
      const context: ServerContext = { db, repoId };

      const bundle = await contextBundle(context, {
        goal: "configuration settings",
        limit: 20,
      });

      // Blacklisted directories should be filtered out
      const blacklistedFiles = bundle.context.filter(
        (item) =>
          item.path.startsWith(".cursor/") ||
          item.path.startsWith(".devcontainer/") ||
          item.path.startsWith("node_modules/") ||
          item.path.startsWith("dist/") ||
          item.path.startsWith("coverage/")
      );

      expect(blacklistedFiles.length).toBe(0); // All should be filtered
    });

    it("applies -2.0 penalty for test files", async () => {
      const repo = await createTempRepo({
        "src/feature.ts": `export function feature() {\n  return "impl";\n}\n`,
        "src/feature.spec.ts": `import { feature } from './feature';\ntest('works', () => {});\n`,
        "tests/feature.test.ts": `test('integration', () => {});\n`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-test-penalty-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);
      const context: ServerContext = { db, repoId };

      const bundle = await contextBundle(context, {
        goal: "feature implementation",
        limit: 10,
      });

      // Implementation file should rank higher than test files
      const implFile = bundle.context.find((item) => item.path === "src/feature.ts");
      const specFile = bundle.context.find((item) => item.path === "src/feature.spec.ts");
      const testFile = bundle.context.find((item) => item.path === "tests/feature.test.ts");

      expect(implFile).toBeDefined();

      if (implFile && specFile) {
        const implRank = bundle.context.indexOf(implFile);
        const specRank = bundle.context.indexOf(specFile);
        expect(implRank).toBeLessThan(specRank);
      }

      if (implFile && testFile) {
        const implRank = bundle.context.indexOf(implFile);
        const testRank = bundle.context.indexOf(testFile);
        expect(implRank).toBeLessThan(testRank);
      }
    });

    it("applies -3.0 penalty for lock files", async () => {
      const repo = await createTempRepo({
        "package-lock.json": `{"lockfileVersion": 2}\n`,
        "pnpm-lock.yaml": `lockfileVersion: 5.3\n`,
        "yarn.lock": `# yarn lockfile v1\n`,
        "package.json": `{"name": "test"}\n`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-lock-penalty-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);
      const context: ServerContext = { db, repoId };

      const bundle = await contextBundle(context, {
        goal: "package dependencies",
        limit: 10,
      });

      // Lock files should rank lower than package.json
      const packageFile = bundle.context.find((item) => item.path === "package.json");
      const lockFiles = bundle.context.filter(
        (item) =>
          item.path === "package-lock.json" ||
          item.path === "pnpm-lock.yaml" ||
          item.path === "yarn.lock"
      );

      if (packageFile && lockFiles.length > 0) {
        const packageRank = bundle.context.indexOf(packageFile);
        const lockRanks = lockFiles.map((f) => bundle.context.indexOf(f));

        // All lock files should rank lower than package.json
        lockRanks.forEach((lockRank) => {
          expect(packageRank).toBeLessThan(lockRank);
        });
      }
    });

    it("applies -1.5 penalty for config files", async () => {
      const repo = await createTempRepo({
        "tsconfig.json": `{"compilerOptions": {}}\n`,
        "vite.config.ts": `export default {};\n`,
        ".eslintrc": `{"extends": "eslint:recommended"}\n`,
        "src/config.ts": `export const config = {};\n`, // Should NOT be penalized (src/ file)
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-config-penalty-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);
      const context: ServerContext = { db, repoId };

      const bundle = await contextBundle(context, {
        goal: "configuration setup",
        limit: 10,
      });

      // src/config.ts should rank higher than root config files
      const srcConfigFile = bundle.context.find((item) => item.path === "src/config.ts");
      const rootConfigFiles = bundle.context.filter(
        (item) =>
          item.path === "tsconfig.json" ||
          item.path === "vite.config.ts" ||
          item.path === ".eslintrc"
      );

      if (srcConfigFile && rootConfigFiles.length > 0) {
        const srcRank = bundle.context.indexOf(srcConfigFile);
        const rootRanks = rootConfigFiles.map((f) => bundle.context.indexOf(f));

        // Source config should rank higher than root configs
        rootRanks.forEach((rootRank) => {
          expect(srcRank).toBeLessThan(rootRank);
        });
      }
    });

    it("applies -2.0 penalty for migration files", async () => {
      const repo = await createTempRepo({
        "db/migrate/001_create_users.sql": `CREATE TABLE users (id INT);\n`,
        "db/migrations/002_add_index.sql": `CREATE INDEX idx ON users(id);\n`,
        "src/db/schema.ts": `export const schema = {};\n`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-migration-penalty-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);
      const context: ServerContext = { db, repoId };

      const bundle = await contextBundle(context, {
        goal: "database schema",
        limit: 10,
      });

      // Schema file should rank higher than migration files
      const schemaFile = bundle.context.find((item) => item.path === "src/db/schema.ts");
      const migrationFiles = bundle.context.filter((item) => item.path.includes("migrate"));

      if (schemaFile && migrationFiles.length > 0) {
        const schemaRank = bundle.context.indexOf(schemaFile);
        const migrationRanks = migrationFiles.map((f) => bundle.context.indexOf(f));

        migrationRanks.forEach((migrationRank) => {
          expect(schemaRank).toBeLessThan(migrationRank);
        });
      }
    });
  });

  describe("applyFileTypeMultipliers", () => {
    it("applies docPenaltyMultiplier (0.3) in default profile", async () => {
      const repo = await createTempRepo({
        "src/feature.ts": `export function feature() {\n  return "impl";\n}\n`,
        "README.md": `# Feature\n\nDocumentation about the feature.\n`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-doc-multiplier-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);
      const context: ServerContext = { db, repoId };

      const bundle = await contextBundle(context, {
        goal: "feature implementation",
        limit: 10,
      });

      // Implementation file should rank much higher than README
      const implFile = bundle.context.find((item) => item.path === "src/feature.ts");
      const readmeFile = bundle.context.find((item) => item.path === "README.md");

      if (implFile && readmeFile) {
        const implRank = bundle.context.indexOf(implFile);
        const readmeRank = bundle.context.indexOf(readmeFile);
        expect(implRank).toBeLessThan(readmeRank);
      }
    });

    it("applies implBoostMultiplier (1.3) × 1.4 for src/app/ files", async () => {
      const repo = await createTempRepo({
        "src/app/page.ts": `export function page() {\n  return "app";\n}\n`,
        "src/lib/utils.ts": `export function util() {\n  return "lib";\n}\n`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-app-multiplier-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);
      const context: ServerContext = { db, repoId };

      const bundle = await contextBundle(context, {
        goal: "application page",
        limit: 10,
      });

      // App file should rank higher than lib file (1.4x vs 1.2x boost)
      const appFile = bundle.context.find((item) => item.path === "src/app/page.ts");
      const libFile = bundle.context.find((item) => item.path === "src/lib/utils.ts");

      if (appFile && libFile) {
        const appRank = bundle.context.indexOf(appFile);
        const libRank = bundle.context.indexOf(libFile);
        expect(appRank).toBeLessThan(libRank);
      }
    });

    it("skips penalties in docs profile", async () => {
      const repo = await createTempRepo({
        "src/feature.ts": `export function feature() {\n  return "impl";\n}\n`,
        "README.md": `# Feature Guide\n\nDocumentation about the feature.\n`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-docs-profile-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);
      const context: ServerContext = { db, repoId };

      const bundle = await contextBundle(context, {
        goal: "feature documentation",
        limit: 10,
        boost_profile: "docs",
      });

      // With docs profile, README should rank higher
      const implFile = bundle.context.find((item) => item.path === "src/feature.ts");
      const readmeFile = bundle.context.find((item) => item.path === "README.md");

      if (implFile && readmeFile) {
        const implRank = bundle.context.indexOf(implFile);
        const readmeRank = bundle.context.indexOf(readmeFile);
        expect(readmeRank).toBeLessThan(implRank);
      }
    });
  });
});
