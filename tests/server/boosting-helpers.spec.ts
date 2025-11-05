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

    it("applies configPenaltyMultiplier (0.05 = 95% penalty) to config files", async () => {
      const repo = await createTempRepo({
        "src/feature.ts": `export function feature() {\n  return "implementation";\n}\n`,
        "package.json": `{"name": "test", "version": "1.0.0"}\n`,
        "tsconfig.json": `{"compilerOptions": {"strict": true}}\n`,
        "README.md": `# Feature\n\nDocumentation\n`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-config-multiplier-"));
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

      // Verify ranking: implementation > docs > config files
      const implFile = bundle.context.find((item) => item.path === "src/feature.ts");
      const readmeFile = bundle.context.find((item) => item.path === "README.md");
      const packageFile = bundle.context.find((item) => item.path === "package.json");
      const tsconfigFile = bundle.context.find((item) => item.path === "tsconfig.json");

      if (implFile && readmeFile && packageFile && tsconfigFile) {
        const implRank = bundle.context.indexOf(implFile);
        const readmeRank = bundle.context.indexOf(readmeFile);
        const packageRank = bundle.context.indexOf(packageFile);
        const tsconfigRank = bundle.context.indexOf(tsconfigFile);

        // Implementation should rank highest
        expect(implRank).toBeLessThan(readmeRank);
        expect(implRank).toBeLessThan(packageRank);
        expect(implRank).toBeLessThan(tsconfigRank);

        // README (doc penalty 50%) should rank higher than config files (config penalty 95%)
        expect(readmeRank).toBeLessThan(packageRank);
        expect(readmeRank).toBeLessThan(tsconfigRank);
      }
    });

    it("separates doc files (.md) from config files (.json) with different penalties", async () => {
      const repo = await createTempRepo({
        "src/handler.ts": `export function handle() {\n  return "handler";\n}\n`,
        "docs/guide.md": `# Guide\n\nHow to use this\n`,
        "config.yaml": `key: value\n`,
        "package.json": `{"name": "test"}\n`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-doc-config-separation-"));
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
        goal: "handler guide config",
        limit: 10,
      });

      const implFile = bundle.context.find((item) => item.path === "src/handler.ts");
      const mdFile = bundle.context.find((item) => item.path === "docs/guide.md");
      const yamlFile = bundle.context.find((item) => item.path === "config.yaml");
      const jsonFile = bundle.context.find((item) => item.path === "package.json");

      if (implFile && mdFile && yamlFile && jsonFile) {
        const implRank = bundle.context.indexOf(implFile);
        const mdRank = bundle.context.indexOf(mdFile);
        const yamlRank = bundle.context.indexOf(yamlFile);
        const jsonRank = bundle.context.indexOf(jsonFile);

        // Implementation > docs > config files
        expect(implRank).toBeLessThan(mdRank);
        expect(mdRank).toBeLessThan(yamlRank);
        expect(mdRank).toBeLessThan(jsonRank);
      }
    });

    it("does not penalize implementation files (no false positives)", async () => {
      const repo = await createTempRepo({
        "src/auth/handler.ts": `export function authenticate() {\n  console.log("authenticate handler");\n  return "auth";\n}\n`,
        "src/components/Button.tsx": `export const Button = () => {\n  console.log("button component");\n  return <button>Click</button>;\n}\n`,
        "src/lib/formatter.ts": `export function formatData() {\n  console.log("format data");\n  return "formatted";\n}\n`,
        "package.json": `{"name": "test"}\n`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-impl-no-penalty-"));
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
        goal: "authenticate button formatData handler component",
        limit: 10,
      });

      const authFile = bundle.context.find((item) => item.path === "src/auth/handler.ts");
      const buttonFile = bundle.context.find((item) => item.path === "src/components/Button.tsx");
      const formatterFile = bundle.context.find((item) => item.path === "src/lib/formatter.ts");
      const configFile = bundle.context.find((item) => item.path === "package.json");

      // All implementation files should be found
      expect(authFile).toBeDefined();
      expect(buttonFile).toBeDefined();
      expect(formatterFile).toBeDefined();

      if (authFile && buttonFile && formatterFile && configFile) {
        const authRank = bundle.context.indexOf(authFile);
        const buttonRank = bundle.context.indexOf(buttonFile);
        const formatterRank = bundle.context.indexOf(formatterFile);
        const configRank = bundle.context.indexOf(configFile);

        // All implementation files should rank higher than config files
        expect(authRank).toBeLessThan(configRank);
        expect(buttonRank).toBeLessThan(configRank);
        expect(formatterRank).toBeLessThan(configRank);

        // Implementation files should not have penalty reasons
        expect(authFile.why.some((reason) => reason.startsWith("penalty:"))).toBe(false);
        expect(buttonFile.why.some((reason) => reason.startsWith("penalty:"))).toBe(false);
        expect(formatterFile.why.some((reason) => reason.startsWith("penalty:"))).toBe(false);

        // Config file should have penalty reason
        expect(configFile.why.some((reason) => reason === "penalty:config-file")).toBe(true);
      }
    });

    it("does not treat paths with config-like segments as config files", async () => {
      const repo = await createTempRepo({
        "src/config/database.ts": `export const dbConfig = { host: "localhost" };\n`,
        "src/config/settings.ts": `export const settings = { debug: true };\n`,
        "config/app.config.js": `module.exports = { name: "app" };\n`,
        "tsconfig.json": `{"compilerOptions": {}}\n`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-path-segment-"));
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
        goal: "database settings config",
        limit: 10,
      });

      const databaseFile = bundle.context.find((item) => item.path === "src/config/database.ts");
      const settingsFile = bundle.context.find((item) => item.path === "src/config/settings.ts");
      const appConfigFile = bundle.context.find((item) => item.path === "config/app.config.js");
      const tsconfigFile = bundle.context.find((item) => item.path === "tsconfig.json");

      if (databaseFile && settingsFile && appConfigFile && tsconfigFile) {
        const databaseRank = bundle.context.indexOf(databaseFile);
        const settingsRank = bundle.context.indexOf(settingsFile);
        const appConfigRank = bundle.context.indexOf(appConfigFile);
        const tsconfigRank = bundle.context.indexOf(tsconfigFile);

        // Implementation files in /config/ directory should rank higher than actual config files
        expect(databaseRank).toBeLessThan(appConfigRank);
        expect(databaseRank).toBeLessThan(tsconfigRank);
        expect(settingsRank).toBeLessThan(appConfigRank);
        expect(settingsRank).toBeLessThan(tsconfigRank);

        // Implementation files should not have config penalty
        expect(databaseFile.why.some((reason) => reason === "penalty:config-file")).toBe(false);
        expect(settingsFile.why.some((reason) => reason === "penalty:config-file")).toBe(false);

        // Actual config files should have penalty
        expect(appConfigFile.why.some((reason) => reason === "penalty:config-file")).toBe(true);
        expect(tsconfigFile.why.some((reason) => reason === "penalty:config-file")).toBe(true);
      }
    });

    it("applies penalty to config files from multiple languages (Python, Ruby, Go, Rust, etc.)", async () => {
      const repo = await createTempRepo({
        "src/main.py": `def main():\n    print("main function")\n`,
        "requirements.txt": `flask==2.0.0\n`,
        "pyproject.toml": `[tool.poetry]\nname = "test"\n`,
        Gemfile: `source "https://rubygems.org"\ngem "rails"\n`,
        "go.mod": `module example.com/test\n`,
        "Cargo.toml": `[package]\nname = "test"\n`,
        "docker-compose.yml": `version: "3"\n`,
        Dockerfile: `FROM node:18\n`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-multilang-config-"));
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
        goal: "main function requirements gemfile cargo docker",
        limit: 10,
      });

      const implFile = bundle.context.find((item) => item.path === "src/main.py");
      const pythonReqFile = bundle.context.find((item) => item.path === "requirements.txt");
      const pythonTomlFile = bundle.context.find((item) => item.path === "pyproject.toml");
      const gemFile = bundle.context.find((item) => item.path === "Gemfile");
      const goModFile = bundle.context.find((item) => item.path === "go.mod");
      const cargoFile = bundle.context.find((item) => item.path === "Cargo.toml");
      const dockerComposeFile = bundle.context.find((item) => item.path === "docker-compose.yml");
      const dockerFile = bundle.context.find((item) => item.path === "Dockerfile");

      // Implementation file should be found
      expect(implFile).toBeDefined();

      if (implFile) {
        const implRank = bundle.context.indexOf(implFile);

        // All config files found should rank lower than implementation file
        if (pythonReqFile) {
          expect(implRank).toBeLessThan(bundle.context.indexOf(pythonReqFile));
          expect(pythonReqFile.why.some((reason) => reason === "penalty:config-file")).toBe(true);
        }
        if (pythonTomlFile) {
          expect(implRank).toBeLessThan(bundle.context.indexOf(pythonTomlFile));
          expect(pythonTomlFile.why.some((reason) => reason === "penalty:config-file")).toBe(true);
        }
        if (gemFile) {
          expect(implRank).toBeLessThan(bundle.context.indexOf(gemFile));
          expect(gemFile.why.some((reason) => reason === "penalty:config-file")).toBe(true);
        }
        if (goModFile) {
          expect(implRank).toBeLessThan(bundle.context.indexOf(goModFile));
          expect(goModFile.why.some((reason) => reason === "penalty:config-file")).toBe(true);
        }
        if (cargoFile) {
          expect(implRank).toBeLessThan(bundle.context.indexOf(cargoFile));
          expect(cargoFile.why.some((reason) => reason === "penalty:config-file")).toBe(true);
        }
        if (dockerComposeFile) {
          expect(implRank).toBeLessThan(bundle.context.indexOf(dockerComposeFile));
          expect(dockerComposeFile.why.some((reason) => reason === "penalty:config-file")).toBe(
            true
          );
        }
        if (dockerFile) {
          expect(implRank).toBeLessThan(bundle.context.indexOf(dockerFile));
          expect(dockerFile.why.some((reason) => reason === "penalty:config-file")).toBe(true);
        }

        // Implementation file should not have config penalty
        expect(implFile.why.some((reason) => reason === "penalty:config-file")).toBe(false);
      }
    });

    it("applies penalty to non-.lock extension lock files (npm-shrinkwrap.json, Package.resolved, packages.lock.json)", async () => {
      const repo = await createTempRepo({
        "src/app.swift": `import Foundation\n\nfunc main() {\n    print("Hello")\n}\n`,
        "src/Program.cs": `using System;\n\nclass Program {\n    static void Main() {\n        Console.WriteLine("Hello");\n    }\n}\n`,
        "src/index.js": `console.log("Hello");\n`,
        "npm-shrinkwrap.json": `{"name": "test", "lockfileVersion": 2}\n`,
        "Package.resolved": `{"pins": []}\n`,
        "packages.lock.json": `{"version": 1}\n`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-lock-files-"));
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
        goal: "main hello swift program console",
        limit: 10,
      });

      const swiftFile = bundle.context.find((item) => item.path === "src/app.swift");
      const csFile = bundle.context.find((item) => item.path === "src/Program.cs");
      const jsFile = bundle.context.find((item) => item.path === "src/index.js");
      const shrinkwrapFile = bundle.context.find((item) => item.path === "npm-shrinkwrap.json");
      const packageResolvedFile = bundle.context.find((item) => item.path === "Package.resolved");
      const packagesLockFile = bundle.context.find((item) => item.path === "packages.lock.json");

      // Implementation files should be found
      expect(swiftFile).toBeDefined();
      expect(csFile).toBeDefined();
      expect(jsFile).toBeDefined();

      if (swiftFile && csFile && jsFile) {
        const swiftRank = bundle.context.indexOf(swiftFile);
        const csRank = bundle.context.indexOf(csFile);
        const jsRank = bundle.context.indexOf(jsFile);

        // All lock files found should rank lower than implementation files
        if (shrinkwrapFile) {
          expect(swiftRank).toBeLessThan(bundle.context.indexOf(shrinkwrapFile));
          expect(csRank).toBeLessThan(bundle.context.indexOf(shrinkwrapFile));
          expect(jsRank).toBeLessThan(bundle.context.indexOf(shrinkwrapFile));
          expect(shrinkwrapFile.why.some((reason) => reason === "penalty:config-file")).toBe(true);
        }
        if (packageResolvedFile) {
          expect(swiftRank).toBeLessThan(bundle.context.indexOf(packageResolvedFile));
          expect(csRank).toBeLessThan(bundle.context.indexOf(packageResolvedFile));
          expect(jsRank).toBeLessThan(bundle.context.indexOf(packageResolvedFile));
          expect(packageResolvedFile.why.some((reason) => reason === "penalty:config-file")).toBe(
            true
          );
        }
        if (packagesLockFile) {
          expect(swiftRank).toBeLessThan(bundle.context.indexOf(packagesLockFile));
          expect(csRank).toBeLessThan(bundle.context.indexOf(packagesLockFile));
          expect(jsRank).toBeLessThan(bundle.context.indexOf(packagesLockFile));
          expect(packagesLockFile.why.some((reason) => reason === "penalty:config-file")).toBe(
            true
          );
        }

        // Implementation files should not have config penalty
        expect(swiftFile.why.some((reason) => reason === "penalty:config-file")).toBe(false);
        expect(csFile.why.some((reason) => reason === "penalty:config-file")).toBe(false);
        expect(jsFile.why.some((reason) => reason === "penalty:config-file")).toBe(false);
      }
    });

    it("applies penalty to files in config directories (bootstrap/, config/, migrations/, locales/)", async () => {
      const repo = await createTempRepo({
        "src/controllers/UserController.php": `<?php\nclass UserController {\n    public function index() {}\n}\n`,
        "bootstrap/app.php": `<?php\nreturn Application::configure();\n`,
        "config/database.php": `<?php\nreturn ['default' => 'mysql'];\n`,
        "migrations/2024_create_users.php": `<?php\nSchema::create('users');\n`,
        "locales/en.json": `{"hello": "Hello"}\n`,
        Caddyfile: `example.com {\n    reverse_proxy localhost:3000\n}\n`,
        "nginx.conf": `server {\n    listen 80;\n}\n`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-config-dirs-"));
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
        goal: "user controller bootstrap config database migration locales caddy nginx",
        limit: 15,
      });

      const controllerFile = bundle.context.find(
        (item) => item.path === "src/controllers/UserController.php"
      );
      const bootstrapFile = bundle.context.find((item) => item.path === "bootstrap/app.php");
      const configFile = bundle.context.find((item) => item.path === "config/database.php");
      const migrationFile = bundle.context.find(
        (item) => item.path === "migrations/2024_create_users.php"
      );
      const localeFile = bundle.context.find((item) => item.path === "locales/en.json");
      const caddyFile = bundle.context.find((item) => item.path === "Caddyfile");
      const nginxFile = bundle.context.find((item) => item.path === "nginx.conf");

      // Implementation file should be found
      expect(controllerFile).toBeDefined();

      if (controllerFile) {
        const controllerRank = bundle.context.indexOf(controllerFile);

        // All config directory files should rank lower than implementation
        if (bootstrapFile) {
          expect(controllerRank).toBeLessThan(bundle.context.indexOf(bootstrapFile));
          expect(bootstrapFile.why.some((reason) => reason === "penalty:config-file")).toBe(true);
        }
        if (configFile) {
          expect(controllerRank).toBeLessThan(bundle.context.indexOf(configFile));
          expect(configFile.why.some((reason) => reason === "penalty:config-file")).toBe(true);
        }
        if (migrationFile) {
          expect(controllerRank).toBeLessThan(bundle.context.indexOf(migrationFile));
          expect(migrationFile.why.some((reason) => reason === "penalty:config-file")).toBe(true);
        }
        if (localeFile) {
          expect(controllerRank).toBeLessThan(bundle.context.indexOf(localeFile));
          expect(localeFile.why.some((reason) => reason === "penalty:config-file")).toBe(true);
        }
        if (caddyFile) {
          expect(controllerRank).toBeLessThan(bundle.context.indexOf(caddyFile));
          expect(caddyFile.why.some((reason) => reason === "penalty:config-file")).toBe(true);
        }
        if (nginxFile) {
          expect(controllerRank).toBeLessThan(bundle.context.indexOf(nginxFile));
          expect(nginxFile.why.some((reason) => reason === "penalty:config-file")).toBe(true);
        }

        // Implementation file should not have config penalty
        expect(controllerFile.why.some((reason) => reason === "penalty:config-file")).toBe(false);
      }
    });
  });
});
