/**
 * Test helpers for CLI testing
 */

import { describe, it, expect } from "vitest";
import { execa } from "execa";

/**
 * Test suite configuration for CLI testing
 */
export interface CliTestConfig {
  /** Path to the compiled CLI entry point */
  cliPath: string;
  /** Command name (e.g., "kiri", "kiri-server") */
  commandName: string;
  /** Command description for help text */
  description: string;
  /** Expected sections in help output */
  expectedSections?: string[];
}

/**
 * Create standardized CLI test suite
 *
 * @param config - CLI test configuration
 * @returns Test suite functions
 */
export function createCliTests(config: CliTestConfig) {
  const { cliPath, commandName, description, expectedSections = [] } = config;

  return {
    /**
     * Test --help flag functionality
     */
    testHelp: () => {
      it("should display help message with --help flag", async () => {
        const { stdout, exitCode } = await execa("node", [cliPath, "--help"]);

        expect(exitCode).toBe(0);
        expect(stdout).toContain(description);
        expect(stdout).toContain(`Usage: ${commandName} [options]`);
        expect(stdout).toContain("Common:");
        expect(stdout).toContain("--help");
        expect(stdout).toContain("--version");
        expect(stdout).toContain("Examples:");

        // Check expected sections if provided
        for (const section of expectedSections) {
          expect(stdout).toContain(section);
        }
      });

      it("should display help message with -h short flag", async () => {
        const { stdout, exitCode } = await execa("node", [cliPath, "-h"]);

        expect(exitCode).toBe(0);
        expect(stdout).toContain(description);
        expect(stdout).toContain(`Usage: ${commandName} [options]`);
      });
    },

    /**
     * Test --version flag functionality
     */
    testVersion: () => {
      it("should display version with --version flag", async () => {
        const { stdout, exitCode } = await execa("node", [cliPath, "--version"]);

        expect(exitCode).toBe(0);
        expect(stdout).toMatch(new RegExp(`^${commandName} v\\d+\\.\\d+\\.\\d+$`));
      });

      it("should display version with -v short flag", async () => {
        const { stdout, exitCode } = await execa("node", [cliPath, "-v"]);

        expect(exitCode).toBe(0);
        expect(stdout).toMatch(new RegExp(`^${commandName} v\\d+\\.\\d+\\.\\d+$`));
      });
    },

    /**
     * Run all standard CLI tests
     */
    runAll: () => {
      describe(`${commandName} CLI`, () => {
        createCliTests(config).testHelp();
        createCliTests(config).testVersion();
      });
    },
  };
}
