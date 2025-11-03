import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runIndexer } from "../../src/indexer/cli.js";
import { ServerContext } from "../../src/server/context.js";
import { contextBundle, resolveRepoId, semanticRerank } from "../../src/server/handlers.js";
import { startServer } from "../../src/server/main.js";
import { DuckDBClient } from "../../src/shared/duckdb.js";
import { loadSecurityConfig, updateSecurityLock } from "../../src/shared/security/config.js";
import { createTempRepo } from "../helpers/test-repo.js";

interface CleanupTarget {
  dispose: () => Promise<void>;
}

describe("startServer", () => {
  it("fails fast when repository index is missing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "kiri-server-"));
    const dbPath = join(tempDir, "index.duckdb");
    const lockPath = join(tempDir, "security.lock");
    const { hash } = loadSecurityConfig();
    updateSecurityLock(hash, lockPath);

    await expect(
      startServer({
        port: 0,
        repoRoot: tempDir,
        databasePath: dbPath,
        securityLockPath: lockPath,
      })
    ).rejects.toThrow(/Target repository is missing/);

    await rm(tempDir, { recursive: true, force: true });
  });
});

describe("context.bundle", () => {
  const cleanupTargets: CleanupTarget[] = [];

  afterEach(async () => {
    for (const target of cleanupTargets.splice(0, cleanupTargets.length)) {
      await target.dispose();
    }
  });

  it("combines string matches, dependencies, and proximity", async () => {
    const repo = await createTempRepo({
      "src/auth/token.ts": `import { calculateExpiry } from "../utils/helper";\n\nexport function verifyToken(token: string): boolean {\n  if (!token) {\n    return false;\n  }\n  const expires = calculateExpiry(token);\n  return Date.now() < expires;\n}\n`,
      "src/utils/helper.ts": `export function calculateExpiry(token: string): number {\n  return token.length * 1000;\n}\n`,
      "src/auth/validator.ts": `import { verifyToken } from "./token";\n\nexport function validateToken(token: string) {\n  return verifyToken(token);\n}\n`,
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = { db, repoId };

    const bundle = await contextBundle(context, {
      goal: "Fix the token verifier expiration bug",
      artifacts: {
        editing_path: "src/auth/token.ts",
        failing_tests: ["TokenVerifier handles expiration"],
      },
      limit: 5,
    });

    expect(bundle.context.length).toBeGreaterThan(0);
    expect(bundle.tokens_estimate).toBeGreaterThan(0);

    const editing = bundle.context.find((item) => item.path === "src/auth/token.ts");
    expect(editing).toBeDefined();
    expect(editing?.why).toContain("artifact:editing_path");
    expect(editing?.why.some((reason) => reason.startsWith("structural:"))).toBe(true);

    const helper = bundle.context.find((item) => item.path === "src/utils/helper.ts");
    expect(helper).toBeDefined();
    expect(helper?.why.some((reason) => reason.startsWith("dep:"))).toBe(true);

    const nearby = bundle.context.find((item) => item.path === "src/auth/validator.ts");
    expect(nearby).toBeDefined();
    expect(nearby?.why.some((reason) => reason.startsWith("near:"))).toBe(true);
  }, 10000);

  it("rejects empty goals", async () => {
    const repo = await createTempRepo({
      "src/app.ts": "export function app() { return 1; }\n",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const serverContext: ServerContext = { db, repoId };

    await expect(contextBundle(serverContext, { goal: "" })).rejects.toThrow(/non-empty goal/);
  });

  it("handles files without pre-computed snippets using fallback generation", async () => {
    const repo = await createTempRepo({
      "README.md": "# Test Project\n\nThis is a test.\n\nMore content here.\n",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = { db, repoId };

    // README.mdはマークダウンファイルなのでスニペットが生成されない可能性が高い
    const bundle = await contextBundle(context, {
      goal: "test project documentation",
      limit: 5,
    });

    expect(bundle.context.length).toBeGreaterThan(0);
    const readme = bundle.context.find((item) => item.path === "README.md");
    expect(readme).toBeDefined();
    expect(readme?.range).toBeDefined();
    expect(readme?.preview.length).toBeGreaterThan(0);
  });

  it("handles CJK and emoji-rich keywords gracefully", async () => {
    const repo = await createTempRepo({
      "src/日本語.ts": "// 日本語コメント\nexport function 処理() { return '成功'; }\n",
      "src/emoji.ts": "// 🐛 Bug fix\nexport function fix🔧() { return 'fixed'; }\n",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = { db, repoId };

    // CJK文字とemojiを含むゴールでも正常動作することを確認
    const bundle = await contextBundle(context, {
      goal: "修正 bug🐛 を fix する",
      limit: 5,
    });

    // キーワード抽出が失敗してもエラーにならず、空の結果が返ることを確認
    expect(bundle.context).toBeDefined();
    expect(Array.isArray(bundle.context)).toBe(true);
  }, 15000);

  it("respects MAX_DEPENDENCY_SEEDS_QUERY_LIMIT for security", async () => {
    // 大量の依存関係シードを持つケースをシミュレート
    // 実際には内部制限により、MAX_DEPENDENCY_SEEDS (8) までしか使われない
    const files: Record<string, string> = {};
    for (let i = 0; i < 15; i++) {
      files[`src/file${i}.ts`] = `export function func${i}() { return ${i}; }\n`;
    }

    const repo = await createTempRepo(files);
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = { db, repoId };

    // 多くのファイルにマッチするが、依存関係シードは内部で制限される
    const bundle = await contextBundle(context, {
      goal: "func return",
      limit: 10,
    });

    expect(bundle.context).toBeDefined();
    // エラーが発生せず正常に完了することを確認
    expect(bundle.context.length).toBeGreaterThan(0);
  });

  it("reorders candidates using semantic similarity weights", async () => {
    const repo = await createTempRepo({
      "src/auth/login.ts": `export function loginUser(user: string, password: string) {\n  const authenticated = password === "secret";\n  if (!authenticated) {\n    throw new Error("authentication failed");\n  }\n  return { status: "ok", user };\n}\n`,
      "src/ui/dashboard.ts": `export function renderDashboard() {\n  return "dashboard";\n}\n`,
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = { db, repoId };

    const reranked = await semanticRerank(context, {
      text: "investigate login authentication failure",
      candidates: [
        { path: "src/ui/dashboard.ts", score: 0.4 },
        { path: "src/auth/login.ts", score: 0.4 },
      ],
    });

    expect(reranked.candidates.length).toBeGreaterThan(0);
    expect(reranked.candidates[0]?.path).toBe("src/auth/login.ts");
    expect(reranked.candidates[0]?.semantic ?? 0).toBeGreaterThan(
      reranked.candidates[1]?.semantic ?? 0
    );
    expect(reranked.candidates[0]?.combined ?? 0).toBeGreaterThan(0.4);
  });

  it("rejects semantic rerank without text", async () => {
    const repo = await createTempRepo({
      "src/sample.ts": "export const value = 1;\n",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = { db, repoId };

    await expect(
      semanticRerank(context, { text: "", candidates: [{ path: "src/sample.ts", score: 0.1 }] })
    ).rejects.toThrow(/non-empty text/);
  });

  it("rejects malicious file paths with SQL injection attempts", async () => {
    const repo = await createTempRepo({
      "src/safe.ts": "export const value = 1;\n",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = { db, repoId };

    // 悪意のあるパスを含むeditingPathをテスト
    await expect(
      contextBundle(context, {
        goal: "test",
        artifacts: {
          editing_path: "src/file'; DROP TABLE file; --",
        },
      })
    ).rejects.toThrow(/Invalid editing_path format/);
  });

  it("handles empty files gracefully", async () => {
    const repo = await createTempRepo({
      "empty.txt": "",
      "src/code.ts": "export const x = 1;\n",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = { db, repoId };

    const bundle = await contextBundle(context, {
      goal: "find code",
      limit: 5,
    });

    expect(bundle.context).toBeDefined();
    expect(Array.isArray(bundle.context)).toBe(true);
  });

  it("filters out test files, config files, and lock files", async () => {
    const repo = await createTempRepo({
      "src/auth/login.ts": `export function login(user: string) {\n  return { status: "ok", user };\n}\n`,
      "src/auth/login.spec.ts": `import { login } from "./login";\n\ntest("login works", () => {\n  expect(login("test")).toBeDefined();\n});\n`,
      "src/auth/login.test.ts": `import { login } from "./login";\n\ntest("another test", () => {\n  expect(login("test2")).toBeDefined();\n});\n`,
      "package.json": `{\n  "name": "test",\n  "version": "1.0.0"\n}\n`,
      "package-lock.json": `{\n  "name": "test",\n  "lockfileVersion": 3\n}\n`,
      "pnpm-lock.yaml": `lockfileVersion: '9.0'\n`,
      "tsconfig.json": `{\n  "compilerOptions": {}\n}\n`,
      "vite.config.ts": `export default {};\n`,
      ".env": `SECRET=test\n`,
      Dockerfile: `FROM node:20\n`,
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = { db, repoId };

    const bundle = await contextBundle(context, {
      goal: "user authentication login implementation",
      limit: 10,
    });

    expect(bundle.context.length).toBeGreaterThan(0);

    // Implementation file should be included
    const loginFile = bundle.context.find((item) => item.path === "src/auth/login.ts");
    expect(loginFile).toBeDefined();

    // Test files should be filtered out
    const specFile = bundle.context.find((item) => item.path === "src/auth/login.spec.ts");
    expect(specFile).toBeUndefined();

    const testFile = bundle.context.find((item) => item.path === "src/auth/login.test.ts");
    expect(testFile).toBeUndefined();

    // Lock files should be filtered out
    const packageLock = bundle.context.find((item) => item.path === "package-lock.json");
    expect(packageLock).toBeUndefined();

    const pnpmLock = bundle.context.find((item) => item.path === "pnpm-lock.yaml");
    expect(pnpmLock).toBeUndefined();

    // Config files should be filtered out
    const tsconfig = bundle.context.find((item) => item.path === "tsconfig.json");
    expect(tsconfig).toBeUndefined();

    const viteConfig = bundle.context.find((item) => item.path === "vite.config.ts");
    expect(viteConfig).toBeUndefined();

    const packageJson = bundle.context.find((item) => item.path === "package.json");
    expect(packageJson).toBeUndefined();

    const env = bundle.context.find((item) => item.path === ".env");
    expect(env).toBeUndefined();

    const dockerfile = bundle.context.find((item) => item.path === "Dockerfile");
    expect(dockerfile).toBeUndefined();
  });

  it("filters out blacklisted directories (config, dist, coverage, migrations)", async () => {
    const repo = await createTempRepo({
      "src/core/app.ts": `export function main() {\n  return "app";\n}\n`,
      "config/settings.ts": `export const config = { debug: true };\n`,
      "dist/bundle.js": `console.log("bundled");\n`,
      "coverage/report.txt": `Coverage: 80%\n`,
      "db/migrate/001_init.sql": `CREATE TABLE users (id INT);\n`,
      "db/migrations/002_add_email.sql": `ALTER TABLE users ADD COLUMN email TEXT;\n`,
      "build/output.js": `console.log("output");\n`,
      ".vscode/settings.json": `{ "editor.tabSize": 2 }\n`,
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = { db, repoId };

    const bundle = await contextBundle(context, {
      goal: "application main function settings config",
      limit: 10,
    });

    expect(bundle.context.length).toBeGreaterThan(0);

    // Implementation file should be included
    const appFile = bundle.context.find((item) => item.path === "src/core/app.ts");
    expect(appFile).toBeDefined();

    // Blacklisted directories should be filtered out
    const configFile = bundle.context.find((item) => item.path === "config/settings.ts");
    expect(configFile).toBeUndefined();

    const distFile = bundle.context.find((item) => item.path === "dist/bundle.js");
    expect(distFile).toBeUndefined();

    const coverageFile = bundle.context.find((item) => item.path === "coverage/report.txt");
    expect(coverageFile).toBeUndefined();

    const migration1 = bundle.context.find((item) => item.path === "db/migrate/001_init.sql");
    expect(migration1).toBeUndefined();

    const migration2 = bundle.context.find(
      (item) => item.path === "db/migrations/002_add_email.sql"
    );
    expect(migration2).toBeUndefined();

    const buildFile = bundle.context.find((item) => item.path === "build/output.js");
    expect(buildFile).toBeUndefined();

    const vscodeFile = bundle.context.find((item) => item.path === ".vscode/settings.json");
    expect(vscodeFile).toBeUndefined();
  });

  it("prioritizes implementation files over documentation with adjusted weights", async () => {
    const repo = await createTempRepo({
      "src/app/router.ts": `export function route(path: string) {\n  return { path, component: "Page" };\n}\n`,
      "README.md": `# Routing Guide\n\nThis explains the routing system and navigation patterns.\n`,
      "docs/routing.md": `# URL Patterns\n\nHow to access canvas pages through routing.\n`,
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = { db, repoId };

    const bundle = await contextBundle(context, {
      goal: "Canvas page routing, URL patterns, navigation methods",
      limit: 10,
    });

    expect(bundle.context.length).toBeGreaterThan(0);

    // Implementation file should rank higher
    const routerFile = bundle.context.find((item) => item.path === "src/app/router.ts");
    expect(routerFile).toBeDefined();

    // If docs are included, they should rank lower
    const readmeFile = bundle.context.find((item) => item.path === "README.md");
    const docsFile = bundle.context.find((item) => item.path === "docs/routing.md");

    if (routerFile && readmeFile) {
      const routerIndex = bundle.context.indexOf(routerFile);
      const readmeIndex = bundle.context.indexOf(readmeFile);
      expect(routerIndex).toBeLessThan(readmeIndex);
    }

    if (routerFile && docsFile) {
      const routerIndex = bundle.context.indexOf(routerFile);
      const docsIndex = bundle.context.indexOf(docsFile);
      expect(routerIndex).toBeLessThan(docsIndex);
    }
  });
});
