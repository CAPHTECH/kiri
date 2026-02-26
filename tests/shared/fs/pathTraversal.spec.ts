import { describe, expect, it } from "vitest";

import { isPathTraversal } from "../../../src/shared/fs/pathTraversal.js";

describe("isPathTraversal", () => {
  describe("パストラバーサル検出", () => {
    it("先頭の .. を検出する", () => {
      expect(isPathTraversal("../etc/passwd")).toBe(true);
    });

    it("中間の .. を検出する", () => {
      expect(isPathTraversal("foo/../bar.ts")).toBe(true);
    });

    it("末尾の .. を検出する", () => {
      expect(isPathTraversal("foo/bar/..")).toBe(true);
    });

    it("複数の .. を検出する", () => {
      expect(isPathTraversal("../../secret")).toBe(true);
    });

    it("Windows形式の .. を検出する", () => {
      expect(isPathTraversal("foo\\..\\bar")).toBe(true);
    });

    it("単独の .. を検出する", () => {
      expect(isPathTraversal("..")).toBe(true);
    });
  });

  describe("誤検知回避（PR #214 修正対象）", () => {
    it("Next.js catch-all ルート [...all] を許可する", () => {
      expect(isPathTraversal("api/auth/[...all]/route.ts")).toBe(false);
    });

    it("ファイル名内の .. を許可する", () => {
      expect(isPathTraversal("foo/bar..baz.ts")).toBe(false);
    });

    it("ディレクトリ名内の .. を許可する（部分マッチ）", () => {
      expect(isPathTraversal("foo/[..bar]/baz.ts")).toBe(false);
    });

    it("三点 ... を許可する", () => {
      expect(isPathTraversal("foo/.../bar.ts")).toBe(false);
    });

    it("末尾三点のファイル名を許可する", () => {
      expect(isPathTraversal("foo/bar.../baz.ts")).toBe(false);
    });

    it("Next.js optional catch-all [[...slug]] を許可する", () => {
      expect(isPathTraversal("[[...slug]]/page.ts")).toBe(false);
    });
  });

  describe("正常パス", () => {
    it("通常のパスは false を返す", () => {
      expect(isPathTraversal("foo/bar.ts")).toBe(false);
    });

    it("単一のドット . を許可する", () => {
      expect(isPathTraversal(".")).toBe(false);
    });

    it("三点のみ ... を許可する", () => {
      expect(isPathTraversal("...")).toBe(false);
    });

    it("空文字を許可する", () => {
      expect(isPathTraversal("")).toBe(false);
    });

    it("深いネストのパスを許可する", () => {
      expect(isPathTraversal("a/b/c/d/e/f/g.ts")).toBe(false);
    });
  });
});
