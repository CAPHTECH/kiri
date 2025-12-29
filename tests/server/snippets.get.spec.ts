import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runIndexer } from "../../src/indexer/cli.js";
import { ServerContext } from "../../src/server/context.js";
import { checkTableAvailability, resolveRepoId, snippetsGet } from "../../src/server/handlers.js";
import { WarningManager } from "../../src/server/rpc.js";
import { createServerServices } from "../../src/server/services/index.js";
import { DuckDBClient } from "../../src/shared/duckdb.js";
import { createTempRepo } from "../helpers/test-repo.js";

interface CleanupTarget {
  dispose: () => Promise<void>;
}

describe("snippets_get", () => {
  const cleanupTargets: CleanupTarget[] = [];

  afterEach(async () => {
    for (const target of cleanupTargets.splice(0, cleanupTargets.length)) {
      await target.dispose();
    }
  });

  it("returns a fixed window when end line is omitted", async () => {
    const repo = await createTempRepo({
      "src/main.ts": [
        "export function alpha() {",
        "  return 'alpha';",
        "}",
        "",
        "export function beta() {",
        "  return 'beta';",
        "}",
        "",
        "export function gamma() {",
        "  return 'gamma';",
        "}",
        "",
        "export function delta() {",
        "  return 'delta';",
        "}",
        "",
        "export function epsilon() {",
        "  return 'epsilon';",
        "}",
      ].join("\n"),
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const tableAvailability = await checkTableAvailability(db);
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      tableAvailability,
      warningManager: new WarningManager(),
    };

    const snippet = await snippetsGet(context, { path: "src/main.ts", start_line: 5 });
    expect(snippet.path).toBe("src/main.ts");
    expect(snippet.startLine).toBe(5);
    expect(snippet.endLine).toBe(7);
    expect(snippet.content).toBeDefined();
    expect((snippet.content ?? "").split("\n").length).toBe(3);
    expect(snippet.symbolName).toBe("beta");
    expect(snippet.symbolKind).toBe("function");
  });

  it("respects explicit start and end lines", async () => {
    const repo = await createTempRepo({
      "src/util.ts": [
        "function first() { return 1; }",
        "function second() { return 2; }",
        "function third() { return 3; }",
      ].join("\n"),
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const tableAvailability = await checkTableAvailability(db);
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      tableAvailability,
      warningManager: new WarningManager(),
    };

    const snippet = await snippetsGet(context, { path: "src/util.ts", start_line: 2, end_line: 3 });
    expect(snippet.startLine).toBe(2);
    expect(snippet.endLine).toBe(3);
    expect(snippet.content).toBeDefined();
    expect(snippet.content).toContain("second");
    expect(snippet.content).toContain("third");
    expect(snippet.symbolName).toBeNull();
    expect(snippet.symbolKind).toBeNull();
  });

  it("omits content when compact=true", async () => {
    const repo = await createTempRepo({
      "src/data.ts": "export const value = 42;\n",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-compact-snippet-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const tableAvailability = await checkTableAvailability(db);
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      tableAvailability,
      warningManager: new WarningManager(),
    };

    const snippet = await snippetsGet(context, { path: "src/data.ts", compact: true });
    expect(snippet.content).toBeUndefined();
    expect(snippet.startLine).toBe(1);
    expect(snippet.endLine).toBeGreaterThanOrEqual(snippet.startLine);
  });

  it("prefixes content lines with numbers when includeLineNumbers=true", async () => {
    const repo = await createTempRepo({
      "src/logic.ts": [
        "export function alpha() {",
        "  return 1;",
        "}",
        "",
        "export function beta() {",
        "  return 2;",
        "}",
      ].join("\n"),
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-line-numbers-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const tableAvailability = await checkTableAvailability(db);
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      tableAvailability,
      warningManager: new WarningManager(),
    };

    const snippet = await snippetsGet(context, {
      path: "src/logic.ts",
      start_line: 1,
      end_line: 3,
      includeLineNumbers: true,
    });

    expect(snippet.content).toBeDefined();
    const lines = (snippet.content ?? "").split("\n");
    expect(lines[0]).toMatch(/^\s*1→/);
    expect(lines[1]).toMatch(/^\s*2→/);
    expect(lines[2]).toMatch(/^\s*3→/);
  });

  it("truncates content when it exceeds max chars", async () => {
    const line = "x".repeat(100_000);
    const repo = await createTempRepo({
      "src/long.ts": [line, line, line].join("\n"),
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-long-line-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const tableAvailability = await checkTableAvailability(db);
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      tableAvailability,
      warningManager: new WarningManager(),
    };

    const snippet = await snippetsGet(context, {
      path: "src/long.ts",
      start_line: 1,
      end_line: 3,
      view: "lines",
    });

    expect(snippet.truncated).toBe(true);
    expect(snippet.startLine).toBe(1);
    expect(snippet.endLine).toBe(2);
    expect(snippet.content).toBeDefined();
    expect((snippet.content ?? "").length).toBe(200_000);
  });

  it("throws error when blob content is NULL", async () => {
    const repo = await createTempRepo({
      "src/data.ts": "export const value = 42;\n",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-null-content-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    // Force blob content to NULL to simulate error condition
    await db.run(
      "UPDATE blob SET content = NULL WHERE hash IN (SELECT blob_hash FROM file WHERE path = ?)",
      ["src/data.ts"]
    );

    const repoId = await resolveRepoId(db, repo.path);
    const tableAvailability = await checkTableAvailability(db);
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      tableAvailability,
      warningManager: new WarningManager(),
    };

    await expect(snippetsGet(context, { path: "src/data.ts" })).rejects.toThrow(
      /Snippet content was NULL for src\/data\.ts/
    );
  });

  it("selects first symbol when start_line is before all symbols", async () => {
    const repo = await createTempRepo({
      "src/header.ts": [
        "// Header comment line 1",
        "// Header comment line 2",
        "// Header comment line 3",
        "",
        "export function firstFunc() {",
        "  return 'first';",
        "}",
        "",
        "export function secondFunc() {",
        "  return 'second';",
        "}",
      ].join("\n"),
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-before-symbols-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const tableAvailability = await checkTableAvailability(db);
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      tableAvailability,
      warningManager: new WarningManager(),
    };

    const snippet = await snippetsGet(context, { path: "src/header.ts", start_line: 1 });
    expect(snippet.symbolName).toBe("firstFunc");
    expect(snippet.symbolKind).toBe("function");
    expect(snippet.startLine).toBeGreaterThanOrEqual(1);
  });

  it("selects last symbol when start_line is after all symbols", async () => {
    const repo = await createTempRepo({
      "src/footer.ts": [
        "export function alpha() {",
        "  return 'alpha';",
        "}",
        "",
        "export function beta() {",
        "  return 'beta';",
        "}",
        "",
        "export function epsilon() {",
        "  return 'epsilon';",
        "}",
      ].join("\n"),
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-after-symbols-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({ dispose: async () => await rm(dbDir, { recursive: true, force: true }) });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoId = await resolveRepoId(db, repo.path);
    const tableAvailability = await checkTableAvailability(db);
    const context: ServerContext = {
      db,
      repoId,
      services: createServerServices(db),
      tableAvailability,
      warningManager: new WarningManager(),
    };

    const snippet = await snippetsGet(context, { path: "src/footer.ts", start_line: 999 });
    expect(snippet.symbolName).toBe("epsilon");
    expect(snippet.symbolKind).toBe("function");
  });

  describe("view parameter", () => {
    it('view: "lines" ignores symbol boundaries and returns line-based range', async () => {
      const repo = await createTempRepo({
        "src/multi.ts": [
          "export function alpha() {",
          "  return 'alpha';",
          "}",
          "",
          "export function beta() {",
          "  return 'beta';",
          "}",
          "",
          "export function gamma() {",
          "  return 'gamma';",
          "}",
        ].join("\n"),
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-view-lines-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);
      const tableAvailability = await checkTableAvailability(db);
      const context: ServerContext = {
        db,
        repoId,
        services: createServerServices(db),
        tableAvailability,
        warningManager: new WarningManager(),
      };

      // With view: "lines", start_line should be respected even when symbols exist
      const snippet = await snippetsGet(context, {
        path: "src/multi.ts",
        start_line: 3,
        end_line: 6,
        view: "lines",
      });
      expect(snippet.startLine).toBe(3);
      expect(snippet.endLine).toBe(6);
      // Line-based mode should not return symbol metadata
      expect(snippet.symbolName).toBeNull();
      expect(snippet.symbolKind).toBeNull();
    });

    it('view: "full" returns entire file up to safety limit', async () => {
      // Create a small file
      const repo = await createTempRepo({
        "src/small.ts": [
          "const a = 1;",
          "const b = 2;",
          "const c = 3;",
          "const d = 4;",
          "const e = 5;",
        ].join("\n"),
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-view-full-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);
      const tableAvailability = await checkTableAvailability(db);
      const context: ServerContext = {
        db,
        repoId,
        services: createServerServices(db),
        tableAvailability,
        warningManager: new WarningManager(),
      };

      const snippet = await snippetsGet(context, {
        path: "src/small.ts",
        view: "full",
      });
      expect(snippet.startLine).toBe(1);
      expect(snippet.endLine).toBe(5);
      expect(snippet.content).toContain("const a = 1");
      expect(snippet.content).toContain("const e = 5");
      // 500行未満のファイルでは truncated は含まれない
      expect(snippet.truncated).toBeUndefined();
    });

    it('view: "full" returns truncated: true when file exceeds 500 lines', async () => {
      // 550行のファイルを作成（MAX_FULL_LINES = 500 を超える）
      const largeFileLines = Array.from(
        { length: 550 },
        (_, i) => `const line${i + 1} = ${i + 1};`
      );
      const repo = await createTempRepo({
        "src/large.ts": largeFileLines.join("\n"),
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-view-full-truncated-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);
      const tableAvailability = await checkTableAvailability(db);
      const context: ServerContext = {
        db,
        repoId,
        services: createServerServices(db),
        tableAvailability,
        warningManager: new WarningManager(),
      };

      const snippet = await snippetsGet(context, {
        path: "src/large.ts",
        view: "full",
      });
      expect(snippet.startLine).toBe(1);
      expect(snippet.endLine).toBe(500); // MAX_FULL_LINES で制限される
      expect(snippet.totalLines).toBe(550);
      expect(snippet.truncated).toBe(true);
      expect(snippet.content).toContain("const line1 = 1");
      expect(snippet.content).toContain("const line500 = 500");
      expect(snippet.content).not.toContain("const line501 = 501");
    });

    it('view: "full" ignores start_line and always starts from line 1', async () => {
      const repo = await createTempRepo({
        "src/ignore-start.ts": [
          "const first = 1;",
          "const second = 2;",
          "const third = 3;",
          "const fourth = 4;",
          "const fifth = 5;",
        ].join("\n"),
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-view-full-ignore-start-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);
      const tableAvailability = await checkTableAvailability(db);
      const context: ServerContext = {
        db,
        repoId,
        services: createServerServices(db),
        tableAvailability,
        warningManager: new WarningManager(),
      };

      // start_line: 3 を指定しても、view: "full" では無視される
      const snippet = await snippetsGet(context, {
        path: "src/ignore-start.ts",
        start_line: 3, // この値は無視される
        view: "full",
      });
      // 常に1行目から開始される
      expect(snippet.startLine).toBe(1);
      expect(snippet.content).toContain("const first = 1");
    });

    it('view: "symbol" forces symbol-based retrieval', async () => {
      const repo = await createTempRepo({
        "src/funcs.ts": [
          "export function firstFunc() {",
          "  return 'first';",
          "}",
          "",
          "export function secondFunc() {",
          "  return 'second';",
          "}",
        ].join("\n"),
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-view-symbol-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);
      const tableAvailability = await checkTableAvailability(db);
      const context: ServerContext = {
        db,
        repoId,
        services: createServerServices(db),
        tableAvailability,
        warningManager: new WarningManager(),
      };

      // With view: "symbol", should return symbol boundaries even with end_line specified
      const snippet = await snippetsGet(context, {
        path: "src/funcs.ts",
        start_line: 5,
        end_line: 7,
        view: "symbol",
      });
      // Should return the secondFunc symbol
      expect(snippet.symbolName).toBe("secondFunc");
      expect(snippet.symbolKind).toBe("function");
    });

    it('view: "auto" uses symbol boundaries when end_line is omitted', async () => {
      const repo = await createTempRepo({
        "src/auto.ts": [
          "export function autoFunc() {",
          "  return 'auto';",
          "}",
          "",
          "export function nextFunc() {",
          "  return 'next';",
          "}",
        ].join("\n"),
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-view-auto-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoId = await resolveRepoId(db, repo.path);
      const tableAvailability = await checkTableAvailability(db);
      const context: ServerContext = {
        db,
        repoId,
        services: createServerServices(db),
        tableAvailability,
        warningManager: new WarningManager(),
      };

      // Default view: "auto" behavior - uses symbol when end_line is omitted
      const snippetWithoutEndLine = await snippetsGet(context, {
        path: "src/auto.ts",
        start_line: 1,
        view: "auto",
      });
      expect(snippetWithoutEndLine.symbolName).toBe("autoFunc");

      // Default view: "auto" behavior - line-based when end_line is specified
      const snippetWithEndLine = await snippetsGet(context, {
        path: "src/auto.ts",
        start_line: 1,
        end_line: 5,
        view: "auto",
      });
      expect(snippetWithEndLine.symbolName).toBeNull();
    });
  });
});
