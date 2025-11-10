import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main as cliMain } from "../../src/client/cli.js";
import { runIndexer } from "../../src/indexer/cli.js";
import { createServerRuntime } from "../../src/server/runtime.js";
import { loadSecurityConfig } from "../../src/shared/security/config.js";
import { createTempRepo } from "../helpers/test-repo.js";

describe("security lock integration", () => {
  const cleanupCallbacks: Array<() => Promise<void>> = [];
  const expectedHash = loadSecurityConfig().hash;

  afterEach(async () => {
    while (cleanupCallbacks.length > 0) {
      const cleanup = cleanupCallbacks.pop();
      if (cleanup) {
        await cleanup();
      }
    }
  });

  it("allows runtime startup with lock created alongside database", async () => {
    const repo = await createTempRepo({ "README.md": "# sample\n" });
    cleanupCallbacks.push(repo.cleanup);

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-integration-db-"));
    cleanupCallbacks.push(async () => {
      await rm(dbDir, { recursive: true, force: true });
    });

    const dbPath = join(dbDir, "index.duckdb");
    const lockPath = join(dbDir, "security.lock");

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const exitCode = cliMain(["security", "verify", "--db", dbPath, "--write-lock"]);
    expect(exitCode).toBe(0);

    await access(lockPath);

    const runtime = await createServerRuntime({ repoRoot: repo.path, databasePath: dbPath });
    cleanupCallbacks.push(async () => {
      await runtime.close();
    });

    const storedHash = (await readFile(lockPath, "utf-8")).trim();
    expect(storedHash).toBe(expectedHash);
  });

  it("creates missing lock when allowWriteLock is true", async () => {
    const repo = await createTempRepo({ "src/app.ts": "export const app = () => 1;\n" });
    cleanupCallbacks.push(repo.cleanup);

    const dbDir = await mkdtemp(join(tmpdir(), "kiri-integration-db-create-"));
    cleanupCallbacks.push(async () => {
      await rm(dbDir, { recursive: true, force: true });
    });

    const dbPath = join(dbDir, "index.duckdb");
    const lockPath = join(dbDir, "security.lock");

    await runIndexer({ repoRoot: repo.path, databasePath: dbPath, full: true });

    const runtime = await createServerRuntime({
      repoRoot: repo.path,
      databasePath: dbPath,
      allowWriteLock: true,
    });
    cleanupCallbacks.push(async () => {
      await runtime.close();
    });

    await access(lockPath);
    const storedHash = (await readFile(lockPath, "utf-8")).trim();
    expect(storedHash).toBe(expectedHash);
  });
});
