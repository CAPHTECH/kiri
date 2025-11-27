/**
 * IDF Provider Tests
 *
 * @see Issue #48: Improve context_bundle stop word coverage and configurability
 * @see Phase 2: IDF-based keyword weighting
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createIdfProvider } from "../../src/server/idf-provider.js";
import { DuckDBClient } from "../../src/shared/duckdb.js";

let db: DuckDBClient;
let tempDir: string;
let repoId: number;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "idf-test-"));
  const dbPath = join(tempDir, "test.duckdb");

  db = await DuckDBClient.connect({ databasePath: dbPath, ensureDirectory: true });

  // Setup basic schema
  await db.run(`
    CREATE TABLE repo (
      id INTEGER PRIMARY KEY,
      root TEXT NOT NULL
    )
  `);

  await db.run(`
    CREATE TABLE blob (
      hash TEXT PRIMARY KEY,
      content TEXT
    )
  `);

  await db.run(`
    CREATE TABLE file (
      repo_id INTEGER,
      path TEXT,
      blob_hash TEXT,
      PRIMARY KEY (repo_id, path)
    )
  `);

  // Create a test repository
  await db.run(`INSERT INTO repo (id, root) VALUES (1, '/test/repo')`);
  repoId = 1;
});

afterEach(async () => {
  await db.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("DuckDbIdfProvider", () => {
  describe("getDocumentCount", () => {
    it("returns the number of files in the repository", async () => {
      // Add test files
      await db.run(`INSERT INTO blob (hash, content) VALUES ('hash1', 'content 1')`);
      await db.run(`INSERT INTO blob (hash, content) VALUES ('hash2', 'content 2')`);
      await db.run(`INSERT INTO blob (hash, content) VALUES ('hash3', 'content 3')`);
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'file1.ts', 'hash1')`);
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'file2.ts', 'hash2')`);
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'file3.ts', 'hash3')`);

      const provider = createIdfProvider(db, repoId);
      const count = await provider.getDocumentCount();

      expect(count).toBe(3);
    });

    it("returns at least 1 for empty repository", async () => {
      const provider = createIdfProvider(db, repoId);
      const count = await provider.getDocumentCount();

      // Minimum 1 to prevent division by zero
      expect(count).toBeGreaterThanOrEqual(1);
    });

    it("caches the document count", async () => {
      await db.run(`INSERT INTO blob (hash, content) VALUES ('hash1', 'content')`);
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'file.ts', 'hash1')`);

      const provider = createIdfProvider(db, repoId);
      const count1 = await provider.getDocumentCount();

      // Add another file (should not affect cached count)
      await db.run(`INSERT INTO blob (hash, content) VALUES ('hash2', 'content 2')`);
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'file2.ts', 'hash2')`);

      const count2 = await provider.getDocumentCount();

      expect(count1).toBe(count2);
    });
  });

  describe("getDocumentFrequency", () => {
    it("returns the number of documents containing a term", async () => {
      // Create files with different content
      await db.run(
        `INSERT INTO blob (hash, content) VALUES ('hash1', 'function hello() { return true; }')`
      );
      await db.run(
        `INSERT INTO blob (hash, content) VALUES ('hash2', 'function world() { return false; }')`
      );
      await db.run(`INSERT INTO blob (hash, content) VALUES ('hash3', 'const hello = "world";')`);
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'file1.ts', 'hash1')`);
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'file2.ts', 'hash2')`);
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'file3.ts', 'hash3')`);

      const provider = createIdfProvider(db, repoId);

      // "function" appears in 2 files
      const functionDf = await provider.getDocumentFrequency("function");
      expect(functionDf).toBe(2);

      // "hello" appears in 2 files
      const helloDf = await provider.getDocumentFrequency("hello");
      expect(helloDf).toBe(2);

      // "world" appears in 2 files
      const worldDf = await provider.getDocumentFrequency("world");
      expect(worldDf).toBe(2);

      // "return" appears in 2 files
      const returnDf = await provider.getDocumentFrequency("return");
      expect(returnDf).toBe(2);

      // "const" appears in 1 file
      const constDf = await provider.getDocumentFrequency("const");
      expect(constDf).toBe(1);
    });

    it("returns 0 for terms not in any document", async () => {
      await db.run(`INSERT INTO blob (hash, content) VALUES ('hash1', 'hello world')`);
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'file.ts', 'hash1')`);

      const provider = createIdfProvider(db, repoId);
      const df = await provider.getDocumentFrequency("nonexistent");

      expect(df).toBe(0);
    });
  });

  describe("computeIdf", () => {
    it("returns higher weight for rare terms", async () => {
      // Create 10 files
      for (let i = 0; i < 10; i++) {
        const hash = `hash${i}`;
        // "common" appears in all files, "rare" appears in only one
        const content = i === 0 ? "common term rare term" : "common term";
        await db.run(`INSERT INTO blob (hash, content) VALUES (?, ?)`, [hash, content]);
        await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, ?, ?)`, [
          `file${i}.ts`,
          hash,
        ]);
      }

      const provider = createIdfProvider(db, repoId);

      const commonWeight = await provider.computeIdf("common");
      const rareWeight = await provider.computeIdf("rare");

      // Rare terms should have higher IDF weight
      expect(rareWeight).toBeGreaterThan(commonWeight);
    });

    it("returns weight in 0-1 range", async () => {
      await db.run(`INSERT INTO blob (hash, content) VALUES ('hash1', 'test content here')`);
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'file.ts', 'hash1')`);

      const provider = createIdfProvider(db, repoId);

      const weight = await provider.computeIdf("test");

      expect(weight).toBeGreaterThanOrEqual(0);
      expect(weight).toBeLessThanOrEqual(1);
    });

    it("returns max weight for OOV (out-of-vocabulary) terms", async () => {
      // Create files without the search term
      for (let i = 0; i < 5; i++) {
        await db.run(`INSERT INTO blob (hash, content) VALUES (?, ?)`, [
          `hash${i}`,
          "some content",
        ]);
        await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, ?, ?)`, [
          `file${i}.ts`,
          `hash${i}`,
        ]);
      }

      const provider = createIdfProvider(db, repoId);

      const oovWeight = await provider.computeIdf("nonexistent");

      // OOV terms should have maximum weight (close to 1.0)
      expect(oovWeight).toBeGreaterThan(0.9);
    });

    it("caches computed IDF values", async () => {
      await db.run(`INSERT INTO blob (hash, content) VALUES ('hash1', 'test content')`);
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'file.ts', 'hash1')`);

      const provider = createIdfProvider(db, repoId);

      await provider.computeIdf("test");
      expect(provider.cacheSize).toBe(1);

      await provider.computeIdf("test"); // Should hit cache
      expect(provider.cacheSize).toBe(1);

      await provider.computeIdf("content");
      expect(provider.cacheSize).toBe(2);
    });

    it("normalizes tokens before computing", async () => {
      await db.run(`INSERT INTO blob (hash, content) VALUES ('hash1', 'TEST content')`);
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'file.ts', 'hash1')`);

      const provider = createIdfProvider(db, repoId);

      const weight1 = await provider.computeIdf("test");
      const weight2 = await provider.computeIdf("TEST");
      const weight3 = await provider.computeIdf("Test");

      // All should return the same normalized weight
      expect(weight1).toBe(weight2);
      expect(weight2).toBe(weight3);
    });

    it("returns 0 for empty string", async () => {
      const provider = createIdfProvider(db, repoId);
      const weight = await provider.computeIdf("");

      expect(weight).toBe(0);
    });
  });

  describe("computeIdfBatch", () => {
    it("computes IDF for multiple terms efficiently", async () => {
      await db.run(`INSERT INTO blob (hash, content) VALUES ('hash1', 'hello world test')`);
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'file.ts', 'hash1')`);

      const provider = createIdfProvider(db, repoId);

      const weights = await provider.computeIdfBatch(["hello", "world", "test"]);

      expect(weights.size).toBe(3);
      expect(weights.has("hello")).toBe(true);
      expect(weights.has("world")).toBe(true);
      expect(weights.has("test")).toBe(true);
    });

    it("handles duplicate terms", async () => {
      await db.run(`INSERT INTO blob (hash, content) VALUES ('hash1', 'test content')`);
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'file.ts', 'hash1')`);

      const provider = createIdfProvider(db, repoId);

      const weights = await provider.computeIdfBatch(["test", "TEST", "Test"]);

      // All normalize to "test", so should have 1 entry
      expect(weights.size).toBe(1);
    });

    it("uses cache for already computed terms", async () => {
      await db.run(`INSERT INTO blob (hash, content) VALUES ('hash1', 'hello world')`);
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'file.ts', 'hash1')`);

      const provider = createIdfProvider(db, repoId);

      // Pre-compute one term
      await provider.computeIdf("hello");
      expect(provider.cacheSize).toBe(1);

      // Batch compute with one cached and one new
      const weights = await provider.computeIdfBatch(["hello", "world"]);

      expect(weights.size).toBe(2);
      expect(provider.cacheSize).toBe(2);
    });
  });

  describe("getIdf (synchronous)", () => {
    it("returns cached value if available", async () => {
      await db.run(`INSERT INTO blob (hash, content) VALUES ('hash1', 'test content')`);
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'file.ts', 'hash1')`);

      const provider = createIdfProvider(db, repoId);

      // Pre-compute and cache
      const computed = await provider.computeIdf("test");

      // Synchronous get should return cached value
      const sync = provider.getIdf("test");

      expect(sync).toBe(computed);
    });

    it("returns 1.0 for uncached terms", async () => {
      const provider = createIdfProvider(db, repoId);

      // Synchronous get without prior computation
      const sync = provider.getIdf("uncached");

      expect(sync).toBe(1.0);
    });

    it("returns 0 for empty string", async () => {
      const provider = createIdfProvider(db, repoId);
      const weight = provider.getIdf("");

      expect(weight).toBe(0);
    });
  });

  describe("clearCache", () => {
    it("clears all cached values", async () => {
      await db.run(`INSERT INTO blob (hash, content) VALUES ('hash1', 'test content')`);
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'file.ts', 'hash1')`);

      const provider = createIdfProvider(db, repoId);

      await provider.computeIdf("test");
      await provider.computeIdf("content");
      expect(provider.cacheSize).toBe(2);

      provider.clearCache();
      expect(provider.cacheSize).toBe(0);
    });

    it("forces recalculation of document count", async () => {
      await db.run(`INSERT INTO blob (hash, content) VALUES ('hash1', 'content')`);
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'file.ts', 'hash1')`);

      const provider = createIdfProvider(db, repoId);

      const count1 = await provider.getDocumentCount();
      expect(count1).toBe(1);

      // Add a new file
      await db.run(`INSERT INTO blob (hash, content) VALUES ('hash2', 'content 2')`);
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'file2.ts', 'hash2')`);

      // Without clearing, should return cached count
      const count2 = await provider.getDocumentCount();
      expect(count2).toBe(1);

      // After clearing, should return updated count
      provider.clearCache();
      const count3 = await provider.getDocumentCount();
      expect(count3).toBe(2);
    });
  });
});

describe("IDF formula verification", () => {
  it("follows BM25-style IDF formula", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "idf-formula-"));
    const dbPath = join(tempDir, "test.duckdb");
    db = await DuckDBClient.connect({ databasePath: dbPath, ensureDirectory: true });

    await db.run(`CREATE TABLE repo (id INTEGER PRIMARY KEY, root TEXT NOT NULL)`);
    await db.run(`CREATE TABLE blob (hash TEXT PRIMARY KEY, content TEXT)`);
    await db.run(
      `CREATE TABLE file (repo_id INTEGER, path TEXT, blob_hash TEXT, PRIMARY KEY (repo_id, path))`
    );
    await db.run(`INSERT INTO repo (id, root) VALUES (1, '/test')`);

    // Create 100 files
    const N = 100;
    for (let i = 0; i < N; i++) {
      // "common" appears in all files, "medium" in 50, "rare" in 10
      let content = "common";
      if (i < 50) content += " medium";
      if (i < 10) content += " rare";
      if (i < 1) content += " unique";

      await db.run(`INSERT INTO blob (hash, content) VALUES (?, ?)`, [`hash${i}`, content]);
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, ?, ?)`, [
        `file${i}.ts`,
        `hash${i}`,
      ]);
    }

    const provider = createIdfProvider(db, 1);

    const commonWeight = await provider.computeIdf("common"); // df = 100
    const mediumWeight = await provider.computeIdf("medium"); // df = 50
    const rareWeight = await provider.computeIdf("rare"); // df = 10
    const uniqueWeight = await provider.computeIdf("unique"); // df = 1
    const oovWeight = await provider.computeIdf("nonexistent"); // df = 0

    // Verify ordering: oov > unique > rare > medium > common
    expect(oovWeight).toBeGreaterThan(uniqueWeight);
    expect(uniqueWeight).toBeGreaterThan(rareWeight);
    expect(rareWeight).toBeGreaterThan(mediumWeight);
    expect(mediumWeight).toBeGreaterThan(commonWeight);

    // All weights should be in [0, 1]
    expect(commonWeight).toBeGreaterThanOrEqual(0);
    expect(oovWeight).toBeLessThanOrEqual(1);

    // Common words (appearing in all docs) should have very low weight
    expect(commonWeight).toBeLessThan(0.2);

    // OOV words should have maximum weight
    expect(oovWeight).toBeGreaterThan(0.95);

    // Note: db.close() and rm() are handled by afterEach
  });
});

// ============================================================
// TF計算テスト（Issue #122: TF-IDF完全実装）
// ============================================================

describe("TF (Term Frequency) computation", () => {
  describe("computeTf", () => {
    it("counts term occurrences correctly", async () => {
      const provider = createIdfProvider(db, repoId);

      expect(provider.computeTf("hello hello hello world", "hello")).toBe(3);
      expect(provider.computeTf("hello hello hello world", "world")).toBe(1);
      expect(provider.computeTf("hello hello hello world", "foo")).toBe(0);
    });

    it("is case-insensitive", async () => {
      const provider = createIdfProvider(db, repoId);

      expect(provider.computeTf("Hello HELLO hello", "hello")).toBe(3);
      expect(provider.computeTf("Hello HELLO hello", "HELLO")).toBe(3);
    });

    it("respects maxTfCap", async () => {
      // Default maxTfCap is 10
      const provider = createIdfProvider(db, repoId);
      const content = "test ".repeat(20); // 20 occurrences

      expect(provider.computeTf(content, "test")).toBe(10); // Capped at 10
    });

    it("respects custom maxTfCap", async () => {
      const provider = createIdfProvider(db, repoId, { maxTfCap: 5 });
      const content = "test ".repeat(20);

      expect(provider.computeTf(content, "test")).toBe(5); // Capped at 5
    });

    it("returns 0 for empty content", async () => {
      const provider = createIdfProvider(db, repoId);

      expect(provider.computeTf("", "test")).toBe(0);
    });

    it("returns 0 for empty term", async () => {
      const provider = createIdfProvider(db, repoId);

      expect(provider.computeTf("hello world", "")).toBe(0);
    });

    it("handles special regex characters in terms", async () => {
      const provider = createIdfProvider(db, repoId);

      // Terms with regex special characters should be escaped
      expect(provider.computeTf("test.file test.file", "test.file")).toBe(2);
      expect(provider.computeTf("foo(bar) foo(bar)", "foo(bar)")).toBe(2);
    });
  });

  describe("computeNormalizedTf", () => {
    it("returns 0 when term is not found", async () => {
      const provider = createIdfProvider(db, repoId);

      const normalizedTf = provider.computeNormalizedTf("hello world", "foo", 100, 100);
      expect(normalizedTf).toBe(0);
    });

    it("returns positive value when term is found", async () => {
      const provider = createIdfProvider(db, repoId);

      const normalizedTf = provider.computeNormalizedTf("hello world hello", "hello", 100, 100);
      expect(normalizedTf).toBeGreaterThan(0);
    });

    it("saturates as TF increases (BM25 behavior)", async () => {
      const provider = createIdfProvider(db, repoId);
      const avgDocLen = 100;

      // Same document length but different TF
      const tf1 = provider.computeNormalizedTf("test", "test", 100, avgDocLen);
      const tf2 = provider.computeNormalizedTf("test test", "test", 100, avgDocLen);
      const tf5 = provider.computeNormalizedTf("test test test test test", "test", 100, avgDocLen);

      // Higher TF should give higher normalized TF, but with diminishing returns
      expect(tf2).toBeGreaterThan(tf1);
      expect(tf5).toBeGreaterThan(tf2);

      // But the increase should saturate (tf5/tf1 should be less than 5)
      expect(tf5 / tf1).toBeLessThan(5);
    });

    it("penalizes longer documents (BM25 behavior)", async () => {
      const provider = createIdfProvider(db, repoId);
      const avgDocLen = 100;

      // Same content but different document lengths
      const shortDoc = provider.computeNormalizedTf("test content", "test", 50, avgDocLen);
      const avgDoc = provider.computeNormalizedTf("test content", "test", 100, avgDocLen);
      const longDoc = provider.computeNormalizedTf("test content", "test", 200, avgDocLen);

      // Shorter documents should get higher scores for same TF
      expect(shortDoc).toBeGreaterThan(avgDoc);
      expect(avgDoc).toBeGreaterThan(longDoc);
    });
  });

  describe("computeTfBatch", () => {
    it("computes TF for multiple terms", async () => {
      const provider = createIdfProvider(db, repoId);
      const content = "hello world hello foo bar foo foo";

      const tfs = provider.computeTfBatch(content, ["hello", "foo", "baz"]);

      expect(tfs.get("hello")).toBe(2);
      expect(tfs.get("foo")).toBe(3);
      expect(tfs.get("baz")).toBe(0); // TF is 0 for non-existent terms
    });

    it("handles empty content", async () => {
      const provider = createIdfProvider(db, repoId);

      const tfs = provider.computeTfBatch("", ["hello", "world"]);

      expect(tfs.size).toBe(0);
    });

    it("normalizes terms", async () => {
      const provider = createIdfProvider(db, repoId);
      const content = "Hello World";

      const tfs = provider.computeTfBatch(content, ["HELLO", "world"]);

      expect(tfs.get("hello")).toBe(1);
      expect(tfs.get("world")).toBe(1);
    });
  });

  describe("computeDocumentLength", () => {
    it("counts words correctly", async () => {
      const provider = createIdfProvider(db, repoId);

      expect(provider.computeDocumentLength("hello world foo bar")).toBe(4);
      expect(provider.computeDocumentLength("one")).toBe(1);
      expect(provider.computeDocumentLength("")).toBe(0);
    });

    it("handles multiple whitespace", async () => {
      const provider = createIdfProvider(db, repoId);

      expect(provider.computeDocumentLength("hello   world\tfoo\nbar")).toBe(4);
    });
  });

  describe("getAverageDocumentLength", () => {
    it("calculates average document length", async () => {
      // Create files with different lengths
      await db.run(`INSERT INTO blob (hash, content) VALUES ('hash1', 'one two three')`); // 3 words
      await db.run(`INSERT INTO blob (hash, content) VALUES ('hash2', 'one two three four five')`); // 5 words
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'file1.ts', 'hash1')`);
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'file2.ts', 'hash2')`);

      const provider = createIdfProvider(db, repoId);
      const avgLen = await provider.getAverageDocumentLength();

      // Average of (words based on space count) should be reasonable
      expect(avgLen).toBeGreaterThan(0);
    });

    it("returns default for empty repository", async () => {
      const provider = createIdfProvider(db, repoId);
      const avgLen = await provider.getAverageDocumentLength();

      // Default is 1000
      expect(avgLen).toBe(1000);
    });

    it("caches the result", async () => {
      await db.run(`INSERT INTO blob (hash, content) VALUES ('hash1', 'one two three')`);
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'file1.ts', 'hash1')`);

      const provider = createIdfProvider(db, repoId);

      const avgLen1 = await provider.getAverageDocumentLength();

      // Add another file
      await db.run(`INSERT INTO blob (hash, content) VALUES ('hash2', 'a b c d e f g h i j')`);
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'file2.ts', 'hash2')`);

      const avgLen2 = await provider.getAverageDocumentLength();

      // Should return cached value
      expect(avgLen1).toBe(avgLen2);
    });

    it("recalculates after clearCache", async () => {
      await db.run(`INSERT INTO blob (hash, content) VALUES ('hash1', 'one two three')`);
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'file1.ts', 'hash1')`);

      const provider = createIdfProvider(db, repoId);

      const avgLen1 = await provider.getAverageDocumentLength();

      provider.clearCache();

      // Add more content
      await db.run(
        `INSERT INTO blob (hash, content) VALUES ('hash2', 'a b c d e f g h i j k l m n o p q r s t')`
      );
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'file2.ts', 'hash2')`);

      const avgLen2 = await provider.getAverageDocumentLength();

      // Should be different after cache clear and new data
      expect(avgLen2).not.toBe(avgLen1);
    });
  });
});

describe("TF-IDF integration", () => {
  it("combines TF and IDF correctly", async () => {
    // Setup: Create files where "rare" appears once in one file, "common" appears in all
    for (let i = 0; i < 10; i++) {
      const content = i === 0 ? "common rare" : "common common common";
      await db.run(`INSERT INTO blob (hash, content) VALUES (?, ?)`, [`hash${i}`, content]);
      await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, ?, ?)`, [
        `file${i}.ts`,
        `hash${i}`,
      ]);
    }

    const provider = createIdfProvider(db, repoId);

    // Get IDF weights
    const rareIdf = await provider.computeIdf("rare");
    const commonIdf = await provider.computeIdf("common");

    // rare should have higher IDF (appears in fewer docs)
    expect(rareIdf).toBeGreaterThan(commonIdf);

    // TF-IDF for "rare" in file0
    const avgDocLen = await provider.getAverageDocumentLength();
    const file0Content = "common rare";
    const docLen = provider.computeDocumentLength(file0Content);

    const rareTf = provider.computeNormalizedTf(file0Content, "rare", docLen, avgDocLen);
    const commonTf = provider.computeNormalizedTf(file0Content, "common", docLen, avgDocLen);

    // Both appear once, so TF should be similar
    expect(rareTf).toBeCloseTo(commonTf, 1);

    // But TF-IDF should favor rare
    const rareTfIdf = rareTf * rareIdf;
    const commonTfIdf = commonTf * commonIdf;
    expect(rareTfIdf).toBeGreaterThan(commonTfIdf);
  });

  it("respects custom BM25 parameters", async () => {
    await db.run(`INSERT INTO blob (hash, content) VALUES ('hash1', 'test test test')`);
    await db.run(`INSERT INTO file (repo_id, path, blob_hash) VALUES (1, 'file1.ts', 'hash1')`);

    const defaultProvider = createIdfProvider(db, repoId);
    const customProvider = createIdfProvider(db, repoId, { k1: 2.0, b: 0.5 });

    const avgDocLen = await defaultProvider.getAverageDocumentLength();
    const content = "test test test";
    const docLen = defaultProvider.computeDocumentLength(content);

    const defaultTf = defaultProvider.computeNormalizedTf(content, "test", docLen, avgDocLen);
    const customTf = customProvider.computeNormalizedTf(content, "test", docLen, avgDocLen);

    // Different k1 and b should give different normalized TF
    expect(defaultTf).not.toBeCloseTo(customTf, 3);
  });
});
