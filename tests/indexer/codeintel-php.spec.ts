import { describe, expect, it } from "vitest";

import { analyzeSource } from "../../src/indexer/codeintel.js";

describe("PHP code intelligence", () => {
  describe("symbol extraction", () => {
    it("extracts class declaration with methods and properties", () => {
      const phpCode = `<?php
/**
 * A sample class with documentation
 */
class MyClass {
  private $property;

  public function __construct($value) {
    $this->property = $value;
  }

  public function myMethod() {
    return $this->property;
  }
}`;

      const result = analyzeSource("test.php", "PHP", phpCode, new Set());

      expect(result.symbols).toHaveLength(4);

      // Class
      expect(result.symbols[0]).toMatchObject({
        symbolId: 1,
        name: "MyClass",
        kind: "class",
        rangeStartLine: 5,
        rangeEndLine: 15,
        doc: "A sample class with documentation",
      });
      expect(result.symbols[0]?.signature).toContain("class MyClass");

      // Property
      expect(result.symbols[1]).toMatchObject({
        symbolId: 2,
        name: "property",
        kind: "property",
        rangeStartLine: 6,
        rangeEndLine: 6,
      });

      // Constructor method
      expect(result.symbols[2]).toMatchObject({
        symbolId: 3,
        name: "__construct",
        kind: "method",
        rangeStartLine: 8,
        rangeEndLine: 10,
      });

      // Method
      expect(result.symbols[3]).toMatchObject({
        symbolId: 4,
        name: "myMethod",
        kind: "method",
        rangeStartLine: 12,
        rangeEndLine: 14,
      });
    });

    it("extracts interface declaration", () => {
      const phpCode = `<?php
/**
 * Sample interface
 */
interface MyInterface {
  public function myMethod();
  public function anotherMethod($param);
}`;

      const result = analyzeSource("test.php", "PHP", phpCode, new Set());

      expect(result.symbols).toHaveLength(3);
      expect(result.symbols[0]).toMatchObject({
        name: "MyInterface",
        kind: "interface",
        rangeStartLine: 5,
        rangeEndLine: 8,
        doc: "Sample interface",
      });
      expect(result.symbols[1]).toMatchObject({
        name: "myMethod",
        kind: "method",
      });
      expect(result.symbols[2]).toMatchObject({
        name: "anotherMethod",
        kind: "method",
      });
    });

    it("extracts trait declaration", () => {
      const phpCode = `<?php
trait MyTrait {
  private $traitProperty;

  public function traitMethod() {
    return $this->traitProperty;
  }
}`;

      const result = analyzeSource("test.php", "PHP", phpCode, new Set());

      expect(result.symbols).toHaveLength(3);
      expect(result.symbols[0]).toMatchObject({
        name: "MyTrait",
        kind: "trait",
        rangeStartLine: 2,
        rangeEndLine: 8,
      });
      expect(result.symbols[1]).toMatchObject({
        name: "traitProperty",
        kind: "property",
      });
      expect(result.symbols[2]).toMatchObject({
        name: "traitMethod",
        kind: "method",
      });
    });

    it("extracts top-level function", () => {
      const phpCode = `<?php
/**
 * A top-level function
 */
function myFunction($param1, $param2) {
  return $param1 + $param2;
}`;

      const result = analyzeSource("test.php", "PHP", phpCode, new Set());

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0]).toMatchObject({
        name: "myFunction",
        kind: "function",
        rangeStartLine: 5,
        rangeEndLine: 7,
        doc: "A top-level function",
      });
      expect(result.symbols[0]?.signature).toContain("function myFunction");
    });

    it("extracts namespace declaration", () => {
      const phpCode = `<?php
namespace App\\Services;

class MyService {
  public function process() {
    return true;
  }
}`;

      const result = analyzeSource("test.php", "PHP", phpCode, new Set());

      expect(result.symbols).toHaveLength(3);
      expect(result.symbols[0]).toMatchObject({
        name: "App\\Services",
        kind: "namespace",
        rangeStartLine: 2,
        rangeEndLine: 2, // namespace宣言は1行のみ
      });
      expect(result.symbols[1]).toMatchObject({
        name: "MyService",
        kind: "class",
      });
      expect(result.symbols[2]).toMatchObject({
        name: "process",
        kind: "method",
      });
    });

    it("extracts class constants", () => {
      const phpCode = `<?php
class MyClass {
  const VERSION = '1.0.0';
  const STATUS_ACTIVE = 1;
}`;

      const result = analyzeSource("test.php", "PHP", phpCode, new Set());

      expect(result.symbols).toHaveLength(3);
      expect(result.symbols[0]).toMatchObject({
        name: "MyClass",
        kind: "class",
      });
      expect(result.symbols[1]).toMatchObject({
        name: "VERSION",
        kind: "constant",
      });
      expect(result.symbols[2]).toMatchObject({
        name: "STATUS_ACTIVE",
        kind: "constant",
      });
    });

    it("extracts static methods and properties", () => {
      const phpCode = `<?php
class StaticExample {
  private static $counter = 0;

  public static function increment() {
    self::$counter++;
  }
}`;

      const result = analyzeSource("test.php", "PHP", phpCode, new Set());

      expect(result.symbols).toHaveLength(3);
      expect(result.symbols[0]).toMatchObject({
        name: "StaticExample",
        kind: "class",
      });
      expect(result.symbols[1]).toMatchObject({
        name: "counter",
        kind: "property",
      });
      expect(result.symbols[2]).toMatchObject({
        name: "increment",
        kind: "method",
      });
    });

    it("extracts abstract classes and methods", () => {
      const phpCode = `<?php
abstract class AbstractClass {
  abstract public function abstractMethod();

  public function concreteMethod() {
    return 'concrete';
  }
}`;

      const result = analyzeSource("test.php", "PHP", phpCode, new Set());

      expect(result.symbols).toHaveLength(3);
      expect(result.symbols[0]).toMatchObject({
        name: "AbstractClass",
        kind: "class",
      });
      expect(result.symbols[1]).toMatchObject({
        name: "abstractMethod",
        kind: "method",
      });
      expect(result.symbols[2]).toMatchObject({
        name: "concreteMethod",
        kind: "method",
      });
    });

    it("extracts visibility modifiers correctly", () => {
      const phpCode = `<?php
class VisibilityExample {
  public $publicProp;
  protected $protectedProp;
  private $privateProp;

  public function publicMethod() {}
  protected function protectedMethod() {}
  private function privateMethod() {}
}`;

      const result = analyzeSource("test.php", "PHP", phpCode, new Set());

      expect(result.symbols).toHaveLength(7);
      expect(result.symbols[0]).toMatchObject({
        name: "VisibilityExample",
        kind: "class",
      });
      // Properties
      expect(result.symbols[1]?.name).toBe("publicProp");
      expect(result.symbols[2]?.name).toBe("protectedProp");
      expect(result.symbols[3]?.name).toBe("privateProp");
      // Methods
      expect(result.symbols[4]?.name).toBe("publicMethod");
      expect(result.symbols[5]?.name).toBe("protectedMethod");
      expect(result.symbols[6]?.name).toBe("privateMethod");
    });

    it("handles multiple classes in one file", () => {
      const phpCode = `<?php
class FirstClass {
  public function firstMethod() {}
}

class SecondClass {
  public function secondMethod() {}
}`;

      const result = analyzeSource("test.php", "PHP", phpCode, new Set());

      expect(result.symbols).toHaveLength(4);
      expect(result.symbols[0]).toMatchObject({
        name: "FirstClass",
        kind: "class",
      });
      expect(result.symbols[1]).toMatchObject({
        name: "firstMethod",
        kind: "method",
      });
      expect(result.symbols[2]).toMatchObject({
        name: "SecondClass",
        kind: "class",
      });
      expect(result.symbols[3]).toMatchObject({
        name: "secondMethod",
        kind: "method",
      });
    });
  });

  describe("snippet generation", () => {
    it("generates snippets aligned to symbol boundaries", () => {
      const phpCode = `<?php
class MyClass {
  public function myMethod() {
    return 'hello';
  }
}`;

      const result = analyzeSource("test.php", "PHP", phpCode, new Set());

      expect(result.snippets).toHaveLength(2);
      expect(result.snippets[0]).toMatchObject({
        startLine: 2,
        endLine: 6,
        symbolId: 1, // MyClass
      });
      expect(result.snippets[1]).toMatchObject({
        startLine: 3,
        endLine: 5,
        symbolId: 2, // myMethod
      });
    });
  });

  describe("dependency analysis", () => {
    it("extracts use statements for packages", () => {
      const phpCode = `<?php
use App\\Services\\MyService;
use Vendor\\Package\\AnotherClass;

class MyClass {
  public function test() {}
}`;

      const result = analyzeSource("test.php", "PHP", phpCode, new Set());

      expect(result.dependencies).toHaveLength(2);
      expect(result.dependencies).toContainEqual({
        dstKind: "package",
        dst: "App\\Services\\MyService",
        rel: "import",
      });
      expect(result.dependencies).toContainEqual({
        dstKind: "package",
        dst: "Vendor\\Package\\AnotherClass",
        rel: "import",
      });
    });

    it("extracts multiple use statements from grouped imports", () => {
      const phpCode = `<?php
use App\\Services\\{ServiceA, ServiceB, ServiceC};

class MyClass {
  public function test() {}
}`;

      const result = analyzeSource("test.php", "PHP", phpCode, new Set());

      expect(result.dependencies).toHaveLength(3);
      expect(result.dependencies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            dstKind: "package",
            dst: "App\\Services\\ServiceA",
            rel: "import",
          }),
          expect.objectContaining({
            dstKind: "package",
            dst: "App\\Services\\ServiceB",
            rel: "import",
          }),
          expect.objectContaining({
            dstKind: "package",
            dst: "App\\Services\\ServiceC",
            rel: "import",
          }),
        ])
      );
    });

    it("handles aliased imports", () => {
      const phpCode = `<?php
use App\\Services\\LongServiceName as Service;

class MyClass {
  public function test() {}
}`;

      const result = analyzeSource("test.php", "PHP", phpCode, new Set());

      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0]?.dst).toContain("LongServiceName");
    });

    it("detects local file dependencies if they exist in fileSet", () => {
      const phpCode = `<?php
use App\\Services\\MyService;`;

      const fileSet = new Set(["App/Services/MyService.php"]);
      const result = analyzeSource("test.php", "PHP", phpCode, fileSet);

      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0]?.dstKind).toBe("path");
    });
  });

  describe("signature extraction", () => {
    it("truncates long signatures to 200 characters", () => {
      const longParams = Array.from({ length: 20 }, (_, i) => `$param${i}`).join(", ");
      const phpCode = `<?php
function longFunction(${longParams}) {
  return 'result';
}`;

      const result = analyzeSource("test.php", "PHP", phpCode, new Set());

      expect(result.symbols).toHaveLength(1);
      const signature = result.symbols[0]?.signature ?? "";
      expect(signature.length).toBeLessThanOrEqual(200);
      expect(signature).toContain("function longFunction");
      expect(signature).not.toContain("return");
    });

    it("excludes function body from signature", () => {
      const phpCode = `<?php
function myFunction($param) {
  $result = $param * 2;
  return $result;
}`;

      const result = analyzeSource("test.php", "PHP", phpCode, new Set());

      expect(result.symbols).toHaveLength(1);
      const signature = result.symbols[0]?.signature ?? "";
      expect(signature).toContain("function myFunction");
      expect(signature).not.toContain("$result");
      expect(signature).not.toContain("return");
    });

    it("compresses signature to single line", () => {
      const phpCode = `<?php
function multilineFunction(
  $param1,
  $param2,
  $param3
) {
  return 'result';
}`;

      const result = analyzeSource("test.php", "PHP", phpCode, new Set());

      expect(result.symbols).toHaveLength(1);
      const signature = result.symbols[0]?.signature ?? "";
      expect(signature).not.toContain("\n");
      expect(signature).toContain("function multilineFunction");
    });
  });

  describe("PHPDoc comment extraction", () => {
    it("extracts /** */ style documentation", () => {
      const phpCode = `<?php
/**
 * This is a class documentation
 * with multiple lines
 */
class MyClass {
  /**
   * This is a method documentation
   * @param string $param
   * @return void
   */
  public function myMethod($param) {}
}`;

      const result = analyzeSource("test.php", "PHP", phpCode, new Set());

      expect(result.symbols).toHaveLength(2);
      expect(result.symbols[0]?.doc).toContain("This is a class documentation");
      expect(result.symbols[0]?.doc).toContain("with multiple lines");
      expect(result.symbols[1]?.doc).toContain("This is a method documentation");
      expect(result.symbols[1]?.doc).toContain("@param string $param");
      expect(result.symbols[1]?.doc).toContain("@return void");
    });

    it("does not extract non-PHPDoc comments", () => {
      const phpCode = `<?php
// This is a single-line comment
class MyClass {
  /* This is a multi-line comment */
  public function myMethod() {}
}`;

      const result = analyzeSource("test.php", "PHP", phpCode, new Set());

      expect(result.symbols).toHaveLength(2);
      expect(result.symbols[0]?.doc).toBeNull();
      expect(result.symbols[1]?.doc).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("handles empty PHP file", () => {
      const phpCode = "<?php\n";

      const result = analyzeSource("test.php", "PHP", phpCode, new Set());

      expect(result.symbols).toHaveLength(0);
      expect(result.snippets).toHaveLength(0);
      expect(result.dependencies).toHaveLength(0);
    });

    it("handles file with only imports", () => {
      const phpCode = `<?php
use App\\Services\\MyService;
use Vendor\\Package\\AnotherClass;`;

      const result = analyzeSource("test.php", "PHP", phpCode, new Set());

      expect(result.symbols).toHaveLength(0);
      expect(result.dependencies).toHaveLength(2);
    });

    it("handles symbols without documentation", () => {
      const phpCode = `<?php
class UndocumentedClass {
  public function undocumentedMethod() {}
}`;

      const result = analyzeSource("test.php", "PHP", phpCode, new Set());

      expect(result.symbols).toHaveLength(2);
      expect(result.symbols[0]?.doc).toBeNull();
      expect(result.symbols[1]?.doc).toBeNull();
    });

    it("handles nested classes (PHP 7.0+ anonymous classes)", () => {
      const phpCode = `<?php
class OuterClass {
  public function getAnonymousClass() {
    return new class {
      public function innerMethod() {}
    };
  }
}`;

      const result = analyzeSource("test.php", "PHP", phpCode, new Set());

      // Should extract outer class and its method at minimum
      expect(result.symbols.length).toBeGreaterThanOrEqual(2);
      expect(result.symbols[0]).toMatchObject({
        name: "OuterClass",
        kind: "class",
      });
    });

    it("returns empty result for unsupported language", () => {
      const phpCode = `<?php
class MyClass {}`;

      const result = analyzeSource("test.php", "JavaScript", phpCode, new Set());

      expect(result.symbols).toHaveLength(0);
      expect(result.snippets).toHaveLength(0);
      expect(result.dependencies).toHaveLength(0);
    });
  });

  describe("HTML-mixed PHP", () => {
    it("extracts symbols from HTML-mixed PHP files", () => {
      const htmlMixedCode = `<!DOCTYPE html>
<html>
<head>
    <title>Test Page</title>
</head>
<body>
    <h1>Welcome</h1>
    <?php
    class MyClass {
        public function test() {
            return "Hello";
        }
    }

    function myFunction() {
        return 42;
    }
    ?>
    <div>Content</div>
    <?php
    $variable = "test";
    ?>
</body>
</html>`;

      const result = analyzeSource("test.php", "PHP", htmlMixedCode, new Set());

      // Should extract class, method, and function
      expect(result.symbols).toHaveLength(3);
      expect(result.symbols[0]).toMatchObject({
        name: "MyClass",
        kind: "class",
      });
      expect(result.symbols[1]).toMatchObject({
        name: "test",
        kind: "method",
      });
      expect(result.symbols[2]).toMatchObject({
        name: "myFunction",
        kind: "function",
      });
    });

    it("extracts dependencies from HTML-mixed PHP files", () => {
      const htmlMixedCode = `<!DOCTYPE html>
<html>
<body>
    <?php
    use App\\Services\\MyService;
    use Vendor\\Package\\{ClassA, ClassB};

    class MyClass {
        public function test() {}
    }
    ?>
</body>
</html>`;

      const result = analyzeSource("test.php", "PHP", htmlMixedCode, new Set());

      expect(result.dependencies).toHaveLength(3);
      expect(result.dependencies).toContainEqual({
        dstKind: "package",
        dst: "App\\Services\\MyService",
        rel: "import",
      });
      expect(result.dependencies).toContainEqual({
        dstKind: "package",
        dst: "Vendor\\Package\\ClassA",
        rel: "import",
      });
      expect(result.dependencies).toContainEqual({
        dstKind: "package",
        dst: "Vendor\\Package\\ClassB",
        rel: "import",
      });
    });

    it("handles multiple PHP blocks in HTML", () => {
      const htmlMixedCode = `<!DOCTYPE html>
<html>
<body>
    <?php
    class FirstClass {
        public function first() {}
    }
    ?>
    <div>Some HTML</div>
    <?php
    class SecondClass {
        public function second() {}
    }
    ?>
</body>
</html>`;

      const result = analyzeSource("test.php", "PHP", htmlMixedCode, new Set());

      expect(result.symbols).toHaveLength(4);
      expect(result.symbols[0]?.name).toBe("FirstClass");
      expect(result.symbols[1]?.name).toBe("first");
      expect(result.symbols[2]?.name).toBe("SecondClass");
      expect(result.symbols[3]?.name).toBe("second");
    });

    it("detects pure PHP files correctly", () => {
      const purePhpCode = `<?php
class MyClass {
    public function test() {}
}`;

      const result = analyzeSource("test.php", "PHP", purePhpCode, new Set());

      expect(result.symbols).toHaveLength(2);
      expect(result.symbols[0]).toMatchObject({
        name: "MyClass",
        kind: "class",
      });
    });

    it("handles PHP files without <?php tag as HTML-mixed", () => {
      const noTagCode = `<html>
<body>
    <h1>No PHP here</h1>
</body>
</html>`;

      const result = analyzeSource("test.php", "PHP", noTagCode, new Set());

      // Should parse without errors but extract no symbols
      expect(result.symbols).toHaveLength(0);
    });
  });
});
