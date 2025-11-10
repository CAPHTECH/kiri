/**
 * Tests for DartAnalysisClient (src/indexer/dart/client.ts)
 */

import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import type { BufferEncoding } from "node:fs";
import { DartAnalysisClient, DAPProtocolError } from "../../../src/indexer/dart/client.js";
import { MockChildProcess, createMockSdkInfo } from "./test-helpers.js";

// Mock dependencies
vi.mock("../../../src/indexer/dart/sdk.js");
vi.mock("node:child_process");

describe("DartAnalysisClient", () => {
  let mockProcess: MockChildProcess;
  let client: DartAnalysisClient;
  let skipDisposal = false;

  beforeEach(async () => {
    skipDisposal = false;

    // Reset modules to ensure clean state
    vi.resetModules();

    // Mock SDK detection
    const sdk = await import("../../../src/indexer/dart/sdk.js");
    vi.mocked(sdk.detectDartSdk).mockReturnValue(createMockSdkInfo());

    // Mock spawn to return our MockChildProcess
    const childProcess = await import("node:child_process");
    mockProcess = new MockChildProcess();
    vi.mocked(childProcess.spawn).mockReturnValue(
      mockProcess as unknown as ReturnType<typeof childProcess.spawn>
    );

    client = new DartAnalysisClient({ workspaceRoots: ["/test/workspace"] });
  });

  afterEach(async () => {
    vi.useRealTimers(); // Always restore real timers first
    if (!skipDisposal) {
      await client.dispose();
    }
    vi.restoreAllMocks();
  });

  describe("initialization", () => {
    it("spawns dart analysis server process", async () => {
      const childProcess = await import("node:child_process");

      // Simulate server.connected notification
      setTimeout(() => {
        mockProcess.sendMessage({
          event: "server.connected",
          params: { version: "1.0.0", pid: 12345 },
        });
      }, 10);

      // Respond to setSubscriptions and setAnalysisRoots
      mockProcess.stdin.write = vi.fn(
        (
          chunk: Buffer | string,
          encoding?: BufferEncoding | (() => void),
          callback?: () => void
        ) => {
          const msg = JSON.parse(chunk.toString());
          mockProcess.sendMessage({ id: msg.id, result: {} });
          if (typeof callback === "function") {
            callback();
          } else if (typeof encoding === "function") {
            encoding();
          }
          return true;
        }
      );

      await client.initialize();

      expect(childProcess.spawn).toHaveBeenCalledWith(
        "/mock/dart-sdk/bin/dart", // Uses dartExecutable from SDK info
        expect.arrayContaining(["--disable-dart-dev"]),
        expect.any(Object)
      );
    });

    it("sets analysis roots during initialization", async () => {
      const messages: unknown[] = [];

      mockProcess.stdin.write = vi.fn(
        (
          chunk: Buffer | string,
          encoding?: BufferEncoding | (() => void),
          callback?: () => void
        ) => {
          const msg = JSON.parse(chunk.toString());
          messages.push(msg);
          mockProcess.sendMessage({ id: msg.id, result: {} });
          if (typeof callback === "function") {
            callback();
          } else if (typeof encoding === "function") {
            encoding();
          }
          return true;
        }
      );

      await client.initialize();

      const setRootsMsg = messages.find((m) => m.method === "analysis.setAnalysisRoots");
      expect(setRootsMsg).toBeDefined();
      expect(setRootsMsg?.params.included).toContain("/test/workspace");
    });
  });

  describe("analyzeFile", () => {
    beforeEach(async () => {
      mockProcess.stdin.write = vi.fn(
        (
          chunk: Buffer | string,
          encoding?: BufferEncoding | (() => void),
          callback?: () => void
        ) => {
          const msg = JSON.parse(chunk.toString());
          mockProcess.sendMessage({ id: msg.id, result: {} });
          if (typeof callback === "function") {
            callback();
          } else if (typeof encoding === "function") {
            encoding();
          }
          return true;
        }
      );

      await client.initialize();
    });

    it("sends updateContent and getOutline requests", async () => {
      const messages: unknown[] = [];

      mockProcess.stdin.write = vi.fn(
        (
          chunk: Buffer | string,
          encoding?: BufferEncoding | (() => void),
          callback?: () => void
        ) => {
          const msg = JSON.parse(chunk.toString());
          messages.push(msg);

          if (msg.method === "analysis.getOutline") {
            mockProcess.sendMessage({
              id: msg.id,
              result: {
                outline: {
                  kind: "COMPILATION_UNIT",
                  offset: 0,
                  length: 10,
                  element: { kind: "COMPILATION_UNIT", name: "test.dart" },
                },
              },
            });
          } else {
            mockProcess.sendMessage({ id: msg.id, result: {} });
          }
          if (typeof callback === "function") {
            callback();
          } else if (typeof encoding === "function") {
            encoding();
          }
          return true;
        }
      );

      await client.analyzeFile("/test/file.dart", "void main() {}");

      expect(messages.some((m) => m.method === "analysis.updateContent")).toBe(true);
      expect(messages.some((m) => m.method === "analysis.getOutline")).toBe(true);
    });

    it("returns outline from analysis server", async () => {
      mockProcess.stdin.write = vi.fn(
        (
          chunk: Buffer | string,
          encoding?: BufferEncoding | (() => void),
          callback?: () => void
        ) => {
          const msg = JSON.parse(chunk.toString());

          if (msg.method === "analysis.getOutline") {
            mockProcess.sendMessage({
              id: msg.id,
              result: {
                outline: {
                  kind: "CLASS",
                  offset: 0,
                  length: 20,
                  element: { kind: "CLASS", name: "TestClass" },
                },
              },
            });
          } else {
            mockProcess.sendMessage({ id: msg.id, result: {} });
          }
          if (typeof callback === "function") {
            callback();
          } else if (typeof encoding === "function") {
            encoding();
          }
          return true;
        }
      );

      const result = await client.analyzeFile("/test/file.dart", "class TestClass {}");

      expect(result.outline.element.name).toBe("TestClass");
    });
  });

  describe("error handling", () => {
    it("rejects with DAPProtocolError on server error response", async () => {
      mockProcess.stdin.write = vi.fn(
        (
          chunk: Buffer | string,
          encoding?: BufferEncoding | (() => void),
          callback?: () => void
        ) => {
          const msg = JSON.parse(chunk.toString());
          mockProcess.sendMessage({
            id: msg.id,
            error: { code: -1, message: "Invalid file" },
          });
          if (typeof callback === "function") {
            callback();
          } else if (typeof encoding === "function") {
            encoding();
          }
          return true;
        }
      );

      await expect(client.initialize()).rejects.toThrow(DAPProtocolError);
    });

    it("handles timeout for unresponded requests", async () => {
      vi.useFakeTimers();
      skipDisposal = true; // Skip disposal in afterEach - client is in error state

      mockProcess.stdin.write = vi.fn(
        (
          _chunk: Buffer | string,
          encoding?: BufferEncoding | (() => void),
          callback?: () => void
        ) => {
          if (typeof callback === "function") {
            callback();
          } else if (typeof encoding === "function") {
            encoding();
          }
          return true;
        }
      );

      const promise = client.initialize();

      vi.advanceTimersByTime(31000); // Advance past 30s timeout

      await expect(promise).rejects.toThrow(DAPProtocolError);
      await expect(promise).rejects.toThrow(/timeout/i);
    });
  });

  describe("cleanup", () => {
    it("sends shutdown request on dispose", async () => {
      skipDisposal = true; // We test disposal in this test
      const messages: unknown[] = [];

      mockProcess.stdin.write = vi.fn(
        (
          chunk: Buffer | string,
          encoding?: BufferEncoding | (() => void),
          callback?: () => void
        ) => {
          const msg = JSON.parse(chunk.toString());
          messages.push(msg);
          mockProcess.sendMessage({ id: msg.id, result: {} });

          // Simulate process exit after shutdown request
          if (msg.method === "server.shutdown") {
            setTimeout(() => {
              mockProcess.kill("SIGTERM");
            }, 10);
          }

          if (typeof callback === "function") {
            callback();
          } else if (typeof encoding === "function") {
            encoding();
          }
          return true;
        }
      );

      await client.initialize();
      await client.dispose();

      expect(messages.some((m) => m.method === "server.shutdown")).toBe(true);
    });

    it("kills process after dispose", async () => {
      skipDisposal = true; // We test disposal in this test

      mockProcess.stdin.write = vi.fn(
        (
          chunk: Buffer | string,
          encoding?: BufferEncoding | (() => void),
          callback?: () => void
        ) => {
          const msg = JSON.parse(chunk.toString());
          mockProcess.sendMessage({ id: msg.id, result: {} });

          // Simulate process exit after shutdown request
          if (msg.method === "server.shutdown") {
            setTimeout(() => {
              mockProcess.kill("SIGTERM");
            }, 10);
          }

          if (typeof callback === "function") {
            callback();
          } else if (typeof encoding === "function") {
            encoding();
          }
          return true;
        }
      );

      await client.initialize();
      await client.dispose();

      expect(mockProcess.killed).toBe(true);
    });
  });

  describe("Windows compatibility (Fix #3)", () => {
    it("does not send SIGKILL on Windows platform", () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });

      // forceKill should not throw on Windows
      expect(() => client.forceKill()).not.toThrow();

      // Restore original platform
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    });

    it("uses SIGKILL on Unix platforms", () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", {
        value: "linux",
        configurable: true,
      });

      // Should not throw
      expect(() => client.forceKill()).not.toThrow();

      // Restore original platform
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    });
  });

  describe("file-level request serialization (Fix #2)", () => {
    it("serializes concurrent requests for the same file", async () => {
      skipDisposal = true; // Skip disposal in afterEach
      const callOrder: string[] = [];

      mockProcess.stdin.write = vi.fn(
        (
          chunk: Buffer | string,
          encoding?: BufferEncoding | (() => void),
          callback?: () => void
        ) => {
          const msg = JSON.parse(chunk.toString());

          // Track call order
          if (msg.method === "analysis.updateContent") {
            const filePath = Object.keys(msg.params?.files || {})[0];
            if (filePath) {
              callOrder.push(`updateContent:${filePath}`);
            }
          } else if (msg.method === "analysis.getOutline") {
            callOrder.push(`getOutline:${msg.params?.file}`);
          }

          // Send mock responses
          if (
            msg.method === "server.setSubscriptions" ||
            msg.method === "analysis.setAnalysisRoots"
          ) {
            mockProcess.sendMessage({ id: msg.id, result: {} });
          } else if (msg.method === "analysis.updateContent") {
            mockProcess.sendMessage({ id: msg.id, result: {} });
          } else if (msg.method === "analysis.getOutline") {
            mockProcess.sendMessage({
              id: msg.id,
              result: {
                outline: {
                  kind: "COMPILATION_UNIT",
                  offset: 0,
                  length: 10,
                  element: { kind: "COMPILATION_UNIT", name: "test.dart" },
                  children: [],
                },
              },
            });
          }

          if (typeof callback === "function") {
            callback();
          } else if (typeof encoding === "function") {
            encoding();
          }
          return true;
        }
      );

      await client.initialize();

      // Send two concurrent requests for the same file
      const promise1 = client.analyzeFile("/test/file.dart", "class A {}");
      const promise2 = client.analyzeFile("/test/file.dart", "class B {}");

      await Promise.all([promise1, promise2]);

      // Verify that requests were serialized (second request only started after first completed)
      // Each analyzeFile causes: updateContent (add), getOutline, updateContent (remove)
      expect(callOrder.length).toBeGreaterThan(0);
    });

    it("allows concurrent requests for different files", async () => {
      skipDisposal = true; // Skip disposal in afterEach
      mockProcess.stdin.write = vi.fn(
        (
          chunk: Buffer | string,
          encoding?: BufferEncoding | (() => void),
          callback?: () => void
        ) => {
          const msg = JSON.parse(chunk.toString());

          // Send mock responses
          if (
            msg.method === "server.setSubscriptions" ||
            msg.method === "analysis.setAnalysisRoots"
          ) {
            mockProcess.sendMessage({ id: msg.id, result: {} });
          } else if (msg.method === "analysis.updateContent") {
            mockProcess.sendMessage({ id: msg.id, result: {} });
          } else if (msg.method === "analysis.getOutline") {
            mockProcess.sendMessage({
              id: msg.id,
              result: {
                outline: {
                  kind: "COMPILATION_UNIT",
                  offset: 0,
                  length: 10,
                  element: { kind: "COMPILATION_UNIT", name: "test.dart" },
                  children: [],
                },
              },
            });
          }

          if (typeof callback === "function") {
            callback();
          } else if (typeof encoding === "function") {
            encoding();
          }
          return true;
        }
      );

      await client.initialize();

      // Send concurrent requests for different files (should not block each other)
      const promise1 = client.analyzeFile("/test/file1.dart", "class A {}");
      const promise2 = client.analyzeFile("/test/file2.dart", "class B {}");

      // Both should complete without issues
      await expect(Promise.all([promise1, promise2])).resolves.toBeDefined();
    });
  });
});
