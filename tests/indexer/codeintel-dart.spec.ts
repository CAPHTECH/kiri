/**
 * Integration tests for Dart support in analyzeSource (src/indexer/codeintel.ts)
 */

import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";

import { analyzeSource } from "../../src/indexer/codeintel.js";

// Mock Dart analyze module
vi.mock("../../src/indexer/dart/analyze.js");

describe("analyzeSource with Dart language", () => {
  let analyzeDartSourceMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    const dartAnalyze = await import("../../src/indexer/dart/analyze.js");
    analyzeDartSourceMock = vi.fn().mockResolvedValue({
      symbols: [
        {
          symbolId: 1,
          name: "MyClass",
          kind: "class",
          rangeStartLine: 1,
          rangeEndLine: 10,
          signature: "class MyClass",
          doc: null,
        },
      ],
      snippets: [{ startLine: 1, endLine: 10, symbolId: 1 }],
      dependencies: [],
    });

    vi.mocked(dartAnalyze.analyzeDartSource).mockImplementation(analyzeDartSourceMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls analyzeDartSource for Dart language", async () => {
    const result = await analyzeSource(
      "test.dart",
      "Dart",
      "class MyClass {}",
      new Set(),
      "/workspace"
    );

    expect(analyzeDartSourceMock).toHaveBeenCalledWith(
      "test.dart",
      "class MyClass {}",
      "/workspace"
    );

    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0]?.name).toBe("MyClass");
  });

  it("returns empty result when workspaceRoot is missing", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await analyzeSource("test.dart", "Dart", "class MyClass {}", new Set());

    expect(result).toEqual({ symbols: [], snippets: [], dependencies: [] });
    expect(analyzeDartSourceMock).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("workspaceRoot required"));

    consoleSpy.mockRestore();
  });

  it("does not interfere with TypeScript analysis", async () => {
    const tsCode = `class TypeScriptClass {
  method() { return 42; }
}`;

    const result = await analyzeSource("test.ts", "TypeScript", tsCode, new Set());

    expect(result.symbols.length).toBeGreaterThan(0);
    expect(analyzeDartSourceMock).not.toHaveBeenCalled();
  });

  it("does not interfere with PHP analysis", async () => {
    const phpCode = `<?php
class PHPClass {
  public function method() {}
}`;

    const result = await analyzeSource("test.php", "PHP", phpCode, new Set());

    expect(result.symbols.length).toBeGreaterThan(0);
    expect(analyzeDartSourceMock).not.toHaveBeenCalled();
  });

  it("does not interfere with Swift analysis", async () => {
    const swiftCode = `class SwiftClass {
  func method() {}
}`;

    const result = await analyzeSource("test.swift", "Swift", swiftCode, new Set());

    expect(result.symbols.length).toBeGreaterThan(0);
    expect(analyzeDartSourceMock).not.toHaveBeenCalled();
  });

  it("returns empty result for unsupported languages", async () => {
    const result = await analyzeSource("test.py", "Python", "class Test: pass", new Set());

    expect(result).toEqual({ symbols: [], snippets: [], dependencies: [] });
    expect(analyzeDartSourceMock).not.toHaveBeenCalled();
  });
});
