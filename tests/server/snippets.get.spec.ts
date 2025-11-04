import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runIndexer } from "../../src/indexer/cli.js";
import { ServerContext } from "../../src/server/context.js";
import { resolveRepoId, snippetsGet } from "../../src/server/handlers.js";
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
    const context: ServerContext = { db, repoId };

    const snippet = await snippetsGet(context, { path: "src/main.ts", start_line: 5 });
    expect(snippet.path).toBe("src/main.ts");
    expect(snippet.startLine).toBe(5);
    expect(snippet.endLine).toBe(7);
    expect(snippet.content.split("\n").length).toBe(3);
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
    const context: ServerContext = { db, repoId };

    const snippet = await snippetsGet(context, { path: "src/util.ts", start_line: 2, end_line: 3 });
    expect(snippet.startLine).toBe(2);
    expect(snippet.endLine).toBe(3);
    expect(snippet.content).toContain("second");
    expect(snippet.content).toContain("third");
    expect(snippet.symbolName).toBeNull();
    expect(snippet.symbolKind).toBeNull();
  });
});
