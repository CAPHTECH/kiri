/**
 * Tests for Dart SDK detection (src/indexer/dart/sdk.ts)
 */

import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";

// Mock modules
vi.mock("node:child_process");
vi.mock("node:fs");

describe("Dart SDK detection", () => {
  let spawnSyncMock: ReturnType<typeof vi.fn>;
  let existsSyncMock: ReturnType<typeof vi.fn>;
  let originalEnv: NodeJS.ProcessEnv;
  let originalPlatform: NodeJS.Platform;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    originalPlatform = process.platform;

    const childProcess = await import("node:child_process");
    const fs = await import("node:fs");

    spawnSyncMock = vi.fn();
    existsSyncMock = vi.fn();

    // Fix #6: spawnSync is now used for both "which/where dart" and "dart --version"
    vi.mocked(childProcess.spawnSync).mockImplementation(spawnSyncMock);
    vi.mocked(fs.existsSync).mockImplementation(existsSyncMock);

    // Fix #5: Clear SDK cache before each test
    const sdk = await import("../../../src/indexer/dart/sdk.js");
    sdk.invalidateSdkCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      writable: true,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  describe("detectDartSdk", () => {
    it("detects SDK from DART_SDK environment variable", async () => {
      process.env.DART_SDK = "/custom/dart-sdk";
      existsSyncMock.mockReturnValue(true);
      // Mock dart --version with spawnSync
      spawnSyncMock.mockReturnValue({
        status: 0,
        stdout: "Dart SDK version: 3.2.0 (stable)\n",
        stderr: "",
        error: undefined,
        signal: null,
      });

      const { detectDartSdk } = await import("../../../src/indexer/dart/sdk.js");
      const result = detectDartSdk();

      expect(result.sdkPath).toBe("/custom/dart-sdk");
      expect(result.version).toBe("3.2.0");
      expect(result.analysisServerPath).toContain("analysis_server.dart.snapshot");
      expect(result.dartExecutable).toContain("/custom/dart-sdk/bin/dart");
    });

    it("detects SDK from PATH when DART_SDK not set", async () => {
      delete process.env.DART_SDK;
      // Mock which/where dart command
      spawnSyncMock.mockReturnValueOnce({
        status: 0,
        stdout: "/usr/local/bin/dart\n",
        stderr: "",
        error: undefined,
        signal: null,
      });
      // Mock dart --version command
      spawnSyncMock.mockReturnValueOnce({
        status: 0,
        stdout: "Dart SDK version: 3.1.5 (stable)\n",
        stderr: "",
        error: undefined,
        signal: null,
      });
      existsSyncMock.mockReturnValue(true);

      const { detectDartSdk } = await import("../../../src/indexer/dart/sdk.js");
      const result = detectDartSdk();

      expect(result.sdkPath).toBe("/usr/local");
      expect(result.version).toBe("3.1.5");
      expect(result.dartExecutable).toBe("/usr/local/bin/dart");
    });

    it("throws MissingToolError when SDK not found", async () => {
      delete process.env.DART_SDK;
      // Mock which/where dart command failure
      spawnSyncMock.mockReturnValue({
        status: 1,
        stdout: "",
        stderr: "command not found",
        error: undefined,
        signal: null,
      });

      const { detectDartSdk, MissingToolError } = await import("../../../src/indexer/dart/sdk.js");
      expect(() => detectDartSdk()).toThrow(MissingToolError);
      expect(() => detectDartSdk()).toThrow(/Dart SDK not found/);
    });

    it("extracts version from stderr when dart --version outputs to stderr", async () => {
      delete process.env.DART_SDK;
      // Mock which/where dart command
      spawnSyncMock.mockReturnValueOnce({
        status: 0,
        stdout: "/opt/dart/bin/dart\n",
        stderr: "",
        error: undefined,
        signal: null,
      });
      // Mock dart --version outputting to stderr (dart's typical behavior)
      spawnSyncMock.mockReturnValueOnce({
        status: 0,
        stdout: "",
        stderr: "Dart SDK version: 3.3.0 (stable)\n",
        error: undefined,
        signal: null,
      });
      existsSyncMock.mockReturnValue(true);

      const { detectDartSdk } = await import("../../../src/indexer/dart/sdk.js");
      const result = detectDartSdk();

      expect(result.version).toBe("3.3.0");
    });

    it("returns 'unknown' version when version extraction fails", async () => {
      process.env.DART_SDK = "/custom/dart-sdk";
      existsSyncMock.mockReturnValue(true);
      // Mock dart --version with invalid output
      spawnSyncMock.mockReturnValue({
        status: 0,
        stdout: "Invalid output\n",
        stderr: "",
        error: undefined,
        signal: null,
      });

      const { detectDartSdk } = await import("../../../src/indexer/dart/sdk.js");
      const result = detectDartSdk();

      expect(result.version).toBe("unknown");
    });
  });

  describe("isDartSdkAvailable", () => {
    it("returns true when SDK is available", async () => {
      process.env.DART_SDK = "/custom/dart-sdk";
      existsSyncMock.mockReturnValue(true);
      // Mock dart --version
      spawnSyncMock.mockReturnValue({
        status: 0,
        stdout: "Dart SDK version: 3.2.0\n",
        stderr: "",
        error: undefined,
        signal: null,
      });

      const { isDartSdkAvailable } = await import("../../../src/indexer/dart/sdk.js");
      expect(isDartSdkAvailable()).toBe(true);
    });

    it("returns false when SDK is not available", async () => {
      delete process.env.DART_SDK;
      // Mock which/where dart command failure
      spawnSyncMock.mockReturnValue({
        status: 1,
        stdout: "",
        stderr: "not found",
        error: undefined,
        signal: null,
      });

      const { isDartSdkAvailable } = await import("../../../src/indexer/dart/sdk.js");
      expect(isDartSdkAvailable()).toBe(false);
    });
  });
});
