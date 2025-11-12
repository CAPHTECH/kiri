/**
 * Integration tests for kiri-server CLI
 */

import { describe, it, expect } from "vitest";
import { execa } from "execa";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const serverPath = join(__dirname, "../../dist/src/server/main.js");

describe("kiri-server CLI", () => {
  it("should display help message with --help flag", async () => {
    const { stdout, exitCode } = await execa("node", [serverPath, "--help"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("KIRI MCP Server");
    expect(stdout).toContain("Usage: kiri-server [options]");
    expect(stdout).toContain("Repository / Database:");
    expect(stdout).toContain("--repo");
    expect(stdout).toContain("--db");
    expect(stdout).toContain("Server Mode:");
    expect(stdout).toContain("--port");
    expect(stdout).toContain("Indexing:");
    expect(stdout).toContain("--reindex");
    expect(stdout).toContain("--allow-degrade");
    expect(stdout).toContain("Watch Mode:");
    expect(stdout).toContain("--watch");
    expect(stdout).toContain("--debounce");
    expect(stdout).toContain("Security:");
    expect(stdout).toContain("--security-config");
    expect(stdout).toContain("Common:");
    expect(stdout).toContain("--help");
    expect(stdout).toContain("--version");
    expect(stdout).toContain("Examples:");
  });

  it("should display help message with -h short flag", async () => {
    const { stdout, exitCode } = await execa("node", [serverPath, "-h"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("KIRI MCP Server");
    expect(stdout).toContain("Usage: kiri-server [options]");
  });

  it("should display version with --version flag", async () => {
    const { stdout, exitCode } = await execa("node", [serverPath, "--version"]);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^kiri-server v\d+\.\d+\.\d+$/);
  });

  it("should display version with -v short flag", async () => {
    const { stdout, exitCode } = await execa("node", [serverPath, "-v"]);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^kiri-server v\d+\.\d+\.\d+$/);
  });
});
