import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createDenylistFilter } from "../../src/indexer/pipeline/filters/denylist.js";
import { createTempRepo } from "../helpers/test-repo.js";

describe("createDenylistFilter", () => {
  it("excludes configured and gitignore patterns", async () => {
    const repo = await createTempRepo({
      ".gitignore": "dist/\n.env.local\n",
      "src/index.ts": "console.log('ok');\n",
    });
    const configPath = join(repo.path, "deny.yml");
    await writeFile(
      configPath,
      ["patterns:", "  - secrets/**", "  - *.pem", "  - .env*"].join("\n"),
      "utf8"
    );

    const filter = createDenylistFilter(repo.path, configPath);
    expect(filter.isDenied("secrets/token.txt")).toBe(true);
    expect(filter.isDenied("dist/app.js")).toBe(true);
    expect(filter.isDenied("README.md")).toBe(false);

    const diff = filter.diff();
    expect(diff).toContain("dist/");
    await repo.cleanup();
  });

  it("works with missing denylist.yml by using gitignore only", async () => {
    // denylist.ymlは存在しないが、.gitignoreは存在するリポジトリ
    const repo = await createTempRepo({
      ".gitignore": "node_modules/\ndist/\n*.log\n",
      "src/index.ts": "console.log('ok');\n",
    });

    // 存在しないパスを指定（エラーにならないことを確認）
    const nonExistentConfig = join(repo.path, "nonexistent/denylist.yml");
    const filter = createDenylistFilter(repo.path, nonExistentConfig);

    // .gitignoreパターンのみが適用される
    expect(filter.isDenied("node_modules/package/index.js")).toBe(true);
    expect(filter.isDenied("dist/bundle.js")).toBe(true);
    expect(filter.isDenied("debug.log")).toBe(true);
    expect(filter.isDenied("src/index.ts")).toBe(false);

    // diffはすべて.gitignore由来
    const diff = filter.diff();
    expect(diff).toContain("node_modules/");
    expect(diff).toContain("dist/");

    await repo.cleanup();
  });

  it("works with missing both denylist.yml and gitignore", async () => {
    // 両方とも存在しないリポジトリ（最小構成）
    const repo = await createTempRepo({
      "src/index.ts": "console.log('ok');\n",
    });

    const nonExistentConfig = join(repo.path, "config/denylist.yml");
    const filter = createDenylistFilter(repo.path, nonExistentConfig);

    // フィルタは何もブロックしない
    expect(filter.isDenied("any/path/file.ts")).toBe(false);
    expect(filter.isDenied("secrets/token.txt")).toBe(false);
    expect(filter.isDenied(".env")).toBe(false);

    // diffは空
    expect(filter.diff()).toHaveLength(0);

    await repo.cleanup();
  });

  it("throws error when denylist.yml exists but has no valid patterns", async () => {
    // denylist.ymlが存在するが内容が無効な場合はエラーにする
    // （設定ミスを静かに無視しないため）
    const repo = await createTempRepo({
      "src/index.ts": "console.log('ok');\n",
    });

    // 空のpatternsを持つ設定ファイル
    const configPath = join(repo.path, "denylist.yml");
    await writeFile(configPath, "patterns: []\n", "utf8");

    expect(() => createDenylistFilter(repo.path, configPath)).toThrow(
      /exists but contains no valid patterns/
    );

    await repo.cleanup();
  });

  it("throws error when denylist.yml exists but patterns key is missing", async () => {
    // patternsキーが存在しない設定ファイル
    const repo = await createTempRepo({
      "src/index.ts": "console.log('ok');\n",
    });

    const configPath = join(repo.path, "denylist.yml");
    await writeFile(configPath, "other_key: value\n", "utf8");

    expect(() => createDenylistFilter(repo.path, configPath)).toThrow(
      /exists but contains no valid patterns/
    );

    await repo.cleanup();
  });
});

describe("gitignore仕様準拠: 任意の深さでマッチ", () => {
  it("node_modules/ matches at any depth (Issue #154)", async () => {
    // サブディレクトリ内のnode_modulesもマッチすることを確認
    const repo = await createTempRepo({
      ".gitignore": "node_modules/\n",
      "src/index.ts": "console.log('ok');\n",
    });

    const nonExistentConfig = join(repo.path, "nonexistent/denylist.yml");
    const filter = createDenylistFilter(repo.path, nonExistentConfig);

    // ルートレベル
    expect(filter.isDenied("node_modules/package.json")).toBe(true);
    expect(filter.isDenied("node_modules/lodash/index.js")).toBe(true);

    // サブディレクトリ内（Issue #154の主要なケース）
    expect(filter.isDenied("external/node_modules/package.json")).toBe(true);
    expect(filter.isDenied("external/assay-kit/node_modules/index.js")).toBe(true);

    // 深い階層
    expect(filter.isDenied("a/b/c/node_modules/foo/bar.js")).toBe(true);

    // node_modulesを含まないパスはマッチしない
    expect(filter.isDenied("src/index.ts")).toBe(false);

    await repo.cleanup();
  });

  it("*.log matches at any depth", async () => {
    const repo = await createTempRepo({
      ".gitignore": "*.log\n",
      "src/index.ts": "console.log('ok');\n",
    });

    const nonExistentConfig = join(repo.path, "nonexistent/denylist.yml");
    const filter = createDenylistFilter(repo.path, nonExistentConfig);

    // ルートレベル
    expect(filter.isDenied("app.log")).toBe(true);
    expect(filter.isDenied("error.log")).toBe(true);

    // サブディレクトリ
    expect(filter.isDenied("logs/debug.log")).toBe(true);
    expect(filter.isDenied("a/b/c/error.log")).toBe(true);

    // .logで終わらないファイルはマッチしない
    expect(filter.isDenied("app.log.bak")).toBe(false);
    expect(filter.isDenied("src/logger.ts")).toBe(false);

    await repo.cleanup();
  });

  it(".env* matches at any depth", async () => {
    const repo = await createTempRepo({
      ".gitignore": ".env*\n",
      "src/index.ts": "console.log('ok');\n",
    });

    const nonExistentConfig = join(repo.path, "nonexistent/denylist.yml");
    const filter = createDenylistFilter(repo.path, nonExistentConfig);

    // ルートレベル
    expect(filter.isDenied(".env")).toBe(true);
    expect(filter.isDenied(".env.local")).toBe(true);
    expect(filter.isDenied(".env.production")).toBe(true);

    // サブディレクトリ
    expect(filter.isDenied("config/.env")).toBe(true);
    expect(filter.isDenied("a/b/.env.development")).toBe(true);

    await repo.cleanup();
  });
});

describe("gitignore仕様準拠: ルート相対（先頭スラッシュ）", () => {
  it("/node_modules/ matches only at root", async () => {
    const repo = await createTempRepo({
      ".gitignore": "/node_modules/\n",
      "src/index.ts": "console.log('ok');\n",
    });

    const nonExistentConfig = join(repo.path, "nonexistent/denylist.yml");
    const filter = createDenylistFilter(repo.path, nonExistentConfig);

    // ルートのみマッチ
    expect(filter.isDenied("node_modules/package.json")).toBe(true);
    expect(filter.isDenied("node_modules/lodash/index.js")).toBe(true);

    // サブディレクトリ内はマッチしない
    expect(filter.isDenied("external/node_modules/package.json")).toBe(false);
    expect(filter.isDenied("a/b/node_modules/index.js")).toBe(false);

    await repo.cleanup();
  });

  it("/*.log matches only at root", async () => {
    const repo = await createTempRepo({
      ".gitignore": "/*.log\n",
      "src/index.ts": "console.log('ok');\n",
    });

    const nonExistentConfig = join(repo.path, "nonexistent/denylist.yml");
    const filter = createDenylistFilter(repo.path, nonExistentConfig);

    // ルートのみマッチ
    expect(filter.isDenied("app.log")).toBe(true);
    expect(filter.isDenied("error.log")).toBe(true);

    // サブディレクトリはマッチしない
    expect(filter.isDenied("logs/app.log")).toBe(false);
    expect(filter.isDenied("a/b/error.log")).toBe(false);

    await repo.cleanup();
  });
});

describe("gitignore仕様準拠: 相対パス（中間スラッシュ）", () => {
  it("src/generated/ matches only that relative path", async () => {
    const repo = await createTempRepo({
      ".gitignore": "src/generated/\n",
      "src/index.ts": "console.log('ok');\n",
    });

    const nonExistentConfig = join(repo.path, "nonexistent/denylist.yml");
    const filter = createDenylistFilter(repo.path, nonExistentConfig);

    // 相対パスにマッチ
    expect(filter.isDenied("src/generated/foo.ts")).toBe(true);
    expect(filter.isDenied("src/generated/types/index.ts")).toBe(true);

    // 別の場所のgenerated/にはマッチしない
    expect(filter.isDenied("lib/generated/foo.ts")).toBe(false);
    expect(filter.isDenied("a/src/generated/foo.ts")).toBe(false);
    expect(filter.isDenied("generated/foo.ts")).toBe(false);

    await repo.cleanup();
  });

  it("build/output/*.js matches relative path with wildcard", async () => {
    const repo = await createTempRepo({
      ".gitignore": "build/output/*.js\n",
      "src/index.ts": "console.log('ok');\n",
    });

    const nonExistentConfig = join(repo.path, "nonexistent/denylist.yml");
    const filter = createDenylistFilter(repo.path, nonExistentConfig);

    // 相対パスにマッチ
    expect(filter.isDenied("build/output/app.js")).toBe(true);
    expect(filter.isDenied("build/output/bundle.js")).toBe(true);

    // サブディレクトリや他の拡張子はマッチしない
    expect(filter.isDenied("build/output/nested/app.js")).toBe(false);
    expect(filter.isDenied("build/output/app.ts")).toBe(false);

    // 別の場所にはマッチしない
    expect(filter.isDenied("output/app.js")).toBe(false);
    expect(filter.isDenied("x/build/output/app.js")).toBe(false);

    await repo.cleanup();
  });
});

describe("gitignore仕様準拠: ダブルスターパターン", () => {
  it("**/temp matches temp at any depth", async () => {
    const repo = await createTempRepo({
      ".gitignore": "**/temp\n",
      "src/index.ts": "console.log('ok');\n",
    });

    const nonExistentConfig = join(repo.path, "nonexistent/denylist.yml");
    const filter = createDenylistFilter(repo.path, nonExistentConfig);

    expect(filter.isDenied("temp")).toBe(true);
    expect(filter.isDenied("a/temp")).toBe(true);
    expect(filter.isDenied("a/b/c/temp")).toBe(true);

    await repo.cleanup();
  });

  it("secrets/** matches everything under secrets at root", async () => {
    const repo = await createTempRepo({
      ".gitignore": "secrets/**\n",
      "src/index.ts": "console.log('ok');\n",
    });

    const nonExistentConfig = join(repo.path, "nonexistent/denylist.yml");
    const filter = createDenylistFilter(repo.path, nonExistentConfig);

    // secretsディレクトリ配下にマッチ
    expect(filter.isDenied("secrets/token.txt")).toBe(true);
    expect(filter.isDenied("secrets/a/b/c.json")).toBe(true);

    // サブディレクトリのsecretsにはマッチしない（中間スラッシュがあるため相対パス扱い）
    expect(filter.isDenied("a/secrets/token.txt")).toBe(false);

    await repo.cleanup();
  });
});

describe("エッジケース", () => {
  it("? matches single non-slash character", async () => {
    const repo = await createTempRepo({
      ".gitignore": "fo?.txt\n",
      "src/index.ts": "console.log('ok');\n",
    });

    const nonExistentConfig = join(repo.path, "nonexistent/denylist.yml");
    const filter = createDenylistFilter(repo.path, nonExistentConfig);

    // 単一文字にマッチ
    expect(filter.isDenied("foo.txt")).toBe(true);
    expect(filter.isDenied("fob.txt")).toBe(true);

    // スラッシュにはマッチしない（gitignore仕様）
    expect(filter.isDenied("fo/.txt")).toBe(false);

    // 複数文字にはマッチしない
    expect(filter.isDenied("fooo.txt")).toBe(false);

    await repo.cleanup();
  });

  it("throws for empty or overly broad patterns", async () => {
    const repo = await createTempRepo({
      "src/index.ts": "console.log('ok');\n",
    });

    // 空パターンを持つ設定ファイル
    const configPath = join(repo.path, "denylist.yml");

    // ** パターンはエラー
    await writeFile(configPath, "patterns:\n  - '**'\n", "utf8");
    expect(() => createDenylistFilter(repo.path, configPath)).toThrow(
      /Overly broad denylist pattern/
    );

    // **/ パターンはエラー
    await writeFile(configPath, "patterns:\n  - '**/'\n", "utf8");
    expect(() => createDenylistFilter(repo.path, configPath)).toThrow(
      /Overly broad denylist pattern/
    );

    // / のみはエラー
    await writeFile(configPath, "patterns:\n  - '/'\n", "utf8");
    expect(() => createDenylistFilter(repo.path, configPath)).toThrow(
      /Overly broad denylist pattern/
    );

    await repo.cleanup();
  });

  it("throws for negation patterns in denylist (security)", async () => {
    // 否定パターンはセキュリティ上の理由でdenylistでは禁止
    const repo = await createTempRepo({
      "src/index.ts": "console.log('ok');\n",
    });

    const configPath = join(repo.path, "denylist.yml");

    // !pattern 形式はエラー
    await writeFile(configPath, "patterns:\n  - '!important.txt'\n", "utf8");
    expect(() => createDenylistFilter(repo.path, configPath)).toThrow(
      /Negation pattern in denylist/
    );

    // !dir/ 形式もエラー
    await writeFile(configPath, "patterns:\n  - '!keep/'\n", "utf8");
    expect(() => createDenylistFilter(repo.path, configPath)).toThrow(
      /Negation pattern in denylist/
    );

    await repo.cleanup();
  });
});
