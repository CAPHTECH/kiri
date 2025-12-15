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
