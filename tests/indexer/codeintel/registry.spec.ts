import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  LanguageRegistry,
  type LanguageAnalyzer,
  type AnalysisContext,
  type AnalysisResult,
  emptyResult,
} from "../../../src/indexer/codeintel/index.js";

/**
 * テスト用のモックアナライザーを作成
 */
function createMockAnalyzer(
  language: string,
  result?: Partial<AnalysisResult>,
  dispose?: () => Promise<void>
): LanguageAnalyzer {
  const analyzer: LanguageAnalyzer = {
    language,
    analyze: vi.fn().mockResolvedValue({
      symbols: [],
      snippets: [],
      dependencies: [],
      ...result,
    }),
  };
  if (dispose !== undefined) {
    analyzer.dispose = dispose;
  }
  return analyzer;
}

describe("LanguageRegistry", () => {
  beforeEach(() => {
    LanguageRegistry.resetForTesting();
  });

  afterEach(() => {
    LanguageRegistry.resetForTesting();
  });

  describe("getInstance", () => {
    it("シングルトンインスタンスを返す", () => {
      const instance1 = LanguageRegistry.getInstance();
      const instance2 = LanguageRegistry.getInstance();
      expect(instance1).toBe(instance2);
    });

    it("resetForTesting後は新しいインスタンスを返す", () => {
      const instance1 = LanguageRegistry.getInstance();
      LanguageRegistry.resetForTesting();
      const instance2 = LanguageRegistry.getInstance();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe("register", () => {
    it("アナライザーを登録できる", () => {
      const registry = LanguageRegistry.getInstance();
      const analyzer = createMockAnalyzer("TypeScript");

      registry.register(analyzer);

      expect(registry.isSupported("TypeScript")).toBe(true);
      expect(registry.getAnalyzer("TypeScript")).toBe(analyzer);
    });

    it("同じ言語を二重登録するとエラーをスロー", () => {
      const registry = LanguageRegistry.getInstance();
      const analyzer1 = createMockAnalyzer("TypeScript");
      const analyzer2 = createMockAnalyzer("TypeScript");

      registry.register(analyzer1);

      expect(() => registry.register(analyzer2)).toThrow(
        "Analyzer already registered for language: TypeScript"
      );
    });

    it("異なる言語は複数登録できる", () => {
      const registry = LanguageRegistry.getInstance();
      const tsAnalyzer = createMockAnalyzer("TypeScript");
      const swiftAnalyzer = createMockAnalyzer("Swift");

      registry.register(tsAnalyzer);
      registry.register(swiftAnalyzer);

      expect(registry.isSupported("TypeScript")).toBe(true);
      expect(registry.isSupported("Swift")).toBe(true);
    });
  });

  describe("replace", () => {
    it("既存のアナライザーを置換できる", async () => {
      const registry = LanguageRegistry.getInstance();
      const analyzer1 = createMockAnalyzer("TypeScript");
      const analyzer2 = createMockAnalyzer("TypeScript");

      registry.register(analyzer1);
      await registry.replace(analyzer2);

      expect(registry.getAnalyzer("TypeScript")).toBe(analyzer2);
    });

    it("置換時に既存アナライザーのdispose()を呼び出す", async () => {
      const registry = LanguageRegistry.getInstance();
      const disposeFn = vi.fn().mockResolvedValue(undefined);
      const analyzer1 = createMockAnalyzer("TypeScript", {}, disposeFn);
      const analyzer2 = createMockAnalyzer("TypeScript");

      registry.register(analyzer1);
      await registry.replace(analyzer2);

      expect(disposeFn).toHaveBeenCalledTimes(1);
    });

    it("新規言語も置換で登録できる", async () => {
      const registry = LanguageRegistry.getInstance();
      const analyzer = createMockAnalyzer("Swift");

      await registry.replace(analyzer);

      expect(registry.isSupported("Swift")).toBe(true);
    });
  });

  describe("getAnalyzer", () => {
    it("登録されたアナライザーを返す", () => {
      const registry = LanguageRegistry.getInstance();
      const analyzer = createMockAnalyzer("TypeScript");
      registry.register(analyzer);

      expect(registry.getAnalyzer("TypeScript")).toBe(analyzer);
    });

    it("未登録の言語はundefinedを返す", () => {
      const registry = LanguageRegistry.getInstance();

      expect(registry.getAnalyzer("Unknown")).toBeUndefined();
    });
  });

  describe("isSupported", () => {
    it("登録された言語はtrueを返す", () => {
      const registry = LanguageRegistry.getInstance();
      registry.register(createMockAnalyzer("TypeScript"));

      expect(registry.isSupported("TypeScript")).toBe(true);
    });

    it("未登録の言語はfalseを返す", () => {
      const registry = LanguageRegistry.getInstance();

      expect(registry.isSupported("Unknown")).toBe(false);
    });
  });

  describe("getRegisteredLanguages", () => {
    it("登録された全ての言語を返す", () => {
      const registry = LanguageRegistry.getInstance();
      registry.register(createMockAnalyzer("TypeScript"));
      registry.register(createMockAnalyzer("Swift"));
      registry.register(createMockAnalyzer("PHP"));

      const languages = registry.getRegisteredLanguages();

      expect(languages).toHaveLength(3);
      expect(languages).toContain("TypeScript");
      expect(languages).toContain("Swift");
      expect(languages).toContain("PHP");
    });

    it("未登録時は空配列を返す", () => {
      const registry = LanguageRegistry.getInstance();

      expect(registry.getRegisteredLanguages()).toEqual([]);
    });
  });

  describe("analyze", () => {
    it("登録されたアナライザーで解析を実行", async () => {
      const registry = LanguageRegistry.getInstance();
      const mockResult: AnalysisResult = {
        symbols: [
          {
            symbolId: 1,
            name: "foo",
            kind: "function",
            rangeStartLine: 1,
            rangeEndLine: 3,
            signature: "function foo()",
            doc: null,
          },
        ],
        snippets: [{ startLine: 1, endLine: 3, symbolId: 1 }],
        dependencies: [],
      };
      const analyzer = createMockAnalyzer("TypeScript", mockResult);
      registry.register(analyzer);

      const context: AnalysisContext = {
        pathInRepo: "src/index.ts",
        content: "function foo() {}",
        fileSet: new Set(["src/index.ts"]),
      };
      const result = await registry.analyze("TypeScript", context);

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0]?.name).toBe("foo");
      expect(analyzer.analyze).toHaveBeenCalledWith(context);
    });

    it("未登録の言語は空の結果を返す", async () => {
      const registry = LanguageRegistry.getInstance();
      const context: AnalysisContext = {
        pathInRepo: "test.unknown",
        content: "",
        fileSet: new Set(),
      };

      const result = await registry.analyze("Unknown", context);

      expect(result).toEqual(emptyResult());
    });

    it("nullの言語は空の結果を返す", async () => {
      const registry = LanguageRegistry.getInstance();
      const context: AnalysisContext = {
        pathInRepo: "test.txt",
        content: "",
        fileSet: new Set(),
      };

      const result = await registry.analyze(null, context);

      expect(result).toEqual(emptyResult());
    });
  });

  describe("cleanup", () => {
    it("全アナライザーのdispose()を呼び出す", async () => {
      const registry = LanguageRegistry.getInstance();
      const dispose1 = vi.fn().mockResolvedValue(undefined);
      const dispose2 = vi.fn().mockResolvedValue(undefined);
      registry.register(createMockAnalyzer("TypeScript", {}, dispose1));
      registry.register(createMockAnalyzer("Swift", {}, dispose2));

      await registry.cleanup();

      expect(dispose1).toHaveBeenCalledTimes(1);
      expect(dispose2).toHaveBeenCalledTimes(1);
    });

    it("cleanup後はアナライザーがクリアされる", async () => {
      const registry = LanguageRegistry.getInstance();
      registry.register(createMockAnalyzer("TypeScript"));

      await registry.cleanup();

      expect(registry.isSupported("TypeScript")).toBe(false);
      expect(registry.getRegisteredLanguages()).toEqual([]);
    });

    it("dispose()がエラーを投げても他のアナライザーは処理される", async () => {
      const registry = LanguageRegistry.getInstance();
      const errorDispose = vi.fn().mockRejectedValue(new Error("Dispose error"));
      const successDispose = vi.fn().mockResolvedValue(undefined);
      registry.register(createMockAnalyzer("TypeScript", {}, errorDispose));
      registry.register(createMockAnalyzer("Swift", {}, successDispose));

      // エラーをスローしないことを確認
      await expect(registry.cleanup()).resolves.toBeUndefined();

      expect(errorDispose).toHaveBeenCalledTimes(1);
      expect(successDispose).toHaveBeenCalledTimes(1);
    });

    it("dispose()がないアナライザーはスキップされる", async () => {
      const registry = LanguageRegistry.getInstance();
      registry.register(createMockAnalyzer("TypeScript"));

      // エラーなく完了することを確認
      await expect(registry.cleanup()).resolves.toBeUndefined();
    });
  });
});
