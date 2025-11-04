import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DegradeController } from "../../src/server/fallbacks/degradeController.js";

const tempDirs: string[] = [];

afterEach(async () => {
  const fs = await import("node:fs/promises");
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("DegradeController", () => {
  it("enters degrade mode on failure and provides fallback search", async () => {
    const dir = await mkdtemp("degrade-test-");
    tempDirs.push(dir);
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "file.ts"), "export const value = 42;\nconsole.log(value);\n");

    const controller = new DegradeController(dir);
    await expect(
      controller.withResource(async () => {
        throw new Error("duckdb down");
      }, "duckdb")
    ).rejects.toThrow();

    expect(controller.current.active).toBe(true);
    const results = controller.search("console value");
    expect(results[0]?.path).toContain("src/file.ts");
  });

  it("does not enter degrade mode for user-facing tool errors", async () => {
    const dir = await mkdtemp("degrade-test-");
    tempDirs.push(dir);
    const controller = new DegradeController(dir);

    await expect(
      controller.withResource(async () => {
        throw new Error(
          "Requested snippet file was not indexed. Re-run the indexer or choose another path."
        );
      }, "duckdb:snippets_get")
    ).rejects.toThrow();

    expect(controller.current.active).toBe(false);
  });

  it("skips binary files when performing fallback search", async () => {
    const dir = await mkdtemp("degrade-test-binary-");
    tempDirs.push(dir);
    await mkdir(join(dir, "bin"));
    await writeFile(join(dir, "bin", "binary.dat"), Buffer.from([0, 1, 2, 3]));

    const controller = new DegradeController(dir);
    const results = controller.search("0 1");
    expect(results).toHaveLength(0);
  });

  it("skips files larger than the preview threshold", async () => {
    const dir = await mkdtemp("degrade-test-large-");
    tempDirs.push(dir);
    await mkdir(join(dir, "large"));
    const largeContent = "x".repeat(512 * 1024);
    await writeFile(join(dir, "large", "huge.txt"), largeContent);

    const controller = new DegradeController(dir);
    const results = controller.search("x");
    expect(results).toHaveLength(0);
  });
});
