import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { gitLsFiles, gitLsFilesUntracked } from "../../src/indexer/git.js";
import { createTempRepo } from "../helpers/test-repo.js";

interface CleanupTarget {
  dispose: () => Promise<void>;
}

describe("gitLsFilesUntracked", () => {
  const cleanupTargets: CleanupTarget[] = [];

  afterEach(async () => {
    for (const target of cleanupTargets.splice(0, cleanupTargets.length)) {
      await target.dispose();
    }
  });

  it("returns untracked files", async () => {
    // tracked ファイルでリポジトリを作成
    const repo = await createTempRepo({
      "tracked.ts": "export const tracked = true;",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    // untracked ファイルを追加（git add しない）
    const untrackedPath = join(repo.path, "untracked.ts");
    await writeFile(untrackedPath, "export const untracked = true;");

    // gitLsFilesUntracked でuntracked ファイルが取得できることを確認
    const untrackedFiles = await gitLsFilesUntracked(repo.path);

    expect(untrackedFiles).toContain("untracked.ts");
    expect(untrackedFiles).not.toContain("tracked.ts");
  });

  it("excludes gitignored files", async () => {
    // .gitignore と tracked ファイルでリポジトリを作成
    const repo = await createTempRepo({
      "tracked.ts": "export const tracked = true;",
      ".gitignore": "ignored.ts\n",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    // untracked ファイルを追加
    await writeFile(join(repo.path, "untracked.ts"), "export const untracked = true;");
    // gitignored ファイルを追加
    await writeFile(join(repo.path, "ignored.ts"), "export const ignored = true;");

    const untrackedFiles = await gitLsFilesUntracked(repo.path);

    // untracked.ts は含まれるが、ignored.ts は含まれない
    expect(untrackedFiles).toContain("untracked.ts");
    expect(untrackedFiles).not.toContain("ignored.ts");
    expect(untrackedFiles).not.toContain("tracked.ts");
    expect(untrackedFiles).not.toContain(".gitignore");
  });

  it("returns empty array when no untracked files exist", async () => {
    const repo = await createTempRepo({
      "tracked.ts": "export const tracked = true;",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    const untrackedFiles = await gitLsFilesUntracked(repo.path);

    expect(untrackedFiles).toEqual([]);
  });

  it("handles untracked files in subdirectories", async () => {
    const repo = await createTempRepo({
      "src/tracked.ts": "export const tracked = true;",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    // サブディレクトリに untracked ファイルを追加
    await mkdir(join(repo.path, "lib"), { recursive: true });
    await writeFile(join(repo.path, "lib/untracked.ts"), "export const untracked = true;");

    const untrackedFiles = await gitLsFilesUntracked(repo.path);

    expect(untrackedFiles).toContain("lib/untracked.ts");
    expect(untrackedFiles).not.toContain("src/tracked.ts");
  });
});

describe("gitLsFiles", () => {
  const cleanupTargets: CleanupTarget[] = [];

  afterEach(async () => {
    for (const target of cleanupTargets.splice(0, cleanupTargets.length)) {
      await target.dispose();
    }
  });

  it("returns tracked files only", async () => {
    const repo = await createTempRepo({
      "tracked.ts": "export const tracked = true;",
    });
    cleanupTargets.push({ dispose: repo.cleanup });

    // untracked ファイルを追加
    await writeFile(join(repo.path, "untracked.ts"), "export const untracked = true;");

    const trackedFiles = await gitLsFiles(repo.path);

    expect(trackedFiles).toContain("tracked.ts");
    expect(trackedFiles).not.toContain("untracked.ts");
  });
});
