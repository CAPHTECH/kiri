/**
 * MCP Resources機能のテスト
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, afterEach } from "vitest";

import { runIndexer } from "../../src/indexer/cli.js";
import { resolveRepoId } from "../../src/server/handlers.js";
import { listResources, readResource } from "../../src/server/resources.js";
import { DuckDBClient } from "../../src/shared/duckdb.js";
import { createTempRepo } from "../helpers/test-repo.js";

interface CleanupTarget {
  dispose: () => Promise<void>;
}

describe("MCP Resources", () => {
  const cleanupTargets: CleanupTarget[] = [];

  afterEach(async () => {
    for (const target of cleanupTargets.splice(0, cleanupTargets.length)) {
      await target.dispose();
    }
  });

  // ==========================================================================
  // listResources
  // ==========================================================================

  describe("listResources", () => {
    it("should return empty resources for directory without CLAUDE.md or README.md", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "kiri-resources-"));
      cleanupTargets.push({
        dispose: async () => await rm(tempDir, { recursive: true, force: true }),
      });

      const resources = await listResources(tempDir);

      // プロジェクト統計のみ
      expect(resources).toHaveLength(1);
      expect(resources[0]?.uri).toBe("kiri://project/stats");
    });

    it("should include CLAUDE.md when it exists", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "kiri-resources-"));
      cleanupTargets.push({
        dispose: async () => await rm(tempDir, { recursive: true, force: true }),
      });

      await writeFile(join(tempDir, "CLAUDE.md"), "# AI Instructions");

      const resources = await listResources(tempDir);

      expect(resources.some((r) => r.uri === "kiri://project/claude-md")).toBe(true);
      const claudeMd = resources.find((r) => r.uri === "kiri://project/claude-md");
      expect(claudeMd?.name).toBe("CLAUDE.md");
      expect(claudeMd?.mimeType).toBe("text/markdown");
    });

    it("should include README.md when it exists", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "kiri-resources-"));
      cleanupTargets.push({
        dispose: async () => await rm(tempDir, { recursive: true, force: true }),
      });

      await writeFile(join(tempDir, "README.md"), "# Project Readme");

      const resources = await listResources(tempDir);

      expect(resources.some((r) => r.uri === "kiri://project/readme")).toBe(true);
    });

    it("should include AGENTS.md when it exists", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "kiri-resources-"));
      cleanupTargets.push({
        dispose: async () => await rm(tempDir, { recursive: true, force: true }),
      });

      await writeFile(join(tempDir, "AGENTS.md"), "# Repository Guidelines");

      const resources = await listResources(tempDir);

      expect(resources.some((r) => r.uri === "kiri://project/agents-md")).toBe(true);
      const agentsMd = resources.find((r) => r.uri === "kiri://project/agents-md");
      expect(agentsMd?.name).toBe("AGENTS.md");
      expect(agentsMd?.mimeType).toBe("text/markdown");
    });

    it("should include all resources when both files exist", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "kiri-resources-"));
      cleanupTargets.push({
        dispose: async () => await rm(tempDir, { recursive: true, force: true }),
      });

      await writeFile(join(tempDir, "CLAUDE.md"), "# AI Instructions");
      await writeFile(join(tempDir, "README.md"), "# Project Readme");

      const resources = await listResources(tempDir);

      // CLAUDE.md + README.md + stats = 3
      expect(resources).toHaveLength(3);
      expect(resources.map((r) => r.uri)).toContain("kiri://project/claude-md");
      expect(resources.map((r) => r.uri)).toContain("kiri://project/readme");
      expect(resources.map((r) => r.uri)).toContain("kiri://project/stats");
    });

    it("should always include project stats resource", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "kiri-resources-"));
      cleanupTargets.push({
        dispose: async () => await rm(tempDir, { recursive: true, force: true }),
      });

      const resources = await listResources(tempDir);

      const stats = resources.find((r) => r.uri === "kiri://project/stats");
      expect(stats).toBeDefined();
      expect(stats?.name).toBe("プロジェクト統計");
      expect(stats?.mimeType).toBe("application/json");
    });
  });

  // ==========================================================================
  // readResource
  // ==========================================================================

  describe("readResource", () => {
    it("should read CLAUDE.md content", async () => {
      const repo = await createTempRepo({
        "CLAUDE.md": "# AI Instructions\n\nThis is a test.",
        "src/app.ts": "export const app = () => 1;",
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

      const repoId = await resolveRepoId(db, repo.path);

      const result = await readResource("kiri://project/claude-md", repo.path, db, repoId);

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0]?.uri).toBe("kiri://project/claude-md");
      expect(result.contents[0]?.mimeType).toBe("text/markdown");
      expect(result.contents[0]?.text).toContain("# AI Instructions");
    });

    it("should read README.md content", async () => {
      const repo = await createTempRepo({
        "README.md": "# Project Title\n\nDescription here.",
        "src/app.ts": "export const app = () => 1;",
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

      const repoId = await resolveRepoId(db, repo.path);

      const result = await readResource("kiri://project/readme", repo.path, db, repoId);

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0]?.text).toContain("# Project Title");
    });

    it("should read project stats", async () => {
      const repo = await createTempRepo({
        "src/app.ts": "export const app = () => 1;",
        "src/utils.ts": "export const utils = () => 2;",
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

      const repoId = await resolveRepoId(db, repo.path);

      const result = await readResource("kiri://project/stats", repo.path, db, repoId);

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0]?.mimeType).toBe("application/json");

      const stats = JSON.parse(result.contents[0]?.text ?? "{}");
      expect(stats.totalFiles).toBeGreaterThan(0);
      expect(stats.languages).toBeDefined();
    });

    it("should throw error for non-existent CLAUDE.md", async () => {
      const repo = await createTempRepo({
        "src/app.ts": "export const app = () => 1;",
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

      const repoId = await resolveRepoId(db, repo.path);

      await expect(readResource("kiri://project/claude-md", repo.path, db, repoId)).rejects.toThrow(
        /CLAUDE\.md does not exist/
      );
    });

    it("should throw error for unknown resource URI", async () => {
      const repo = await createTempRepo({
        "src/app.ts": "export const app = () => 1;",
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

      const repoId = await resolveRepoId(db, repo.path);

      await expect(readResource("kiri://unknown/resource", repo.path, db, repoId)).rejects.toThrow(
        /Unknown resource.*Use resources\/list/
      );
    });
  });
});
