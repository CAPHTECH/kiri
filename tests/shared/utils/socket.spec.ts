import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getDatabasePathFromSocket,
  getSocketPath,
  getSocketPathDebugInfo,
} from "../../../src/shared/utils/socket.js";

describe("Socket Path Utility", () => {
  let originalPlatform: NodeJS.Platform;
  let originalPipePrefix: string | undefined;
  let originalSocketDir: string | undefined;

  beforeEach(() => {
    // プラットフォームと環境変数をバックアップ
    originalPlatform = process.platform;
    originalPipePrefix = process.env.KIRI_PIPE_PREFIX;
    originalSocketDir = process.env.KIRI_SOCKET_DIR;
  });

  afterEach(() => {
    // プラットフォームと環境変数を復元
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    if (originalPipePrefix === undefined) {
      delete process.env.KIRI_PIPE_PREFIX;
    } else {
      process.env.KIRI_PIPE_PREFIX = originalPipePrefix;
    }

    if (originalSocketDir === undefined) {
      delete process.env.KIRI_SOCKET_DIR;
    } else {
      process.env.KIRI_SOCKET_DIR = originalSocketDir;
    }
  });

  describe("getSocketPath", () => {
    describe("Unix/Linux/macOS platforms", () => {
      it("should generate Unix socket path on darwin", () => {
        Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

        const result = getSocketPath("/path/to/database.duckdb");
        expect(result).toBe("/path/to/database.duckdb.sock");
      });

      it("should generate Unix socket path on linux", () => {
        Object.defineProperty(process, "platform", { value: "linux", configurable: true });

        const result = getSocketPath("/var/lib/kiri/index.duckdb");
        expect(result).toBe("/var/lib/kiri/index.duckdb.sock");
      });

      it("should handle paths with spaces", () => {
        Object.defineProperty(process, "platform", { value: "linux", configurable: true });

        const result = getSocketPath("/path with spaces/database.duckdb");
        expect(result).toBe("/path with spaces/database.duckdb.sock");
      });

      it("should fall back to tmp directory when path exceeds limit", () => {
        Object.defineProperty(process, "platform", { value: "linux", configurable: true });
        process.env.KIRI_SOCKET_DIR = "/tmp";

        const longSegment = "nested".repeat(20);
        const longPath = `/very/long/${longSegment}/path/to/database.duckdb`;
        const result = getSocketPath(longPath);

        expect(result.startsWith("/tmp/kiri-")).toBe(true);
        expect(result.endsWith(".sock")).toBe(true);
        expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(96);
      });

      it("should fall back for multibyte paths", () => {
        Object.defineProperty(process, "platform", { value: "linux", configurable: true });
        process.env.KIRI_SOCKET_DIR = "/tmp";

        const multibyte = `/${"深".repeat(40)}/index.duckdb`;
        const result = getSocketPath(multibyte);

        expect(result.startsWith("/tmp/kiri-")).toBe(true);
      });

      it("should allow overriding fallback directory via KIRI_SOCKET_DIR", () => {
        Object.defineProperty(process, "platform", { value: "linux", configurable: true });
        process.env.KIRI_SOCKET_DIR = "/var/run";

        const veryLongPath = `/repo/${"component".repeat(15)}/db.duckdb`;
        const result = getSocketPath(veryLongPath);

        expect(result.startsWith("/var/run/kiri-")).toBe(true);
      });

      it("should throw if fallback directory is also too long", () => {
        Object.defineProperty(process, "platform", { value: "linux", configurable: true });
        process.env.KIRI_SOCKET_DIR = `/${"a".repeat(150)}`;

        const veryLongPath = `/repo/${"component".repeat(30)}/db.duckdb`;
        expect(() => getSocketPath(veryLongPath)).toThrow(/KIRI_SOCKET_DIR/);
      });

      it("should create fallback directory when missing", () => {
        Object.defineProperty(process, "platform", { value: "linux", configurable: true });
        const tempDir = path.join(os.tmpdir(), `kiri-fallback-${Date.now()}`);
        process.env.KIRI_SOCKET_DIR = tempDir;

        const cleanup = () => {
          if (existsSync(tempDir)) {
            rmSync(tempDir, { recursive: true, force: true });
          }
        };

        try {
          expect(existsSync(tempDir)).toBe(false);
          const longPath = `/repo/${"component".repeat(25)}/db.duckdb`;
          const result = getSocketPath(longPath, { ensureDir: true });
          expect(result.startsWith(`${tempDir}/kiri-`)).toBe(true);
          expect(existsSync(tempDir)).toBe(true);
        } finally {
          cleanup();
        }
      });
    });

    describe("Windows platform", () => {
      it("should generate Windows named pipe path with hash", () => {
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });

        const result = getSocketPath("C:\\Users\\test\\database.duckdb");
        // 形式: \\.\pipe\kiri-<16文字のhex>
        expect(result).toMatch(/^\\\\.\\pipe\\kiri-[a-f0-9]{16}$/);
      });

      it("should use KIRI_PIPE_PREFIX environment variable", () => {
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });
        process.env.KIRI_PIPE_PREFIX = "custom";

        const result = getSocketPath("C:\\test.duckdb");
        expect(result).toMatch(/^\\\\.\\pipe\\custom-[a-f0-9]{16}$/);
      });

      it("should handle paths with backslashes", () => {
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });

        const result = getSocketPath("C:\\Program Files\\KIRI\\database.duckdb");
        expect(result).toMatch(/^\\\\.\\pipe\\kiri-[a-f0-9]{16}$/);
      });

      it("should generate consistent hash for same database path", () => {
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });

        const result1 = getSocketPath("C:\\test\\db.duckdb");
        const result2 = getSocketPath("C:\\test\\db.duckdb");
        expect(result1).toBe(result2);
      });

      it("should generate different hash for different database paths", () => {
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });

        const result1 = getSocketPath("C:\\test\\db1.duckdb");
        const result2 = getSocketPath("C:\\test\\db2.duckdb");
        expect(result1).not.toBe(result2);
      });
    });
  });

  describe("getDatabasePathFromSocket", () => {
    describe("Unix platforms", () => {
      it("should extract database path from Unix socket", () => {
        Object.defineProperty(process, "platform", { value: "linux", configurable: true });

        const result = getDatabasePathFromSocket("/path/to/database.duckdb.sock");
        expect(result).toBe("/path/to/database.duckdb");
      });

      it("should return null for non-.sock paths", () => {
        Object.defineProperty(process, "platform", { value: "linux", configurable: true });

        const result = getDatabasePathFromSocket("/path/to/database.duckdb");
        expect(result).toBeNull();
      });

      it("should handle paths with multiple dots", () => {
        Object.defineProperty(process, "platform", { value: "linux", configurable: true });

        const result = getDatabasePathFromSocket("/path/to/file.v1.0.duckdb.sock");
        expect(result).toBe("/path/to/file.v1.0.duckdb");
      });
    });

    describe("Windows platform", () => {
      it("should return null for Windows named pipe", () => {
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });

        const result = getDatabasePathFromSocket("\\\\.\\pipe\\kiri-abc123");
        expect(result).toBeNull();
      });

      it("should return null even if pipe name contains .sock", () => {
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });

        const result = getDatabasePathFromSocket("\\\\.\\pipe\\test.sock");
        expect(result).toBeNull();
      });
    });
  });

  describe("getSocketPathDebugInfo", () => {
    it("should generate debug info for Unix socket", () => {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

      const result = getSocketPathDebugInfo("/var/lib/kiri/index.duckdb");
      expect(result).toContain("Database: index.duckdb");
      expect(result).toContain("/var/lib/kiri");
      expect(result).toContain("Unix domain socket");
      expect(result).toContain("0600");
    });

    it("should mention fallback when Unix socket path is shortened", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      process.env.KIRI_SOCKET_DIR = "/tmp";

      const info = getSocketPathDebugInfo(`/repo/${"deep".repeat(20)}/index.duckdb`);
      expect(info).toContain("Fallback: Socket path shortened");
    });

    it("should generate debug info for Windows named pipe", () => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });

      const result = getSocketPathDebugInfo("C:\\Users\\test\\database.duckdb");
      expect(result).toContain("Database: database.duckdb");
      expect(result).toContain("C:\\Users\\test");
      expect(result).toContain("Windows named pipe");
      expect(result).toContain("hash");
    });
  });
});
