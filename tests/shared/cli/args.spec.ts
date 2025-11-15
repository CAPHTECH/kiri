/**
 * Tests for shared CLI argument parsing utilities
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MockInstance } from "vitest";

import {
  defineCli,
  renderHelp,
  renderVersion,
  type CliSpec,
} from "../../../src/shared/cli/args.js";

describe("CLI Utilities", () => {
  // スタブ用のCLI仕様
  const testSpec: CliSpec = {
    commandName: "test-command",
    description: "Test command description",
    version: "1.0.0",
    usage: "test-command [options]",
    sections: [
      {
        title: "Test Options",
        options: [
          {
            flag: "test-flag",
            type: "string",
            description: "A test flag",
            placeholder: "<value>",
            default: "default-value",
          },
          {
            flag: "bool-flag",
            type: "boolean",
            description: "A boolean flag",
            default: false,
          },
        ],
      },
    ],
    examples: ["test-command --test-flag value", "test-command --bool-flag"],
  };

  describe("renderHelp", () => {
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
    });

    it("should render help message with all sections", () => {
      renderHelp(testSpec);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("Test command description")
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("Usage: test-command [options]")
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Test Options:"));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("--test-flag <value>"));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("A test flag"));
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("(default: default-value)")
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("--bool-flag"));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("A boolean flag"));
    });

    it("should render common options (help and version)", () => {
      renderHelp(testSpec);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Common:"));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("-h, --help"));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("-v, --version"));
    });

    it("should render examples when provided", () => {
      renderHelp(testSpec);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Examples:"));
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("test-command --test-flag value")
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("test-command --bool-flag")
      );
    });
  });

  describe("renderVersion", () => {
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
    });

    it("should render version with command name", () => {
      renderVersion("test-command", "1.0.0");

      expect(consoleLogSpy).toHaveBeenCalledWith("test-command v1.0.0");
    });
  });

  describe("defineCli", () => {
    let processExitSpy: MockInstance<(code?: number | string | null | undefined) => never>;
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    let originalArgv: string[];

    beforeEach(() => {
      originalArgv = process.argv;
      processExitSpy = vi.spyOn(process, "exit").mockImplementation(((
        code?: number | string | null | undefined
      ) => {
        throw new Error(`process.exit called with code ${code ?? "unknown"}`);
      }) as (code?: number | string | null | undefined) => never);
      consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
      process.argv = originalArgv;
      processExitSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });

    it("should parse valid arguments", () => {
      process.argv = ["node", "script.js", "--test-flag", "custom-value"];

      const result = defineCli(testSpec);

      expect(result.values["test-flag"]).toBe("custom-value");
      expect(result.values["bool-flag"]).toBe(false);
    });

    it("should apply default values", () => {
      process.argv = ["node", "script.js"];

      const result = defineCli(testSpec);

      expect(result.values["test-flag"]).toBe("default-value");
      expect(result.values["bool-flag"]).toBe(false);
    });

    it("should handle --help flag and exit", () => {
      process.argv = ["node", "script.js", "--help"];

      defineCli(testSpec);

      expect(consoleLogSpy).toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it("should handle -h short flag and exit", () => {
      process.argv = ["node", "script.js", "-h"];

      defineCli(testSpec);

      expect(consoleLogSpy).toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it("should handle --version flag and exit", () => {
      process.argv = ["node", "script.js", "--version"];

      defineCli(testSpec);

      expect(consoleLogSpy).toHaveBeenCalledWith("test-command v1.0.0");
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it("should handle -v short flag and exit", () => {
      process.argv = ["node", "script.js", "-v"];

      defineCli(testSpec);

      expect(consoleLogSpy).toHaveBeenCalledWith("test-command v1.0.0");
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it("should parse boolean flags correctly", () => {
      process.argv = ["node", "script.js", "--bool-flag"];

      const result = defineCli(testSpec);

      expect(result.values["bool-flag"]).toBe(true);
    });
  });
});
