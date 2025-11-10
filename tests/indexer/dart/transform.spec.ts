/**
 * Tests for Outline → SymbolRecord transformation (src/indexer/dart/transform.ts)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { outlineToSymbols } from "../../../src/indexer/dart/transform.js";
import type { Outline } from "../../../src/indexer/dart/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("Outline to SymbolRecord transformation", () => {
  const sampleContent = `class Greeter<T> {
  String greeting;
  String sayHello(String name) {
    return "Hello, $name";
  }
}

void main() {
  print("test");
}
`;

  describe("basic symbol extraction", () => {
    it("extracts class and method from basic outline", () => {
      const outlineJson = readFileSync(
        join(__dirname, "__fixtures__", "outline-basic.json"),
        "utf-8"
      );
      const outline = JSON.parse(outlineJson) as Outline;

      const result = outlineToSymbols(outline, sampleContent);

      // Should extract: Greeter class, sayHello method, greeting field, main function
      expect(result.symbols.length).toBeGreaterThanOrEqual(3);

      const greeter = result.symbols.find((s) => s.name === "Greeter");
      const sayHello = result.symbols.find((s) => s.name === "sayHello");
      const greeting = result.symbols.find((s) => s.name === "greeting");

      expect(greeter).toMatchObject({
        name: "Greeter",
        kind: "class",
        doc: "A simple greeter class",
      });
      expect(sayHello).toMatchObject({
        name: "sayHello",
        kind: "function",
      });
      expect(greeting).toMatchObject({
        name: "greeting",
        kind: "property",
      });
    });

    it("generates snippets for each symbol", () => {
      const outlineJson = readFileSync(
        join(__dirname, "__fixtures__", "outline-basic.json"),
        "utf-8"
      );
      const outline = JSON.parse(outlineJson) as Outline;

      const result = outlineToSymbols(outline, sampleContent);

      expect(result.snippets.length).toBeGreaterThanOrEqual(3);
      expect(result.snippets[0]).toMatchObject({
        startLine: expect.any(Number),
        endLine: expect.any(Number),
        symbolId: expect.any(Number),
      });
    });
  });

  describe("ElementKind mapping", () => {
    it("maps CLASS to 'class' kind", () => {
      const outline: Outline = {
        kind: "COMPILATION_UNIT",
        offset: 0,
        length: 50,
        element: { kind: "COMPILATION_UNIT", name: "test.dart" },
        children: [
          {
            kind: "CLASS",
            offset: 0,
            length: 50,
            element: { kind: "CLASS", name: "MyClass" },
          },
        ],
      };

      const result = outlineToSymbols(outline, "class MyClass {}");

      expect(result.symbols[0]?.kind).toBe("class");
    });

    it("maps ENUM to 'class' kind", () => {
      const outline: Outline = {
        kind: "COMPILATION_UNIT",
        offset: 0,
        length: 50,
        element: { kind: "COMPILATION_UNIT", name: "test.dart" },
        children: [
          {
            kind: "ENUM",
            offset: 0,
            length: 50,
            element: { kind: "ENUM", name: "Status" },
          },
        ],
      };

      const result = outlineToSymbols(outline, "enum Status {}");

      expect(result.symbols[0]?.kind).toBe("class");
    });

    it("maps MIXIN and EXTENSION to 'class' kind", () => {
      const outline: Outline = {
        kind: "COMPILATION_UNIT",
        offset: 0,
        length: 100,
        element: { kind: "COMPILATION_UNIT", name: "test.dart" },
        children: [
          {
            kind: "MIXIN",
            offset: 0,
            length: 50,
            element: { kind: "MIXIN", name: "MyMixin" },
          },
          {
            kind: "EXTENSION",
            offset: 55,
            length: 45,
            element: { kind: "EXTENSION", name: "MyExtension" },
          },
        ],
      };

      const result = outlineToSymbols(outline, "mixin MyMixin {}\nextension MyExtension {}");

      expect(result.symbols[0]?.kind).toBe("class");
      expect(result.symbols[1]?.kind).toBe("class");
    });

    it("maps GETTER/SETTER to 'function' kind", () => {
      const outlineJson = readFileSync(
        join(__dirname, "__fixtures__", "outline-nested.json"),
        "utf-8"
      );
      const outline = JSON.parse(outlineJson) as Outline;

      const result = outlineToSymbols(outline, "");

      // Find getter and setter by checking for GETTER/SETTER in element kind (from fixture)
      const allSymbols = result.symbols.filter((s) => s.name === "value");

      expect(allSymbols.length).toBeGreaterThanOrEqual(1);
      // In MVP, both getters and setters map to "function" kind
      allSymbols.forEach((symbol) => {
        expect(symbol.kind).toBe("function");
      });
    });

    it("maps ENUM_CONSTANT to 'property' kind", () => {
      const outlineJson = readFileSync(
        join(__dirname, "__fixtures__", "outline-nested.json"),
        "utf-8"
      );
      const outline = JSON.parse(outlineJson) as Outline;

      const result = outlineToSymbols(outline, "");

      const constants = result.symbols.filter((s) => s.name === "active" || s.name === "inactive");

      expect(constants).toHaveLength(2);
      expect(constants[0]?.kind).toBe("property");
      expect(constants[1]?.kind).toBe("property");
    });
  });

  describe("signature generation", () => {
    it("builds signature from return type, name, and parameters", () => {
      const outline: Outline = {
        kind: "COMPILATION_UNIT",
        offset: 0,
        length: 50,
        element: { kind: "COMPILATION_UNIT", name: "test.dart" },
        children: [
          {
            kind: "FUNCTION",
            offset: 0,
            length: 50,
            element: {
              kind: "FUNCTION",
              name: "calculate",
              returnType: "int",
              parameters: "(int a, int b)",
              typeParameters: "<T>",
            },
          },
        ],
      };

      const result = outlineToSymbols(outline, "int calculate<T>(int a, int b) {}");

      expect(result.symbols[0]?.signature).toContain("int");
      expect(result.symbols[0]?.signature).toContain("calculate");
      expect(result.symbols[0]?.signature).toContain("<T>");
      expect(result.symbols[0]?.signature).toContain("(int a, int b)");
    });

    it("returns null signature for fields without parameters", () => {
      const outline: Outline = {
        kind: "COMPILATION_UNIT",
        offset: 0,
        length: 50,
        element: { kind: "COMPILATION_UNIT", name: "test.dart" },
        children: [
          {
            kind: "FIELD",
            offset: 0,
            length: 20,
            element: { kind: "FIELD", name: "counter" },
          },
        ],
      };

      const result = outlineToSymbols(outline, "int counter;");

      expect(result.symbols[0]?.signature).toBeNull();
    });
  });

  describe("offset to line number conversion", () => {
    it("correctly maps offsets to line numbers", () => {
      const content = "line 1\nline 2\nline 3";
      const outline: Outline = {
        kind: "COMPILATION_UNIT",
        offset: 0,
        length: content.length,
        element: { kind: "COMPILATION_UNIT", name: "test.dart" },
        children: [
          {
            kind: "FUNCTION",
            offset: 0, // line 1
            length: 6,
            element: { kind: "FUNCTION", name: "func1" },
          },
          {
            kind: "FUNCTION",
            offset: 7, // line 2
            length: 6,
            element: { kind: "FUNCTION", name: "func2" },
          },
        ],
      };

      const result = outlineToSymbols(outline, content);

      expect(result.symbols[0]?.rangeStartLine).toBe(1);
      expect(result.symbols[1]?.rangeStartLine).toBe(2);
    });
  });

  describe("nested symbols", () => {
    it("flattens nested symbols from outline hierarchy", () => {
      const outlineJson = readFileSync(
        join(__dirname, "__fixtures__", "outline-nested.json"),
        "utf-8"
      );
      const outline = JSON.parse(outlineJson) as Outline;

      const result = outlineToSymbols(outline, "");

      // Should include: Outer class, process method, value getter, value setter, Status enum, active constant, inactive constant
      expect(result.symbols.length).toBeGreaterThanOrEqual(5);

      const outerClass = result.symbols.find((s) => s.name === "Outer");
      const processMethod = result.symbols.find((s) => s.name === "process");

      expect(outerClass).toBeDefined();
      expect(processMethod).toBeDefined();
    });

    it("sorts symbols by line number", () => {
      const outlineJson = readFileSync(
        join(__dirname, "__fixtures__", "outline-nested.json"),
        "utf-8"
      );
      const outline = JSON.parse(outlineJson) as Outline;

      const result = outlineToSymbols(outline, "");

      for (let i = 0; i < result.symbols.length - 1; i++) {
        expect(result.symbols[i]!.rangeStartLine).toBeLessThanOrEqual(
          result.symbols[i + 1]!.rangeStartLine
        );
      }
    });
  });
});
