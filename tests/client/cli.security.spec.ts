import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/client/cli.js";
import { loadSecurityConfig } from "../../src/shared/security/config.js";

describe("CLI security verify", () => {
  let tempDir: string;
  const defaultDbName = "index.duckdb";
  const expectedHash = loadSecurityConfig().hash;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kiri-cli-test-"));
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    infoSpy.mockRestore();
    errorSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates security.lock next to the database when --db is provided", async () => {
    const dbPath = join(tempDir, defaultDbName);
    const exitCode = main(["security", "verify", "--db", dbPath, "--write-lock"]);

    expect(exitCode).toBe(0);

    const lockPath = join(tempDir, "security.lock");
    const lockContent = await readFile(lockPath, "utf-8");
    expect(lockContent.trim()).toBe(expectedHash);
  });

  it("honors --security-lock override", async () => {
    const dbPath = join(tempDir, defaultDbName);
    const customLock = join(tempDir, "locks", "custom.lock");
    const exitCode = main([
      "security",
      "verify",
      "--db",
      dbPath,
      "--security-lock",
      customLock,
      "--write-lock",
    ]);

    expect(exitCode).toBe(0);

    const lockContent = await readFile(customLock, "utf-8");
    expect(lockContent.trim()).toBe(expectedHash);
  });
});
