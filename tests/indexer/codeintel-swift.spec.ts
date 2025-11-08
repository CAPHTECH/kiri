import { describe, expect, it } from "vitest";

import { analyzeSource } from "../../src/indexer/codeintel.js";

describe("Swift code intelligence", () => {
  describe("symbol extraction", () => {
    it("extracts class declaration with methods and properties", async () => {
      const swiftCode = `
/// A sample class with documentation
class MyClass {
  var property: String

  init(value: String) {
    self.property = value
  }

  func myMethod() -> String {
    return property
  }
}
`.trim();

      const result = await analyzeSource("test.swift", "Swift", swiftCode, new Set());

      expect(result.symbols).toHaveLength(4);

      // Class
      expect(result.symbols[0]).toMatchObject({
        symbolId: 1,
        name: "MyClass",
        kind: "class",
        rangeStartLine: 2,
        rangeEndLine: 12,
        doc: "A sample class with documentation",
      });
      expect(result.symbols[0]?.signature).toContain("class MyClass");

      // Property
      expect(result.symbols[1]).toMatchObject({
        symbolId: 2,
        name: "property",
        kind: "property",
        rangeStartLine: 3,
        rangeEndLine: 3,
      });

      // Initializer
      expect(result.symbols[2]).toMatchObject({
        symbolId: 3,
        name: "init",
        kind: "initializer",
        rangeStartLine: 5,
        rangeEndLine: 7,
      });

      // Method
      expect(result.symbols[3]).toMatchObject({
        symbolId: 4,
        name: "myMethod",
        kind: "method",
        rangeStartLine: 9,
        rangeEndLine: 11,
      });
    });

    it("extracts struct declaration", async () => {
      const swiftCode = `
struct Point {
  let x: Int
  let y: Int
}
`.trim();

      const result = await analyzeSource("test.swift", "Swift", swiftCode, new Set());

      expect(result.symbols).toHaveLength(3);
      expect(result.symbols[0]).toMatchObject({
        name: "Point",
        kind: "struct",
        rangeStartLine: 1,
        rangeEndLine: 4,
      });
      expect(result.symbols[1]).toMatchObject({
        name: "x",
        kind: "property",
      });
      expect(result.symbols[2]).toMatchObject({
        name: "y",
        kind: "property",
      });
    });

    it("extracts protocol declaration with methods", async () => {
      const swiftCode = `
/// Protocol documentation
protocol MyProtocol {
  func protocolMethod()
  func anotherMethod(param: String) -> Int
}
`.trim();

      const result = await analyzeSource("test.swift", "Swift", swiftCode, new Set());

      expect(result.symbols).toHaveLength(3);
      expect(result.symbols[0]).toMatchObject({
        name: "MyProtocol",
        kind: "protocol",
        doc: "Protocol documentation",
      });
      expect(result.symbols[1]).toMatchObject({
        name: "protocolMethod",
        kind: "protocol_method",
      });
      expect(result.symbols[2]).toMatchObject({
        name: "anotherMethod",
        kind: "protocol_method",
      });
    });

    it("extracts enum declaration with cases", async () => {
      const swiftCode = `
enum Direction {
  case north
  case south
  case east
  case west
}
`.trim();

      const result = await analyzeSource("test.swift", "Swift", swiftCode, new Set());

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0]).toMatchObject({
        name: "Direction",
        kind: "enum",
        rangeStartLine: 1,
        rangeEndLine: 6,
      });
    });

    it("extracts extension declaration", async () => {
      const swiftCode = `
extension String {
  var isNotEmpty: Bool {
    return !self.isEmpty
  }

  func customMethod() -> Bool {
    return !self.isEmpty
  }
}
`.trim();

      const result = await analyzeSource("test.swift", "Swift", swiftCode, new Set());

      expect(result.symbols).toHaveLength(3);
      expect(result.symbols[0]).toMatchObject({
        name: "String",
        kind: "extension",
      });
      expect(result.symbols[1]).toMatchObject({
        name: "isNotEmpty",
        kind: "property",
      });
      expect(result.symbols[2]).toMatchObject({
        name: "customMethod",
        kind: "method",
      });
    });

    it("extracts top-level function", async () => {
      const swiftCode = `
/// Function documentation
func topLevelFunction(param: Int) -> String {
  return "\\(param)"
}
`.trim();

      const result = await analyzeSource("test.swift", "Swift", swiftCode, new Set());

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0]).toMatchObject({
        name: "topLevelFunction",
        kind: "function",
        rangeStartLine: 2,
        rangeEndLine: 4,
        doc: "Function documentation",
      });
      expect(result.symbols[0]?.signature).toContain("func topLevelFunction");
    });

    it("handles nested classes and structs", async () => {
      const swiftCode = `
class OuterClass {
  struct InnerStruct {
    let value: Int
  }

  func outerMethod() {}
}
`.trim();

      const result = await analyzeSource("test.swift", "Swift", swiftCode, new Set());

      expect(result.symbols).toHaveLength(4);
      expect(result.symbols[0]).toMatchObject({
        name: "OuterClass",
        kind: "class",
      });
      expect(result.symbols[1]).toMatchObject({
        name: "InnerStruct",
        kind: "struct",
      });
      expect(result.symbols[2]).toMatchObject({
        name: "value",
        kind: "property",
      });
      expect(result.symbols[3]).toMatchObject({
        name: "outerMethod",
        kind: "method",
      });
    });

    it("extracts generic types", async () => {
      const swiftCode = `
struct Container<T> {
  var value: T

  func getValue() -> T {
    return value
  }
}
`.trim();

      const result = await analyzeSource("test.swift", "Swift", swiftCode, new Set());

      expect(result.symbols).toHaveLength(3);
      expect(result.symbols[0]).toMatchObject({
        name: "Container",
        kind: "struct",
      });
      expect(result.symbols[0]?.signature).toContain("Container");
    });

    it("extracts doc comments from block comments", async () => {
      const swiftCode = `
/**
 * Multi-line documentation
 * for a function
 */
func documentedFunction() {}
`.trim();

      const result = await analyzeSource("test.swift", "Swift", swiftCode, new Set());

      expect(result.symbols).toHaveLength(1);
      const symbol = result.symbols[0];
      expect(symbol?.doc).toBeTruthy();
      if (symbol?.doc) {
        expect(symbol.doc).toContain("Multi-line documentation");
        expect(symbol.doc).toContain("for a function");
      }
    });
  });

  describe("snippet generation", () => {
    it("creates snippets aligned to symbol boundaries", async () => {
      const swiftCode = `
class MyClass {
  func method1() {}
  func method2() {}
}
`.trim();

      const result = await analyzeSource("test.swift", "Swift", swiftCode, new Set());

      expect(result.snippets).toHaveLength(3);
      expect(result.snippets[0]).toMatchObject({
        startLine: 1,
        endLine: 4,
        symbolId: 1, // MyClass
      });
      expect(result.snippets[1]).toMatchObject({
        startLine: 2,
        endLine: 2,
        symbolId: 2, // method1
      });
      expect(result.snippets[2]).toMatchObject({
        startLine: 3,
        endLine: 3,
        symbolId: 3, // method2
      });
    });
  });

  describe("dependency analysis", () => {
    it("extracts import statements as package dependencies", async () => {
      const swiftCode = `
import Foundation
import UIKit

class MyClass {}
`.trim();

      const result = await analyzeSource("test.swift", "Swift", swiftCode, new Set());

      expect(result.dependencies).toHaveLength(2);
      expect(result.dependencies[0]).toMatchObject({
        dstKind: "package",
        dst: "Foundation",
        rel: "import",
      });
      expect(result.dependencies[1]).toMatchObject({
        dstKind: "package",
        dst: "UIKit",
        rel: "import",
      });
    });

    it("detects local file imports as path dependencies", async () => {
      const swiftCode = `
import MyModule

class MyClass {}
`.trim();

      const fileSet = new Set(["MyModule.swift"]);
      const result = await analyzeSource("test.swift", "Swift", swiftCode, fileSet);

      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0]).toMatchObject({
        dstKind: "path",
        dst: "MyModule.swift",
        rel: "import",
      });
    });

    it("handles multiple import statements", async () => {
      const swiftCode = `
import Foundation
import CoreData
import Combine
`.trim();

      const result = await analyzeSource("test.swift", "Swift", swiftCode, new Set());

      expect(result.dependencies).toHaveLength(3);
      const moduleNames = result.dependencies.map((d) => d.dst);
      expect(moduleNames).toEqual(["Foundation", "CoreData", "Combine"]);
    });
  });

  describe("signature extraction", () => {
    it("truncates signatures to 200 characters", async () => {
      const longSignature = `
func veryLongFunctionNameWithManyParameters(param1: String, param2: Int, param3: Bool, param4: Double, param5: Array<String>, param6: Dictionary<String, Any>, param7: Set<Int>, param8: Optional<String>) -> Result<String, Error> {
  return .success("test")
}
`.trim();

      const result = await analyzeSource("test.swift", "Swift", longSignature, new Set());

      expect(result.symbols).toHaveLength(1);
      const signature = result.symbols[0]?.signature;
      expect(signature).toBeTruthy();
      if (signature) {
        expect(signature.length).toBeLessThanOrEqual(200);
        expect(signature).toContain("veryLongFunctionNameWithManyParameters");
      }
    });

    it("excludes function body from signature", async () => {
      const swiftCode = `
func myFunction() -> Int {
  let x = 42
  return x
}
`.trim();

      const result = await analyzeSource("test.swift", "Swift", swiftCode, new Set());

      expect(result.symbols).toHaveLength(1);
      const signature = result.symbols[0]?.signature;
      expect(signature).toBeTruthy();
      if (signature) {
        expect(signature).not.toContain("let x");
        expect(signature).not.toContain("return x");
      }
    });
  });

  describe("edge cases", () => {
    it("returns empty results for empty file", async () => {
      const result = await analyzeSource("test.swift", "Swift", "", new Set());

      expect(result.symbols).toHaveLength(0);
      expect(result.snippets).toHaveLength(0);
      expect(result.dependencies).toHaveLength(0);
    });

    it("handles files with only imports", async () => {
      const swiftCode = "import Foundation";

      const result = await analyzeSource("test.swift", "Swift", swiftCode, new Set());

      expect(result.symbols).toHaveLength(0);
      expect(result.dependencies).toHaveLength(1);
    });

    it("handles symbols without documentation", async () => {
      const swiftCode = `
class UndocumentedClass {
  func undocumentedMethod() {}
}
`.trim();

      const result = await analyzeSource("test.swift", "Swift", swiftCode, new Set());

      expect(result.symbols).toHaveLength(2);
      expect(result.symbols[0]?.doc).toBeNull();
      expect(result.symbols[1]?.doc).toBeNull();
    });
  });
});
