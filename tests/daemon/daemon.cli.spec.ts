/**
 * Integration tests for kiri-daemon CLI
 */

import { describe, it, expect } from "vitest";
import { execa } from "execa";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const daemonPath = join(__dirname, "../../dist/src/daemon/daemon.js");

describe("kiri-daemon CLI", () => {
  it("should display help message with --help flag", async () => {
    const { stdout, exitCode } = await execa("node", [daemonPath, "--help"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("KIRI Daemon Process");
    expect(stdout).toContain("Usage: kiri-daemon [options]");
    expect(stdout).toContain("Repository / Database:");
    expect(stdout).toContain("--repo");
    expect(stdout).toContain("--db");
    expect(stdout).toContain("Daemon Lifecycle:");
    expect(stdout).toContain("--socket-path");
    expect(stdout).toContain("--daemon-timeout");
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
    const { stdout, exitCode } = await execa("node", [daemonPath, "-h"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("KIRI Daemon Process");
    expect(stdout).toContain("Usage: kiri-daemon [options]");
  });

  it("should display version with --version flag", async () => {
    const { stdout, exitCode } = await execa("node", [daemonPath, "--version"]);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^kiri-daemon v\d+\.\d+\.\d+$/);
  });

  it("should display version with -v short flag", async () => {
    const { stdout, exitCode } = await execa("node", [daemonPath, "-v"]);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^kiri-daemon v\d+\.\d+\.\d+$/);
  });
});
