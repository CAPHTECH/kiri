/**
 * Integration tests for kiri proxy CLI
 */

import { describe, it, expect } from "vitest";
import { execa } from "execa";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const proxyPath = join(__dirname, "../../dist/src/client/proxy.js");

describe("kiri proxy CLI", () => {
  it("should display help message with --help flag", async () => {
    const { stdout, exitCode } = await execa("node", [proxyPath, "--help"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("KIRI MCP Client Proxy");
    expect(stdout).toContain("Usage: kiri [options]");
    expect(stdout).toContain("Repository / Database:");
    expect(stdout).toContain("--repo");
    expect(stdout).toContain("--db");
    expect(stdout).toContain("Daemon Connection:");
    expect(stdout).toContain("--socket-path");
    expect(stdout).toContain("Watch Mode:");
    expect(stdout).toContain("--watch");
    expect(stdout).toContain("Security:");
    expect(stdout).toContain("--allow-degrade");
    expect(stdout).toContain("--security-config");
    expect(stdout).toContain("Common:");
    expect(stdout).toContain("--help");
    expect(stdout).toContain("--version");
    expect(stdout).toContain("Examples:");
  });

  it("should display help message with -h short flag", async () => {
    const { stdout, exitCode } = await execa("node", [proxyPath, "-h"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("KIRI MCP Client Proxy");
    expect(stdout).toContain("Usage: kiri [options]");
  });

  it("should display version with --version flag", async () => {
    const { stdout, exitCode } = await execa("node", [proxyPath, "--version"]);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^kiri v\d+\.\d+\.\d+$/);
  });

  it("should display version with -v short flag", async () => {
    const { stdout, exitCode } = await execa("node", [proxyPath, "-v"]);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^kiri v\d+\.\d+\.\d+$/);
  });
});
