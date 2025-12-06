import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runIndexer } from "../../src/indexer/cli.js";
import { DuckDBClient } from "../../src/shared/duckdb.js";
import { createTempRepo } from "../helpers/test-repo.js";

interface CleanupTarget {
  dispose: () => Promise<void>;
}

describe("Metadata extraction", () => {
  const cleanupTargets: CleanupTarget[] = [];

  afterEach(async () => {
    for (const target of cleanupTargets.splice(0, cleanupTargets.length)) {
      await target.dispose();
    }
  });

  describe("YAML/JSON metadata extraction", () => {
    it("parses valid YAML metadata files", async () => {
      const repo = await createTempRepo({
        "config/settings.yaml": `name: my-app
version: 1.0.0
features:
  - caching
  - logging
`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-yaml-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoRow = await db.all<{ id: number }>("SELECT id FROM repo");
      const repoId = repoRow[0]?.id;
      expect(repoId).toBeDefined();

      const metadataRows = await db.all<{ path: string; source: string; data: string }>(
        "SELECT path, source, data FROM document_metadata WHERE repo_id = ?",
        [repoId]
      );
      expect(metadataRows).toHaveLength(1);
      expect(metadataRows[0]).toMatchObject({
        path: "config/settings.yaml",
        source: "yaml",
      });

      const parsed = JSON.parse(metadataRows[0]!.data);
      expect(parsed.name).toBe("my-app");
      expect(parsed.features).toEqual(["caching", "logging"]);
    });

    it("parses valid JSON metadata files", async () => {
      const repo = await createTempRepo({
        "data/config.json": `{"database": {"host": "localhost", "port": 5432}, "debug": true}`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-json-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoRow = await db.all<{ id: number }>("SELECT id FROM repo");
      const repoId = repoRow[0]?.id;

      const metadataRows = await db.all<{ path: string; source: string; data: string }>(
        "SELECT path, source, data FROM document_metadata WHERE repo_id = ?",
        [repoId]
      );
      expect(metadataRows).toHaveLength(1);
      expect(metadataRows[0]).toMatchObject({
        path: "data/config.json",
        source: "json",
      });

      const parsed = JSON.parse(metadataRows[0]!.data);
      expect(parsed.database.host).toBe("localhost");
      expect(parsed.debug).toBe(true);
    });

    it("skips malformed YAML with warning (no crash)", async () => {
      const repo = await createTempRepo({
        "config/bad.yaml": `name: test
  invalid: indentation
    nested: wrong
`,
        "config/good.yaml": `name: valid
version: 1
`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-bad-yaml-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      // Should not throw
      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoRow = await db.all<{ id: number }>("SELECT id FROM repo");
      const repoId = repoRow[0]?.id;

      // Good YAML should still be indexed
      const metadataRows = await db.all<{ path: string }>(
        "SELECT path FROM document_metadata WHERE repo_id = ? AND source = 'yaml'",
        [repoId]
      );
      expect(metadataRows.some((row) => row.path === "config/good.yaml")).toBe(true);
    });

    it("skips malformed JSON with warning (no crash)", async () => {
      const repo = await createTempRepo({
        "data/bad.json": `{"unclosed": "brace"`,
        "data/good.json": `{"valid": true}`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-bad-json-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoRow = await db.all<{ id: number }>("SELECT id FROM repo");
      const repoId = repoRow[0]?.id;

      const metadataRows = await db.all<{ path: string }>(
        "SELECT path FROM document_metadata WHERE repo_id = ? AND source = 'json'",
        [repoId]
      );
      expect(metadataRows.some((row) => row.path === "data/good.json")).toBe(true);
    });

    it("handles Unicode/CJK content correctly", async () => {
      const repo = await createTempRepo({
        "i18n/messages.yaml": `greeting: こんにちは
farewell: 再见
emoji: "🚀"
`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-unicode-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoRow = await db.all<{ id: number }>("SELECT id FROM repo");
      const repoId = repoRow[0]?.id;

      const metadataRows = await db.all<{ data: string }>(
        "SELECT data FROM document_metadata WHERE repo_id = ? AND path = 'i18n/messages.yaml'",
        [repoId]
      );
      const parsed = JSON.parse(metadataRows[0]!.data);
      expect(parsed.greeting).toBe("こんにちは");
      expect(parsed.farewell).toBe("再见");
      expect(parsed.emoji).toBe("🚀");
    });

    it("handles isolated high surrogate in YAML via escape sequence (no crash)", async () => {
      // YAMLのUnicodeエスケープシーケンス \uD800 がパース時にサロゲート文字に変換される
      // Issue #141: 不正なサロゲートペアによるインデックス失敗
      // Note: YAMLでは二重引用符内の \uXXXX エスケープがUnicode文字に変換される
      const repo = await createTempRepo({
        "config/invalid-surrogate.yaml": `title: "test\\uD800value"
description: normal text`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-surrogate-high-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      // インデクサーがクラッシュしないことを確認
      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoRow = await db.all<{ id: number }>("SELECT id FROM repo");
      const repoId = repoRow[0]?.id;

      const metadataRows = await db.all<{ data: string }>(
        "SELECT data FROM document_metadata WHERE repo_id = ? AND path = 'config/invalid-surrogate.yaml'",
        [repoId]
      );
      // メタデータが保存されていること
      expect(metadataRows.length).toBe(1);
      const parsed = JSON.parse(metadataRows[0]!.data);
      // 孤立したサロゲートが除去され、前後の文字が連結されていること
      expect(parsed.title).toBe("testvalue");
      expect(parsed.description).toBe("normal text");
    });

    it("handles isolated low surrogate in YAML via escape sequence (no crash)", async () => {
      // YAMLのUnicodeエスケープシーケンス \uDC00 (Low Surrogate)
      const repo = await createTempRepo({
        "config/low-surrogate.yaml": `key: "before\\uDC00after"
normal: text`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-surrogate-low-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoRow = await db.all<{ id: number }>("SELECT id FROM repo");
      const repoId = repoRow[0]?.id;

      const metadataRows = await db.all<{ data: string }>(
        "SELECT data FROM document_metadata WHERE repo_id = ? AND path = 'config/low-surrogate.yaml'",
        [repoId]
      );
      expect(metadataRows.length).toBe(1);
      const parsed = JSON.parse(metadataRows[0]!.data);
      expect(parsed.key).toBe("beforeafter");
      expect(parsed.normal).toBe("text");
    });

    it("handles multiple isolated surrogates in YAML via escape sequences", async () => {
      // 複数の孤立したサロゲートが混在するケース
      const repo = await createTempRepo({
        "config/mixed-surrogates.yaml": `title: "\\uD800start\\uDC00middle\\uDBFFend"
author: normal`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-surrogate-mixed-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoRow = await db.all<{ id: number }>("SELECT id FROM repo");
      const repoId = repoRow[0]?.id;

      const metadataRows = await db.all<{ data: string }>(
        "SELECT data FROM document_metadata WHERE repo_id = ? AND path = 'config/mixed-surrogates.yaml'",
        [repoId]
      );
      expect(metadataRows.length).toBe(1);
      const parsed = JSON.parse(metadataRows[0]!.data);
      // すべての孤立したサロゲートが除去される
      expect(parsed.title).toBe("startmiddleend");
      expect(parsed.author).toBe("normal");
    });

    it("handles isolated surrogate in YAML object key (no crash)", async () => {
      // キーに孤立したサロゲートが含まれるケース
      const repo = await createTempRepo({
        "config/surrogate-key.yaml": `"normal_key": value1
"\\uD800bad_key": value2
"another": value3`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-surrogate-key-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoRow = await db.all<{ id: number }>("SELECT id FROM repo");
      const repoId = repoRow[0]?.id;

      const metadataRows = await db.all<{ data: string }>(
        "SELECT data FROM document_metadata WHERE repo_id = ? AND path = 'config/surrogate-key.yaml'",
        [repoId]
      );
      expect(metadataRows.length).toBe(1);
      const parsed = JSON.parse(metadataRows[0]!.data);
      // キーから孤立したサロゲートが除去される
      expect(parsed["normal_key"]).toBe("value1");
      expect(parsed["bad_key"]).toBe("value2");
      expect(parsed["another"]).toBe("value3");
    });
  });

  describe("Markdown front matter extraction", () => {
    it("extracts valid YAML front matter", async () => {
      const repo = await createTempRepo({
        "docs/guide.md": `---
title: Getting Started
author: Developer
tags:
  - tutorial
  - beginner
---

# Getting Started

This is the guide content.
`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-frontmatter-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoRow = await db.all<{ id: number }>("SELECT id FROM repo");
      const repoId = repoRow[0]?.id;

      const metadataRows = await db.all<{ path: string; source: string; data: string }>(
        "SELECT path, source, data FROM document_metadata WHERE repo_id = ? AND source = 'front_matter'",
        [repoId]
      );
      expect(metadataRows).toHaveLength(1);
      expect(metadataRows[0]!.path).toBe("docs/guide.md");

      const parsed = JSON.parse(metadataRows[0]!.data);
      expect(parsed.title).toBe("Getting Started");
      expect(parsed.tags).toContain("tutorial");
    });

    it("handles markdown without front matter", async () => {
      const repo = await createTempRepo({
        "docs/plain.md": `# Plain Markdown

No front matter here.
`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-no-frontmatter-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoRow = await db.all<{ id: number }>("SELECT id FROM repo");
      const repoId = repoRow[0]?.id;

      // No front_matter entry should exist for this file
      const metadataRows = await db.all<{ path: string }>(
        "SELECT path FROM document_metadata WHERE repo_id = ? AND path = 'docs/plain.md' AND source = 'front_matter'",
        [repoId]
      );
      expect(metadataRows).toHaveLength(0);
    });

    it("skips invalid front matter delimiters", async () => {
      const repo = await createTempRepo({
        "docs/broken.md": `---
title: Missing closing delimiter

# Content starts here
`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-broken-fm-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      // Should not crash
      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      // File should still be indexed (as a file), just no front_matter metadata
      const repoRow = await db.all<{ id: number }>("SELECT id FROM repo");
      const repoId = repoRow[0]?.id;

      const fileRows = await db.all<{ path: string }>("SELECT path FROM file WHERE repo_id = ?", [
        repoId,
      ]);
      expect(fileRows.some((row) => row.path === "docs/broken.md")).toBe(true);
    });
  });

  describe("Markdown link graph", () => {
    it("extracts relative links with kind='relative'", async () => {
      const repo = await createTempRepo({
        "docs/index.md": `# Index

See the [API reference](./api.md) for details.
`,
        "docs/api.md": `# API

This is the API documentation.
`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-relative-links-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoRow = await db.all<{ id: number }>("SELECT id FROM repo");
      const repoId = repoRow[0]?.id;

      const links = await db.all<{ src_path: string; target: string; kind: string }>(
        "SELECT src_path, target, kind FROM markdown_link WHERE repo_id = ?",
        [repoId]
      );
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({
        src_path: "docs/index.md",
        target: "./api.md",
        kind: "relative",
      });
    });

    it("extracts external URLs with kind='external'", async () => {
      const repo = await createTempRepo({
        "README.md": `# Project

Check out [GitHub](https://github.com/example/repo) for the source.
`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-external-links-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoRow = await db.all<{ id: number }>("SELECT id FROM repo");
      const repoId = repoRow[0]?.id;

      const links = await db.all<{ src_path: string; target: string; kind: string }>(
        "SELECT src_path, target, kind FROM markdown_link WHERE repo_id = ?",
        [repoId]
      );
      expect(links).toHaveLength(1);
      expect(links[0]!.kind).toBe("external");
    });

    it("resolves paths with ../ traversal", async () => {
      const repo = await createTempRepo({
        "docs/guides/setup.md": `# Setup

See the [main readme](../../README.md) for overview.
`,
        "README.md": `# Project

Main readme file.
`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-traversal-links-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoRow = await db.all<{ id: number }>("SELECT id FROM repo");
      const repoId = repoRow[0]?.id;

      const links = await db.all<{ src_path: string; target: string; resolved_path: string }>(
        "SELECT src_path, target, resolved_path FROM markdown_link WHERE repo_id = ? AND src_path = 'docs/guides/setup.md'",
        [repoId]
      );
      expect(links).toHaveLength(1);
      expect(links[0]!.target).toBe("../../README.md");
      expect(links[0]!.resolved_path).toBe("README.md");
    });

    it("preserves anchor text", async () => {
      const repo = await createTempRepo({
        "docs/index.md": `# Index

Read the [Getting Started Guide](./guide.md) to begin.
`,
        "docs/guide.md": `# Guide

Content here.
`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-anchor-text-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoRow = await db.all<{ id: number }>("SELECT id FROM repo");
      const repoId = repoRow[0]?.id;

      const links = await db.all<{ anchor_text: string }>(
        "SELECT anchor_text FROM markdown_link WHERE repo_id = ?",
        [repoId]
      );
      expect(links[0]!.anchor_text).toBe("Getting Started Guide");
    });

    it("handles multiple links in a single file", async () => {
      const repo = await createTempRepo({
        "docs/index.md": `# Index

- [Guide](./guide.md)
- [API](./api.md)
- [FAQ](./faq.md)
`,
        "docs/guide.md": `# Guide`,
        "docs/api.md": `# API`,
        "docs/faq.md": `# FAQ`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-multi-links-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoRow = await db.all<{ id: number }>("SELECT id FROM repo");
      const repoId = repoRow[0]?.id;

      const links = await db.all<{ target: string }>(
        "SELECT target FROM markdown_link WHERE repo_id = ? AND src_path = 'docs/index.md' ORDER BY target",
        [repoId]
      );
      expect(links).toHaveLength(3);
      expect(links.map((l) => l.target)).toEqual(["./api.md", "./faq.md", "./guide.md"]);
    });
  });

  describe("Metadata key-value flattening", () => {
    it("flattens nested metadata into key-value pairs", async () => {
      const repo = await createTempRepo({
        "config/app.yaml": `database:
  host: localhost
  port: 5432
features:
  - caching
  - logging
`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-kv-flatten-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoRow = await db.all<{ id: number }>("SELECT id FROM repo");
      const repoId = repoRow[0]?.id;

      const kvRows = await db.all<{ key: string; value: string }>(
        "SELECT key, value FROM document_metadata_kv WHERE repo_id = ? AND path = 'config/app.yaml' ORDER BY key, value",
        [repoId]
      );

      // Should have flattened keys
      const keys = kvRows.map((r) => r.key);
      expect(keys).toContain("features");

      // Features array items should be flattened
      const featureValues = kvRows.filter((r) => r.key === "features").map((r) => r.value);
      expect(featureValues).toContain("caching");
      expect(featureValues).toContain("logging");
    });

    it("normalizes keys to lowercase", async () => {
      const repo = await createTempRepo({
        "config/mixed.yaml": `Title: My App
CATEGORY: utilities
Version: 1.0
`,
      });
      cleanupTargets.push({ dispose: repo.cleanup });

      const dbDir = await mkdtemp(join(tmpdir(), "kiri-lowercase-"));
      const dbPath = join(dbDir, "index.duckdb");
      cleanupTargets.push({
        dispose: async () => await rm(dbDir, { recursive: true, force: true }),
      });

      await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

      const db = await DuckDBClient.connect({ databasePath: dbPath });
      cleanupTargets.push({ dispose: async () => await db.close() });

      const repoRow = await db.all<{ id: number }>("SELECT id FROM repo");
      const repoId = repoRow[0]?.id;

      const kvRows = await db.all<{ key: string }>(
        "SELECT DISTINCT key FROM document_metadata_kv WHERE repo_id = ? AND path = 'config/mixed.yaml'",
        [repoId]
      );

      const keys = kvRows.map((r) => r.key);
      // Keys should be lowercase
      expect(keys).toContain("title");
      expect(keys).toContain("category");
      expect(keys).toContain("version");
      // Should not contain uppercase versions
      expect(keys).not.toContain("Title");
      expect(keys).not.toContain("CATEGORY");
    });
  });
});
