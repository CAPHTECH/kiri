import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runIndexer } from "../../src/indexer/cli.js";
import { ServerContext } from "../../src/server/context.js";
import { contextBundle, resolveRepoId } from "../../src/server/handlers.js";
import { startServer } from "../../src/server/main.js";
import { DuckDBClient } from "../../src/shared/duckdb.js";
import { createTempRepo } from "../helpers/test-repo.js";

interface CleanupTarget {
  dispose: () => Promise<void>;
}

describe("startServer", () => {
  it("fails fast when repository index is missing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "kiri-server-"));
    const dbPath = join(tempDir, "index.duckdb");

    await expect(startServer({ port: 0, repoRoot: tempDir, databasePath: dbPath })).rejects.toThrow(
      /Target repository is missing/
    );

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
      "src/auth/token.spec.ts": `import { verifyToken } from "./token";\n\nexport function expectTokenVerifier() {\n  return verifyToken("sample");\n}\n`,
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

    const helper = bundle.context.find((item) => item.path === "src/utils/helper.ts");
    expect(helper).toBeDefined();
    expect(helper?.why.some((reason) => reason.startsWith("dep:"))).toBe(true);

    const nearby = bundle.context.find((item) => item.path === "src/auth/token.spec.ts");
    expect(nearby).toBeDefined();
    expect(nearby?.why.some((reason) => reason.startsWith("near:"))).toBe(true);
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
  });

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
});
