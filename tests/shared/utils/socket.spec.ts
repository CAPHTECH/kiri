import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getDatabasePathFromSocket,
  getSocketPath,
  getSocketPathDebugInfo,
} from "../../../src/shared/utils/socket.js";

describe("Socket Path Utility", () => {
  let originalPlatform: NodeJS.Platform;
  let originalEnv: string | undefined;

  beforeEach(() => {
    // プラットフォームと環境変数をバックアップ
    originalPlatform = process.platform;
    originalEnv = process.env.KIRI_PIPE_PREFIX;
  });

  afterEach(() => {
    // プラットフォームと環境変数を復元
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    if (originalEnv === undefined) {
      delete process.env.KIRI_PIPE_PREFIX;
    } else {
      process.env.KIRI_PIPE_PREFIX = originalEnv;
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
