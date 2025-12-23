/**
 * Tests for zombie daemon detection and cleanup
 */

import * as fs from "fs/promises";
import * as net from "net";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  detectAndCleanupZombie,
  extractPidFromLockError,
  isDuckDBLockConflictError,
  isProcessListeningOnSocket,
} from "../../src/daemon/zombie-detector.js";

describe("extractPidFromLockError", () => {
  it("extracts PID from valid DuckDB lock error message", () => {
    const errorMessage = `IO Error: Could not set lock on file "/path/to/db": Conflicting lock is held in /Users/test/.local/node (PID 38342) by user testuser`;
    expect(extractPidFromLockError(errorMessage)).toBe(38342);
  });

  it("extracts PID with different formatting", () => {
    const errorMessage = `IO Error: Could not set lock on file: Conflicting lock is held in node (PID 12345)`;
    expect(extractPidFromLockError(errorMessage)).toBe(12345);
  });

  it("returns null for non-matching error message", () => {
    expect(extractPidFromLockError("Some other error")).toBeNull();
    expect(extractPidFromLockError("No PID here")).toBeNull();
    expect(extractPidFromLockError("")).toBeNull();
  });

  it("returns null for invalid PID values", () => {
    // PID 0 は無効
    expect(extractPidFromLockError("(PID 0)")).toBeNull();
    // 負の値
    expect(extractPidFromLockError("(PID -1)")).toBeNull();
  });

  it("returns null for non-numeric PID", () => {
    expect(extractPidFromLockError("(PID abc)")).toBeNull();
  });
});

describe("isDuckDBLockConflictError", () => {
  it("returns true for DuckDB lock conflict error", () => {
    const error = new Error(
      `IO Error: Could not set lock on file "/path": Conflicting lock is held in /node (PID 123)`
    );
    expect(isDuckDBLockConflictError(error)).toBe(true);
  });

  it("returns true for partial match", () => {
    const error = new Error(`Could not set lock on file and Conflicting lock detected`);
    expect(isDuckDBLockConflictError(error)).toBe(true);
  });

  it("returns false for other errors", () => {
    expect(isDuckDBLockConflictError(new Error("Not a lock error"))).toBe(false);
    expect(isDuckDBLockConflictError(new Error("Connection refused"))).toBe(false);
  });

  it("returns false for non-Error objects", () => {
    expect(isDuckDBLockConflictError("string error")).toBe(false);
    expect(isDuckDBLockConflictError(null)).toBe(false);
    expect(isDuckDBLockConflictError(undefined)).toBe(false);
    expect(isDuckDBLockConflictError(123)).toBe(false);
  });

  it("returns false if only one keyword is present", () => {
    expect(isDuckDBLockConflictError(new Error("Could not set lock on file"))).toBe(false);
    expect(isDuckDBLockConflictError(new Error("Conflicting lock"))).toBe(false);
  });
});

describe("isProcessListeningOnSocket", () => {
  let tmpDir: string;
  let socketPath: string;
  let server: net.Server | null = null;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kiri-zombie-detector-test-"));
    socketPath = path.join(tmpDir, "test.sock");
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
      });
      server = null;
    }
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("returns true when daemon responds to ping", async () => {
    // 正常なdaemonをシミュレート
    server = net.createServer((socket) => {
      socket.on("data", (data) => {
        const request = JSON.parse(data.toString().trim());
        if (request.method === "ping") {
          const response = {
            jsonrpc: "2.0",
            id: request.id,
            result: { status: "ok" },
          };
          socket.write(JSON.stringify(response) + "\n");
        }
      });
    });

    await new Promise<void>((resolve) => {
      server!.listen(socketPath, () => resolve());
    });

    const result = await isProcessListeningOnSocket(socketPath);
    expect(result).toBe(true);
  });

  it("returns false when socket does not exist", async () => {
    const result = await isProcessListeningOnSocket("/nonexistent/path/socket.sock");
    expect(result).toBe(false);
  });

  it("returns false when daemon does not respond correctly", async () => {
    // 不正なレスポンスを返すサーバー
    server = net.createServer((socket) => {
      socket.on("data", () => {
        socket.write('{"invalid": "response"}\n');
      });
    });

    await new Promise<void>((resolve) => {
      server!.listen(socketPath, () => resolve());
    });

    const result = await isProcessListeningOnSocket(socketPath);
    expect(result).toBe(false);
  });

  it("returns false on timeout", async () => {
    // レスポンスを返さないサーバー
    server = net.createServer((socket) => {
      // 接続を受け付けるが、何も返さない
      // ソケットを保持してタイムアウトまで待つ
      socket.on("data", () => {
        // データを無視
      });
    });

    await new Promise<void>((resolve) => {
      server!.listen(socketPath, () => resolve());
    });

    // 短いタイムアウトでテスト
    const result = await isProcessListeningOnSocket(socketPath, 100);
    expect(result).toBe(false);
  }, 5000); // テスト自体のタイムアウトを5秒に設定
});

describe("detectAndCleanupZombie", () => {
  let tmpDir: string;
  let socketPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kiri-zombie-cleanup-test-"));
    socketPath = path.join(tmpDir, "test.sock");
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("returns true when process does not exist", async () => {
    // 存在しないPID
    const result = await detectAndCleanupZombie(999999, socketPath);
    expect(result).toBe(true);
  });

  it("returns false when daemon is listening normally", async () => {
    // 正常なdaemonをシミュレート
    const server = net.createServer((socket) => {
      socket.on("data", (data) => {
        const request = JSON.parse(data.toString().trim());
        if (request.method === "ping") {
          const response = {
            jsonrpc: "2.0",
            id: request.id,
            result: { status: "ok" },
          };
          socket.write(JSON.stringify(response) + "\n");
        }
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(socketPath, () => resolve());
    });

    try {
      // 現在のプロセス自身をテスト（実際にkillしないので安全）
      const result = await detectAndCleanupZombie(process.pid, socketPath);
      expect(result).toBe(false);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("logs appropriate message for zombie detection", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // 存在しないPIDでテスト
    await detectAndCleanupZombie(999999, socketPath);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Conflicting process (PID 999999) is no longer running")
    );

    consoleSpy.mockRestore();
  });
});
