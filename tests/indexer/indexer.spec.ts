import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runIndexer } from "../../src/indexer/cli";
import { DuckDBClient } from "../../src/shared/duckdb";
import { createTempRepo } from "../helpers/test-repo";

interface CleanupTarget {
  dispose: () => Promise<void>;
}

describe("runIndexer", () => {
  const cleanupTargets: CleanupTarget[] = [];

  afterEach(async () => {
    for (const target of cleanupTargets.splice(0, cleanupTargets.length)) {
      await target.dispose();
    }
  });

  it("indexes tracked files into DuckDB", async () => {
    const repo = await createTempRepo({
      "src/main.ts": [
        "import { helper } from './util';",
        "",
        "export function answer() {",
        "  return helper();",
        "}",
      ].join("\n"),
      "src/util.ts": ["export function helper() {", "  return 'util';", "}"].join("\n"),
      "README.md": "# Sample\n\nThis is a repo.\n",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-db-"));
    const dbPath = join(dbDir, "index.duckdb");
    cleanupTargets.push({
      dispose: async () => await rm(dbDir, { recursive: true, force: true }),
    });

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const db = await DuckDBClient.connect({ databasePath: dbPath });
    cleanupTargets.push({ dispose: async () => await db.close() });

    const repoRows = await db.all<{ id: number; root: string }>("SELECT id, root FROM repo");
    expect(repoRows).toHaveLength(1);
    const repoId = repoRows[0].id;
    expect(repoRows[0].root).toBe(repo.path);

    const fileRows = await db.all<{ path: string; is_binary: boolean }>(
      "SELECT path, is_binary FROM file WHERE repo_id = ? ORDER BY path",
      [repoId]
    );
    expect(fileRows).toHaveLength(3);
    expect(fileRows.map((row) => row.path)).toEqual(["README.md", "src/main.ts", "src/util.ts"]);
    expect(fileRows.every((row) => row.is_binary === false)).toBe(true);

    const blobRows = await db.all<{ hash: string; content: string | null }>(
      "SELECT hash, content FROM blob ORDER BY hash"
    );
    expect(blobRows.length).toBeGreaterThanOrEqual(2);
    expect(blobRows.every((row) => row.content !== null)).toBe(true);

    const symbolRows = await db.all<{
      path: string;
      name: string;
      kind: string;
      range_start_line: number;
      range_end_line: number;
    }>(
      `
        SELECT path, name, kind, range_start_line, range_end_line
        FROM symbol
        WHERE repo_id = ?
        ORDER BY path, symbol_id
      `,
      [repoId]
    );
    expect(symbolRows).toEqual([
      {
        path: "src/main.ts",
        name: "answer",
        kind: "function",
        range_start_line: 3,
        range_end_line: 5,
      },
      {
        path: "src/util.ts",
        name: "helper",
        kind: "function",
        range_start_line: 1,
        range_end_line: 3,
      },
    ]);

    const rawSnippetRows = await db.all<{
      path: string;
      snippet_id: bigint;
      start_line: number;
      end_line: number;
      symbol_id: bigint | null;
    }>(
      `
        SELECT path, snippet_id, start_line, end_line, symbol_id
        FROM snippet
        WHERE repo_id = ?
        ORDER BY path, snippet_id
      `,
      [repoId]
    );
    const snippetRows = rawSnippetRows.map((row) => ({
      path: row.path,
      snippet_id: Number(row.snippet_id),
      start_line: row.start_line,
      end_line: row.end_line,
      symbol_id: row.symbol_id === null ? null : Number(row.symbol_id),
    }));
    expect(snippetRows).toEqual([
      { path: "README.md", snippet_id: 1, start_line: 1, end_line: 4, symbol_id: null },
      { path: "src/main.ts", snippet_id: 1, start_line: 3, end_line: 5, symbol_id: 1 },
      { path: "src/util.ts", snippet_id: 1, start_line: 1, end_line: 3, symbol_id: 1 },
    ]);

    const dependencyRows = await db.all<{
      src_path: string;
      dst_kind: string;
      dst: string;
      rel: string;
    }>(
      `
        SELECT src_path, dst_kind, dst, rel
        FROM dependency
        WHERE repo_id = ?
        ORDER BY src_path, dst
      `,
      [repoId]
    );
    expect(dependencyRows).toEqual([
      { src_path: "src/main.ts", dst_kind: "path", dst: "src/util.ts", rel: "import" },
    ]);
  });
});
