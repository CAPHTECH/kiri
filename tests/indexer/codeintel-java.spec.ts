import { describe, expect, it } from "vitest";

import { analyzeSource } from "../../src/indexer/codeintel.js";

describe("Java code intelligence", () => {
  describe("symbol extraction", () => {
    it("extracts class declaration with methods and fields", () => {
      const javaCode = `
/**
 * A sample class with documentation
 */
public class MyClass {
  private String field;

  public MyClass(String value) {
    this.field = value;
  }

  public String getField() {
    return field;
  }
}
`.trim();

      const result = analyzeSource("test.java", "Java", javaCode, new Set());

      expect(result.symbols).toHaveLength(4);

      // Class
      expect(result.symbols[0]).toMatchObject({
        symbolId: 1,
        name: "MyClass",
        kind: "class",
        rangeStartLine: 4,
        rangeEndLine: 14,
        doc: "A sample class with documentation",
      });
      expect(result.symbols[0]?.signature).toContain("class MyClass");

      // Field
      expect(result.symbols[1]).toMatchObject({
        symbolId: 2,
        name: "field",
        kind: "field",
        rangeStartLine: 5,
        rangeEndLine: 5,
      });

      // Constructor
      expect(result.symbols[2]).toMatchObject({
        symbolId: 3,
        name: "MyClass",
        kind: "constructor",
        rangeStartLine: 7,
        rangeEndLine: 9,
      });

      // Method
      expect(result.symbols[3]).toMatchObject({
        symbolId: 4,
        name: "getField",
        kind: "method",
        rangeStartLine: 11,
        rangeEndLine: 13,
      });
    });

    it("extracts interface declaration", () => {
      const javaCode = `
/**
 * Sample interface
 */
public interface MyInterface {
  String getValue();
  void setValue(String value);
}
`.trim();

      const result = analyzeSource("test.java", "Java", javaCode, new Set());

      expect(result.symbols).toHaveLength(3);
      expect(result.symbols[0]).toMatchObject({
        name: "MyInterface",
        kind: "interface",
        rangeStartLine: 4,
        rangeEndLine: 7,
        doc: "Sample interface",
      });
      expect(result.symbols[1]).toMatchObject({
        name: "getValue",
        kind: "method",
      });
      expect(result.symbols[2]).toMatchObject({
        name: "setValue",
        kind: "method",
      });
    });

    it("extracts Javadoc from methods with annotations", () => {
      const javaCode = `
public class MyClass {
  /**
   * Processes the input value
   * @param value the input value
   * @return processed value
   */
  @Override
  @Deprecated
  public String processValue(String value) {
    return value.toUpperCase();
  }
}
`.trim();

      const result = analyzeSource("test.java", "Java", javaCode, new Set());

      expect(result.symbols).toHaveLength(2);
      expect(result.symbols[0]).toMatchObject({
        name: "MyClass",
        kind: "class",
      });
      // アノテーション付きメソッドでもJavadocが正しく抽出される
      const method = result.symbols[1];
      expect(method).toMatchObject({
        name: "processValue",
        kind: "method",
      });
      expect(method?.doc).toBeTruthy();
      expect(method?.doc).toContain("Processes the input value");
      expect(method?.doc).toContain("@param value the input value");
      expect(method?.doc).toContain("@return processed value");
    });

    it("extracts enum declaration", () => {
      const javaCode = `
public enum Direction {
  NORTH,
  SOUTH,
  EAST,
  WEST
}
`.trim();

      const result = analyzeSource("test.java", "Java", javaCode, new Set());

      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0]).toMatchObject({
        name: "Direction",
        kind: "enum",
        rangeStartLine: 1,
        rangeEndLine: 6,
      });
    });

    it("extracts field declarations", () => {
      const javaCode = `
public class MyClass {
  private String name;
  private int age;
  public static final String CONSTANT = "value";
}
`.trim();

      const result = analyzeSource("test.java", "Java", javaCode, new Set());

      expect(result.symbols).toHaveLength(4);
      expect(result.symbols[0]).toMatchObject({
        name: "MyClass",
        kind: "class",
      });
      expect(result.symbols[1]).toMatchObject({
        name: "name",
        kind: "field",
      });
      expect(result.symbols[2]).toMatchObject({
        name: "age",
        kind: "field",
      });
      expect(result.symbols[3]).toMatchObject({
        name: "CONSTANT",
        kind: "field",
      });
    });

    it("extracts nested classes", () => {
      const javaCode = `
public class OuterClass {
  private String outerField;

  public class InnerClass {
    private String innerField;
  }

  public void outerMethod() {}
}
`.trim();

      const result = analyzeSource("test.java", "Java", javaCode, new Set());

      expect(result.symbols).toHaveLength(5);
      expect(result.symbols[0]).toMatchObject({
        name: "OuterClass",
        kind: "class",
      });
      expect(result.symbols[1]).toMatchObject({
        name: "outerField",
        kind: "field",
      });
      expect(result.symbols[2]).toMatchObject({
        name: "InnerClass",
        kind: "class",
      });
      expect(result.symbols[3]).toMatchObject({
        name: "innerField",
        kind: "field",
      });
      expect(result.symbols[4]).toMatchObject({
        name: "outerMethod",
        kind: "method",
      });
    });

    it("extracts annotation type declaration", () => {
      const javaCode = `
/**
 * Custom annotation
 */
public @interface MyAnnotation {
  String value();
  int priority() default 0;
}
`.trim();

      const result = analyzeSource("test.java", "Java", javaCode, new Set());

      expect(result.symbols).toHaveLength(3);
      expect(result.symbols[0]).toMatchObject({
        name: "MyAnnotation",
        kind: "annotation",
        doc: "Custom annotation",
      });
      expect(result.symbols[1]).toMatchObject({
        name: "value",
        kind: "method",
      });
      expect(result.symbols[2]).toMatchObject({
        name: "priority",
        kind: "method",
      });
    });
  });

  describe("dependency analysis", () => {
    it("extracts import statements for packages", () => {
      const javaCode = `
import java.util.List;
import java.util.ArrayList;

public class MyClass {}
`.trim();

      const result = analyzeSource("test.java", "Java", javaCode, new Set());

      expect(result.dependencies).toHaveLength(2);
      expect(result.dependencies).toContainEqual({
        dstKind: "package",
        dst: "java.util.List",
        rel: "import",
      });
      expect(result.dependencies).toContainEqual({
        dstKind: "package",
        dst: "java.util.ArrayList",
        rel: "import",
      });
    });

    it("detects local file imports as path dependencies", () => {
      const javaCode = `
import com.example.MyOtherClass;

public class MyClass {}
`.trim();

      const fileSet = new Set(["com/example/MyOtherClass.java"]);
      const result = analyzeSource("test.java", "Java", javaCode, fileSet);

      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0]).toMatchObject({
        dstKind: "path",
        dst: "com.example.MyOtherClass",
        rel: "import",
      });
    });

    it("detects local file imports with Maven/Gradle directory structure", () => {
      const javaCode = `
import com.example.MyOtherClass;
import com.example.util.Helper;

public class MyClass {}
`.trim();

      // Maven/Gradleの標準的なディレクトリ構造
      const fileSet = new Set([
        "src/main/java/com/example/MyOtherClass.java",
        "src/main/java/com/example/util/Helper.java",
        "src/test/java/com/example/MyClassTest.java",
      ]);
      const result = analyzeSource(
        "src/main/java/com/example/MyClass.java",
        "Java",
        javaCode,
        fileSet
      );

      expect(result.dependencies).toHaveLength(2);
      expect(result.dependencies[0]).toMatchObject({
        dstKind: "path",
        dst: "com.example.MyOtherClass",
        rel: "import",
      });
      expect(result.dependencies[1]).toMatchObject({
        dstKind: "path",
        dst: "com.example.util.Helper",
        rel: "import",
      });
    });

    it("resolves imports precisely when same filename exists in different packages", () => {
      const javaCode = `
import com.example.util.Helper;
import com.other.util.Helper;

public class MyClass {}
`.trim();

      // 同名ファイルが異なるパッケージに存在
      const fileSet = new Set([
        "src/main/java/com/example/util/Helper.java",
        "src/main/java/com/other/util/Helper.java",
      ]);
      const result = analyzeSource(
        "src/main/java/com/example/MyClass.java",
        "Java",
        javaCode,
        fileSet
      );

      expect(result.dependencies).toHaveLength(2);
      // 両方ともpathとして検出されるべき（それぞれ正しいファイルに対応）
      expect(result.dependencies[0]).toMatchObject({
        dstKind: "path",
        dst: "com.example.util.Helper",
        rel: "import",
      });
      expect(result.dependencies[1]).toMatchObject({
        dstKind: "path",
        dst: "com.other.util.Helper",
        rel: "import",
      });
    });

    it("does not match partial package paths with endsWith (wrong file first)", () => {
      const javaCode = `
import util.Helper;

public class MyClass {}
`.trim();

      // util.Helperが、より長いパスのファイルと誤マッチしないことを確認
      // 誤検出されるファイルを先に配置
      const fileSet = new Set([
        "src/main/java/com/example/util/Helper.java", // これと誤マッチすべきでない（が、find()で先に見つかる）
        "src/main/java/util/Helper.java", // これが正解
      ]);
      const result = analyzeSource("src/main/java/MyClass.java", "Java", javaCode, fileSet);

      expect(result.dependencies).toHaveLength(1);
      // 現在の実装（endsWith）だと、com/example/util/Helper.javaも util/Helper.javaで終わるため
      // 最初に見つかった方がマッチしてしまう可能性がある
      // 正しくは src/main/java/util/Helper.java のみがマッチすべき
      expect(result.dependencies[0]).toMatchObject({
        dstKind: "path",
        dst: "util.Helper",
        rel: "import",
      });
    });

    it("handles wildcard imports", () => {
      const javaCode = `
import java.util.*;

public class MyClass {}
`.trim();

      const result = analyzeSource("test.java", "Java", javaCode, new Set());

      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies[0]).toMatchObject({
        dstKind: "package",
        dst: "java.util.*",
        rel: "import",
      });
    });

    it("handles static imports", () => {
      const javaCode = `
import static java.lang.Math.PI;
import static java.util.Collections.*;

public class MyClass {}
`.trim();

      const result = analyzeSource("test.java", "Java", javaCode, new Set());

      expect(result.dependencies).toHaveLength(2);
      expect(result.dependencies).toContainEqual({
        dstKind: "package",
        dst: "java.lang.Math.PI",
        rel: "import",
      });
      expect(result.dependencies).toContainEqual({
        dstKind: "package",
        dst: "java.util.Collections.*",
        rel: "import",
      });
    });
  });

  describe("snippet generation", () => {
    it("creates snippets aligned to symbol boundaries", () => {
      const javaCode = `
public class MyClass {
  public void method1() {}
  public void method2() {}
}
`.trim();

      const result = analyzeSource("test.java", "Java", javaCode, new Set());

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

  describe("edge cases", () => {
    it("returns empty results for empty file", () => {
      const result = analyzeSource("test.java", "Java", "", new Set());

      expect(result.symbols).toHaveLength(0);
      expect(result.snippets).toHaveLength(0);
      expect(result.dependencies).toHaveLength(0);
    });

    it("handles file with only imports", () => {
      const javaCode = `
import java.util.List;
import java.util.ArrayList;
`.trim();

      const result = analyzeSource("test.java", "Java", javaCode, new Set());

      expect(result.symbols).toHaveLength(0);
      expect(result.dependencies).toHaveLength(2);
    });

    it("handles symbols without documentation", () => {
      const javaCode = `
public class UndocumentedClass {
  public void undocumentedMethod() {}
}
`.trim();

      const result = analyzeSource("test.java", "Java", javaCode, new Set());

      expect(result.symbols).toHaveLength(2);
      expect(result.symbols[0]?.doc).toBeNull();
      expect(result.symbols[1]?.doc).toBeNull();
    });

    it("truncates long signatures to 200 characters", () => {
      const longParams = Array.from({ length: 20 }, (_, i) => `String param${i}`).join(", ");
      const javaCode = `
public class MyClass {
  public String longMethod(${longParams}) {
    return "result";
  }
}
`.trim();

      const result = analyzeSource("test.java", "Java", javaCode, new Set());

      expect(result.symbols).toHaveLength(2);
      const signature = result.symbols[1]?.signature ?? "";
      expect(signature.length).toBeLessThanOrEqual(200);
      expect(signature).toContain("longMethod");
      expect(signature).not.toContain("return");
    });

    it("excludes method body from signature", () => {
      const javaCode = `
public class MyClass {
  public int calculate(int x) {
    int result = x * 2;
    return result;
  }
}
`.trim();

      const result = analyzeSource("test.java", "Java", javaCode, new Set());

      expect(result.symbols).toHaveLength(2);
      const signature = result.symbols[1]?.signature ?? "";
      expect(signature).toContain("calculate");
      expect(signature).not.toContain("result");
      expect(signature).not.toContain("return");
    });

    it("handles multi-line method signatures correctly", () => {
      const javaCode = `
public class MyClass {
  public String processData(
    String param1,
    int param2,
    boolean param3
  ) {
    return "result";
  }
}
`.trim();

      const result = analyzeSource("test.java", "Java", javaCode, new Set());

      expect(result.symbols).toHaveLength(2);
      const signature = result.symbols[1]?.signature ?? "";
      // 複数行シグネチャは1行に圧縮されるべき
      expect(signature).toContain("processData");
      expect(signature).toContain("param1");
      expect(signature).toContain("param2");
      expect(signature).toContain("param3");
      expect(signature).not.toContain("return");
      // 改行は空白に置き換えられるべき
      expect(signature).not.toContain("\n");
    });

    it("returns empty result for unsupported language", () => {
      const javaCode = `
public class MyClass {}
`.trim();

      const result = analyzeSource("test.java", "JavaScript", javaCode, new Set());

      expect(result.symbols).toHaveLength(0);
      expect(result.snippets).toHaveLength(0);
      expect(result.dependencies).toHaveLength(0);
    });

    it("handles generic types", () => {
      const javaCode = `
public class Container<T> {
  private T value;

  public T getValue() {
    return value;
  }
}
`.trim();

      const result = analyzeSource("test.java", "Java", javaCode, new Set());

      expect(result.symbols).toHaveLength(3);
      expect(result.symbols[0]).toMatchObject({
        name: "Container",
        kind: "class",
      });
      expect(result.symbols[0]?.signature).toContain("Container");
    });
  });
});
