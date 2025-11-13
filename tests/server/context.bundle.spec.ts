import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runIndexer } from "../../src/indexer/cli.js";
import { ServerContext } from "../../src/server/context.js";
import { contextBundle, resolveRepoId, semanticRerank } from "../../src/server/handlers.js";
import { startServer } from "../../src/server/main.js";
import { WarningManager } from "../../src/server/rpc.js";
import { createServerServices } from "../../src/server/services/index.js";
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
    ).rejects.toThrow(/was not indexed/);

    await rm(tempDir, { recursive: true, force: true });
  });
});

describe("context_bundle", () => {
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
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      warningManager: new WarningManager(),
    };

    const bundle = await contextBundle(context, {
      goal: "Fix the token verifier expiration bug",
      artifacts: {
        editing_path: "src/auth/token.ts",
        failing_tests: ["TokenVerifier handles expiration"],
      },
      limit: 5,
      includeTokensEstimate: true,
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

  it("promotes files via artifact hints when the goal lacks concrete keywords", async () => {
    const repo = await createTempRepo({
      "src/stats/rank-biserial.ts": `export function rankBiserialEffect(sampleA: number[], sampleB: number[]): number {
  const total = sampleA.reduce((acc, value) => acc + value, 0) - sampleB.reduce((acc, value) => acc + value, 0);
  return total / Math.max(1, sampleA.length + sampleB.length);
}
`,
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-hints-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      warningManager: new WarningManager(),
    };

    const goal = "Investigate mann whitney u behavior";
    const withoutHints = await contextBundle(context, {
      goal,
      limit: 5,
    });
    expect(
      withoutHints.context.find((item) => item.path === "src/stats/rank-biserial.ts")
    ).toBeUndefined();

    const withHints = await contextBundle(context, {
      goal,
      limit: 5,
      artifacts: {
        hints: ["rankBiserialEffect", "src/stats/rank-biserial.ts"],
      },
    });

    const hinted = withHints.context.find((item) => item.path === "src/stats/rank-biserial.ts");
    expect(hinted).toBeDefined();
    expect(hinted?.why).toContain("artifact:hint:src/stats/rank-biserial.ts");
  }, 10000);

  it("skips tokens_estimate calculation unless requested", async () => {
    const repo = await createTempRepo({
      "src/app.ts": "export function app() { return 1; }\n",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-no-tokens-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      warningManager: new WarningManager(),
    };

    const bundle = await contextBundle(context, {
      goal: "investigate app",
      limit: 3,
    });

    expect(bundle.tokens_estimate).toBeUndefined();
    expect(bundle.context.length).toBeGreaterThan(0);
  });

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
    const serverContext: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      warningManager: new WarningManager(),
    };

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
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      warningManager: new WarningManager(),
    };

    // README.mdはマークダウンファイルなのでスニペットが生成されない可能性が高い
    const bundle = await contextBundle(context, {
      goal: "test project documentation",
      limit: 5,
      boost_profile: "docs", // Explicitly search for documentation
    });

    expect(bundle.context.length).toBeGreaterThan(0);
    const readme = bundle.context.find((item) => item.path === "README.md");
    expect(readme).toBeDefined();
    expect(readme?.range).toBeDefined();
    const preview = readme?.preview ?? "";
    expect(preview.length).toBeGreaterThan(0);
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
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      warningManager: new WarningManager(),
    };

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
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      warningManager: new WarningManager(),
    };

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
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      warningManager: new WarningManager(),
    };

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
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      warningManager: new WarningManager(),
    };

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
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      warningManager: new WarningManager(),
    };

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
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      warningManager: new WarningManager(),
    };

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
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      warningManager: new WarningManager(),
    };

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
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      warningManager: new WarningManager(),
    };

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
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      warningManager: new WarningManager(),
    };

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

  it("preserves hyphenated terms like 'page-agent' and prioritizes matching paths", async () => {
    const repo = await createTempRepo({
      "lambda/page-agent/src/handler.ts": `export function handlePageAgent() {\n  return "page-agent handler";\n}\n`,
      "lambda/page-agent/src/runtime.ts": `export function pageAgentRuntime() {\n  return "runtime";\n}\n`,
      "lambda/canvas-agent/src/handler.ts": `export function handleCanvasAgent() {\n  return "canvas-agent handler";\n}\n`,
      "lambda/ai/handlers/PageEditHandler.ts": `export class PageEditHandler {\n  handle() {\n    return "page edit";\n  }\n}\n`,
      "src/page/viewer.ts": `export function viewPage() {\n  return "page viewer";\n}\n`,
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      warningManager: new WarningManager(),
    };

    const bundle = await contextBundle(context, {
      goal: "page-agent Lambda handler implementation",
      limit: 10,
    });

    expect(bundle.context.length).toBeGreaterThan(0);

    // page-agent ディレクトリのファイルが最上位にランクされるべき
    const pageAgentHandler = bundle.context.find(
      (item) => item.path === "lambda/page-agent/src/handler.ts"
    );
    expect(pageAgentHandler).toBeDefined();
    expect(pageAgentHandler?.why.some((reason) => reason.includes("phrase:page-agent"))).toBe(true);

    // path-based matchingでブーストされるべき
    const hasPathMatch = pageAgentHandler?.why.some(
      (reason) => reason.startsWith("path-phrase:") || reason.startsWith("path-segment:")
    );
    expect(hasPathMatch).toBe(true);

    // canvas-agent は含まれるべきでない、または page-agent より下位にランクされるべき
    const canvasAgentHandler = bundle.context.find(
      (item) => item.path === "lambda/canvas-agent/src/handler.ts"
    );
    if (canvasAgentHandler && pageAgentHandler) {
      const pageAgentIndex = bundle.context.indexOf(pageAgentHandler);
      const canvasAgentIndex = bundle.context.indexOf(canvasAgentHandler);
      expect(pageAgentIndex).toBeLessThan(canvasAgentIndex);
    }
  }, 15000);

  it("supports hyphenated terms as phrases and path matching", async () => {
    const repo = await createTempRepo({
      "src/auth/oauth-handler.ts": `export function handleOAuth() {\n  return "oauth-handler implementation";\n}\n`,
      "src/auth/password-handler.ts": `export function handlePassword() {\n  return "password auth";\n}\n`,
      "src/utils/helper.ts": `export function formatOAuth() {\n  return "helper OAuth";\n}\n`,
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      warningManager: new WarningManager(),
    };

    // ハイフン区切り用語を使用（引用符なし）
    const bundle = await contextBundle(context, {
      goal: "oauth-handler authentication implementation",
      limit: 10,
    });

    expect(bundle.context.length).toBeGreaterThan(0);

    // oauth-handler.ts が最上位にランクされるべき
    const oauthHandler = bundle.context.find((item) => item.path === "src/auth/oauth-handler.ts");
    expect(oauthHandler).toBeDefined();

    // フレーズマッチまたはパスマッチの理由が含まれるべき
    const hasMatch =
      oauthHandler?.why.some((reason) => reason.startsWith("phrase:")) ||
      oauthHandler?.why.some((reason) => reason.startsWith("path-"));
    expect(hasMatch).toBe(true);
  }, 15000);

  it("applies path-based scoring boost when keywords appear in file paths", async () => {
    const repo = await createTempRepo({
      "src/features/user-profile/handler.ts": `export function handleProfile() {\n  return "profile handler";\n}\n`,
      "src/features/user-profile/service.ts": `export function profileService() {\n  return "service";\n}\n`,
      "src/utils/profile.ts": `export function formatProfile() {\n  return "formatter";\n}\n`,
      "tests/profile.spec.ts": `test("profile works", () => {});\n`,
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      warningManager: new WarningManager(),
    };

    const bundle = await contextBundle(context, {
      goal: "user-profile handler implementation",
      limit: 10,
    });

    expect(bundle.context.length).toBeGreaterThan(0);

    // user-profile ディレクトリのファイルがパスマッチでブーストされるべき
    const profileHandler = bundle.context.find(
      (item) => item.path === "src/features/user-profile/handler.ts"
    );
    expect(profileHandler).toBeDefined();

    // path-based boostingの理由が含まれるべき
    const hasPathBoost = profileHandler?.why.some(
      (reason) =>
        reason.startsWith("path-phrase:") ||
        reason.startsWith("path-segment:") ||
        reason.startsWith("path-keyword:")
    );
    expect(hasPathBoost).toBe(true);

    // user-profileディレクトリ内のファイルがディレクトリ外のファイルより上位にランクされるべき
    const utilsProfile = bundle.context.find((item) => item.path === "src/utils/profile.ts");
    if (utilsProfile && profileHandler) {
      const handlerIndex = bundle.context.indexOf(profileHandler);
      const utilsIndex = bundle.context.indexOf(utilsProfile);
      expect(handlerIndex).toBeLessThan(utilsIndex);
    }
  }, 15000);

  it("reduces structural similarity weight to prevent false positives", async () => {
    const repo = await createTempRepo({
      "src/auth/login-handler.ts": `// login-handler implementation for user authentication\nexport function handleLogin(credentials: { user: string, pass: string }) {\n  const authenticated = verifyCredentials(credentials);\n  if (!authenticated) {\n    throw new Error("Login failed");\n  }\n  return { success: true };\n}\n\nfunction verifyCredentials(creds: { user: string, pass: string }): boolean {\n  return creds.pass.length > 8;\n}\n`,
      "src/auth/logout-handler.ts": `// logout-handler implementation for session termination\nexport function handleLogout(sessionId: string) {\n  const session = findSession(sessionId);\n  if (!session) {\n    throw new Error("Logout failed");\n  }\n  return { success: true };\n}\n\nfunction findSession(id: string): unknown {\n  return {};\n}\n`,
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      warningManager: new WarningManager(),
    };

    // "login-handler" を検索して、構造的に似ている "logout-handler" が
    // 誤ってマッチしないことを確認
    const bundle = await contextBundle(context, {
      goal: "login-handler user authentication",
      limit: 10,
    });

    expect(bundle.context.length).toBeGreaterThan(0);

    // login-handler が最上位にランクされるべき
    const loginHandler = bundle.context.find((item) => item.path === "src/auth/login-handler.ts");
    expect(loginHandler).toBeDefined();

    // logout-handler は含まれるべきでない、またはランクが低いべき
    const logoutHandler = bundle.context.find((item) => item.path === "src/auth/logout-handler.ts");
    if (logoutHandler && loginHandler) {
      const loginIndex = bundle.context.indexOf(loginHandler);
      const logoutIndex = bundle.context.indexOf(logoutHandler);
      expect(loginIndex).toBeLessThan(logoutIndex);

      // 構造的類似度による誤ったブーストが過度でないことを確認
      const loginScore = loginHandler.score;
      const logoutScore = logoutHandler.score;
      expect(loginScore).toBeGreaterThan(logoutScore);
    }
  }, 15000);

  // Regression test for original reported issue
  it("correctly ranks lambda/page-agent over canvas-agent and legacy handlers", async () => {
    const repo = await createTempRepo({
      "lambda/page-agent/src/handler.ts": `
// Lambda handler for page-agent
export async function handlePageAgent(event: any) {
  console.log("Processing page agent request");
  return { statusCode: 200, body: "Page agent handler" };
}`,
      "lambda/canvas-agent/src/handler.ts": `
// Lambda handler for canvas-agent
export async function handleCanvasAgent(event: any) {
  console.log("Processing canvas agent request");
  return { statusCode: 200, body: "Canvas agent handler" };
}`,
      "src/legacy/PageEditHandler.ts": `
// Legacy page edit handler (deprecated)
export class PageEditHandler {
  async handleEdit(pageId: string, content: string) {
    console.log("Editing page with legacy handler");
    return { success: true };
  }
}`,
      "lambda/page-agent/README.md": `
# Page Agent Lambda

This Lambda function handles page-agent operations.
`,
      "lambda/canvas-agent/README.md": `
# Canvas Agent Lambda

This Lambda function handles canvas-agent operations.
`,
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      warningManager: new WarningManager(),
    };

    // This is the exact query from the original problem report
    const bundle = await contextBundle(context, {
      goal: "page-agent Lambda handler",
      limit: 10,
    });

    // Find the relevant files
    const pageAgentHandler = bundle.context.find(
      (item) => item.path === "lambda/page-agent/src/handler.ts"
    );
    const canvasAgentHandler = bundle.context.find(
      (item) => item.path === "lambda/canvas-agent/src/handler.ts"
    );
    const legacyHandler = bundle.context.find(
      (item) => item.path === "src/legacy/PageEditHandler.ts"
    );

    // Assertions
    expect(pageAgentHandler).toBeDefined();
    expect(pageAgentHandler!.path).toBe("lambda/page-agent/src/handler.ts");

    // Verify phrase matching is working
    const hasPhraseMatch = pageAgentHandler!.why.some(
      (reason) => reason.includes("phrase:page-agent") || reason.includes("phrase:page")
    );
    expect(hasPhraseMatch).toBe(true);

    // Verify path-based scoring is applied
    const hasPathBoost = pageAgentHandler!.why.some(
      (reason) =>
        reason.startsWith("path-phrase:") ||
        reason.startsWith("path-segment:") ||
        reason.startsWith("path-keyword:")
    );
    expect(hasPathBoost).toBe(true);

    // Critical: page-agent handler should rank higher than canvas-agent
    if (canvasAgentHandler) {
      expect(pageAgentHandler!.score).toBeGreaterThan(canvasAgentHandler.score);
    }

    // Critical: page-agent handler should rank higher than legacy handler
    if (legacyHandler) {
      expect(pageAgentHandler!.score).toBeGreaterThan(legacyHandler.score);
    }

    // Ideally, page-agent should be in top 3 results
    const pageAgentRank = bundle.context.findIndex(
      (item) => item.path === "lambda/page-agent/src/handler.ts"
    );
    expect(pageAgentRank).toBeLessThan(3);
  }, 15000);

  describe("WarningManager request isolation", () => {
    it("clears warnings between requests to prevent cross-contamination", async () => {
      const repo = await createTempRepo({
        "src/app.ts": "export function app() { return 1; }\n",
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-warnings-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);
      const manager = new WarningManager();
      const context: ServerContext = {
        db,
        repoId,
        services: createServerServices(db),
        warningManager: manager,
      };

      // First request triggers warning (large non-compact without token estimate)
      manager.startRequest();
      const bundle1 = await contextBundle(context, {
        goal: "investigate app",
        limit: 15, // Large limit
        compact: false, // Non-compact
        // No includeTokensEstimate - triggers warning
      });
      expect(bundle1.warnings).toBeDefined();
      expect(bundle1.warnings!.length).toBeGreaterThan(0);
      const firstWarnings = bundle1.warnings!;

      // Second request should have clean slate (different params, no warning expected)
      manager.startRequest();
      const bundle2 = await contextBundle(context, {
        goal: "investigate app again",
        limit: 5, // Small limit
      });
      // Second request should not inherit warnings from first request
      if (bundle2.warnings) {
        expect(bundle2.warnings.length).toBe(0);
      }

      // Verify first warning is about large_non_compact
      expect(firstWarnings.some((w) => w.includes("large_non_compact"))).toBe(true);
    });

    it("deduplicates warnings within single request (DoS protection)", async () => {
      const manager = new WarningManager();

      // Simulate a single request context
      manager.startRequest();

      // Attempt to add same warning multiple times
      manager.warnForRequest("test_key", "Test warning message");
      manager.warnForRequest("test_key", "Test warning message");
      manager.warnForRequest("test_key", "Test warning message");

      const warnings = manager.responseWarnings;
      // Should only appear once due to deduplication
      expect(warnings.filter((w) => w.startsWith("[test_key]")).length).toBe(1);
    });

    it("allows different warning keys in same request", async () => {
      const manager = new WarningManager();

      manager.startRequest();

      manager.warnForRequest("key1", "First warning");
      manager.warnForRequest("key2", "Second warning");
      manager.warnForRequest("key3", "Third warning");

      const warnings = manager.responseWarnings;
      expect(warnings.length).toBe(3);
      expect(warnings[0]).toContain("[key1]");
      expect(warnings[1]).toContain("[key2]");
      expect(warnings[2]).toContain("[key3]");
    });

    it("ensures warnings do not persist across multiple requests", async () => {
      const manager = new WarningManager();

      // First request
      manager.startRequest();
      manager.warnForRequest("request1", "Warning from request 1");
      const warnings1 = manager.responseWarnings;
      expect(warnings1.length).toBe(1);

      // Second request
      manager.startRequest();
      manager.warnForRequest("request2", "Warning from request 2");
      const warnings2 = manager.responseWarnings;
      expect(warnings2.length).toBe(1);
      expect(warnings2[0]).toContain("[request2]");
      expect(warnings2[0]).not.toContain("[request1]");

      // Third request with no warnings
      manager.startRequest();
      const warnings3 = manager.responseWarnings;
      expect(warnings3.length).toBe(0);
    });
  });
});
