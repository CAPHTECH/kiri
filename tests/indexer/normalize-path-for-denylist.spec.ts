import { describe, expect, it } from "vitest";

import { normalizePathForDenylist } from "../../src/indexer/cli.js";

describe("normalizePathForDenylist", () => {
  describe("正規化機能", () => {
    it("通常のパスはそのまま返す", () => {
      expect(normalizePathForDenylist("foo/bar.ts")).toBe("foo/bar.ts");
    });

    it("先頭の ./ を除去する", () => {
      expect(normalizePathForDenylist("./foo/bar.ts")).toBe("foo/bar.ts");
    });

    it("先頭の / を除去する（絶対パス→相対パス）", () => {
      expect(normalizePathForDenylist("/foo/bar.ts")).toBe("foo/bar.ts");
    });

    it("先頭の ./ と / の両方を処理する", () => {
      // ./ が先に除去され、その後 / は先頭にないのでそのまま
      expect(normalizePathForDenylist("./foo/bar.ts")).toBe("foo/bar.ts");
    });

    it("バックスラッシュをスラッシュに変換する（Windows対応）", () => {
      expect(normalizePathForDenylist("foo\\bar.ts")).toBe("foo/bar.ts");
    });

    it("Windows形式の .\\path を正規化する", () => {
      expect(normalizePathForDenylist(".\\foo\\bar.ts")).toBe("foo/bar.ts");
    });
  });

  describe("パストラバーサル検出（セキュリティ）", () => {
    it("先頭の .. を検出してエラーにする", () => {
      expect(() => normalizePathForDenylist("../etc/passwd")).toThrow("Path traversal detected");
    });

    it("中間の .. を検出してエラーにする", () => {
      expect(() => normalizePathForDenylist("foo/../bar.ts")).toThrow("Path traversal detected");
    });

    it("末尾の .. を検出してエラーにする", () => {
      expect(() => normalizePathForDenylist("foo/bar/..")).toThrow("Path traversal detected");
    });

    it("複数の .. を検出してエラーにする", () => {
      expect(() => normalizePathForDenylist("../../secret")).toThrow("Path traversal detected");
    });

    it("Windows形式の .. を検出してエラーにする", () => {
      expect(() => normalizePathForDenylist("foo\\..\\bar")).toThrow("Path traversal detected");
    });

    it("単独の .. を検出してエラーにする", () => {
      expect(() => normalizePathForDenylist("..")).toThrow("Path traversal detected");
    });
  });

  describe("誤検知回避（PR #214 修正対象）", () => {
    it("Next.js catch-all ルート [...all] を許可する", () => {
      expect(normalizePathForDenylist("api/auth/[...all]/route.ts")).toBe(
        "api/auth/[...all]/route.ts"
      );
    });

    it("ファイル名内の .. を許可する", () => {
      expect(normalizePathForDenylist("foo/bar..baz.ts")).toBe("foo/bar..baz.ts");
    });

    it("ディレクトリ名内の .. を許可する（部分マッチ）", () => {
      expect(normalizePathForDenylist("foo/[..bar]/baz.ts")).toBe("foo/[..bar]/baz.ts");
    });

    it("三点 ... を許可する", () => {
      expect(normalizePathForDenylist("foo/.../bar.ts")).toBe("foo/.../bar.ts");
    });

    it("末尾三点のファイル名を許可する", () => {
      expect(normalizePathForDenylist("foo/bar.../baz.ts")).toBe("foo/bar.../baz.ts");
    });

    it("Next.js optional catch-all [[...slug]] を許可する", () => {
      expect(normalizePathForDenylist("[[...slug]]/page.ts")).toBe("[[...slug]]/page.ts");
    });
  });

  describe("エッジケース", () => {
    it("単一のドット . を許可する", () => {
      expect(normalizePathForDenylist(".")).toBe(".");
    });

    it("三点のみ ... を許可する", () => {
      expect(normalizePathForDenylist("...")).toBe("...");
    });

    it("空文字を許可する", () => {
      expect(normalizePathForDenylist("")).toBe("");
    });

    it("/ のみの場合は空文字を返す", () => {
      expect(normalizePathForDenylist("/")).toBe("");
    });

    it("./ のみの場合は空文字を返す", () => {
      expect(normalizePathForDenylist("./")).toBe("");
    });

    it("深いネストのパスを正規化する", () => {
      expect(normalizePathForDenylist("a/b/c/d/e/f/g.ts")).toBe("a/b/c/d/e/f/g.ts");
    });
  });
});
