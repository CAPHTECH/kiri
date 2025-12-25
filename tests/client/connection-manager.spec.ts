/**
 * ConnectionManager のユニットテスト
 *
 * @see Issue #156: MCP接続がデーモン再起動時に切断され、自動再接続しない問題への対応
 */

import { EventEmitter } from "events";
import type { Socket } from "net";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { ConnectionManager, isRetriableError } from "../../src/client/connection-manager.js";
import { calculateBackoffDelay } from "../../src/shared/utils/retry.js";

// モック
vi.mock("../../src/client/start-daemon.js", () => ({
  isDaemonRunning: vi.fn().mockResolvedValue(true),
  startDaemon: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("net", () => {
  return {
    connect: vi.fn(() => {
      const socket = new EventEmitter() as unknown as Socket;
      socket.write = ((...args: Parameters<Socket["write"]>) => {
        const maybeCallback = typeof args[1] === "function" ? args[1] : args[2];
        if (typeof maybeCallback === "function") {
          maybeCallback();
        }
        return true;
      }) as Socket["write"];
      socket.end = ((..._args: Parameters<Socket["end"]>) => socket) as Socket["end"];
      socket.destroy = ((..._args: Parameters<Socket["destroy"]>) => socket) as Socket["destroy"];
      socket.removeAllListeners = ((..._args: Parameters<Socket["removeAllListeners"]>) =>
        socket) as Socket["removeAllListeners"];
      // 接続成功をシミュレート
      setTimeout(() => socket.emit("connect"), 10);
      return socket;
    }),
  };
});

describe("isRetriableError", () => {
  it("ECONNREFUSEDは再接続可能", () => {
    const error = new Error("Connection refused") as NodeJS.ErrnoException;
    error.code = "ECONNREFUSED";
    expect(isRetriableError(error)).toBe(true);
  });

  it("EPIPEは再接続可能", () => {
    const error = new Error("Broken pipe") as NodeJS.ErrnoException;
    error.code = "EPIPE";
    expect(isRetriableError(error)).toBe(true);
  });

  it("ECONNRESETは再接続可能", () => {
    const error = new Error("Connection reset") as NodeJS.ErrnoException;
    error.code = "ECONNRESET";
    expect(isRetriableError(error)).toBe(true);
  });

  it("ENOENTは再接続可能", () => {
    const error = new Error("No such file") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    expect(isRetriableError(error)).toBe(true);
  });

  it("EACCESは再接続不可", () => {
    const error = new Error("Permission denied") as NodeJS.ErrnoException;
    error.code = "EACCES";
    expect(isRetriableError(error)).toBe(false);
  });

  it("コードなしのエラーは再接続不可", () => {
    const error = new Error("Unknown error");
    expect(isRetriableError(error)).toBe(false);
  });

  it("非Errorオブジェクトは再接続不可", () => {
    expect(isRetriableError("string error")).toBe(false);
    expect(isRetriableError(null)).toBe(false);
    expect(isRetriableError(undefined)).toBe(false);
  });
});

describe("calculateBackoffDelay", () => {
  it("線形バックオフ（multiplier=1）", () => {
    // ジッターなしで計算
    const delay1 = calculateBackoffDelay(500, 1, 1, undefined, 0);
    const delay2 = calculateBackoffDelay(500, 2, 1, undefined, 0);
    const delay3 = calculateBackoffDelay(500, 3, 1, undefined, 0);

    expect(delay1).toBe(500);
    expect(delay2).toBe(500);
    expect(delay3).toBe(500);
  });

  it("指数バックオフ（multiplier=2）", () => {
    const delay1 = calculateBackoffDelay(500, 1, 2, undefined, 0);
    const delay2 = calculateBackoffDelay(500, 2, 2, undefined, 0);
    const delay3 = calculateBackoffDelay(500, 3, 2, undefined, 0);

    expect(delay1).toBe(500); // 500 * 2^0
    expect(delay2).toBe(1000); // 500 * 2^1
    expect(delay3).toBe(2000); // 500 * 2^2
  });

  it("最大遅延で上限を設定", () => {
    const delay = calculateBackoffDelay(500, 10, 2, 5000, 0);
    expect(delay).toBe(5000); // 500 * 2^9 = 256000 だが、上限5000
  });

  it("ジッターが追加される", () => {
    // ジッターありの場合、基本遅延以上になる
    const delay = calculateBackoffDelay(500, 1, 1, undefined, 100);
    expect(delay).toBeGreaterThanOrEqual(500);
    expect(delay).toBeLessThanOrEqual(600);
  });
});

describe("ConnectionManager", () => {
  let manager: ConnectionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new ConnectionManager({
      socketPath: "/tmp/test.sock",
      databasePath: "/tmp/test.duckdb",
      repoRoot: "/tmp/repo",
      maxReconnectAttempts: 3,
      reconnectInitialDelayMs: 100,
      reconnectMaxDelayMs: 1000,
      backoffMultiplier: 2,
      jitterMs: 0,
    });
  });

  afterEach(() => {
    manager.close();
  });

  describe("初期状態", () => {
    it("disconnected状態で開始", () => {
      const state = manager.getState();
      expect(state.status).toBe("disconnected");
      expect(state.reconnectAttempt).toBe(0);
    });

    it("ソケットはnull", () => {
      expect(manager.getSocket()).toBeNull();
    });
  });

  describe("connect", () => {
    it("接続成功後はconnected状態", async () => {
      await manager.connect();

      const state = manager.getState();
      expect(state.status).toBe("connected");
      expect(state.lastConnectedAt).toBeDefined();
      expect(manager.getSocket()).not.toBeNull();
    });

    it("connectedイベントが発火", async () => {
      const onConnected = vi.fn();
      manager.on("connected", onConnected);

      await manager.connect();

      expect(onConnected).toHaveBeenCalledTimes(1);
    });

    it("閉じた後の接続はエラー", async () => {
      manager.close();

      await expect(manager.connect()).rejects.toThrow("ConnectionManager is closed");
    });
  });

  describe("close", () => {
    it("接続を閉じるとdisconnected状態", async () => {
      await manager.connect();
      manager.close();

      const state = manager.getState();
      expect(state.status).toBe("disconnected");
      expect(manager.getSocket()).toBeNull();
    });

    it("リクエストキューがクリアされる", async () => {
      const queue = manager.getRequestQueue();
      queue.enqueue(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));

      manager.close();

      expect(queue.size()).toBe(0);
    });
  });

  describe("getState", () => {
    it("状態のコピーを返す", () => {
      const state1 = manager.getState();
      const state2 = manager.getState();

      expect(state1).not.toBe(state2);
      expect(state1).toEqual(state2);
    });
  });

  describe("イベント", () => {
    it("dataイベントが転送される", async () => {
      const onData = vi.fn();
      manager.on("data", onData);

      await manager.connect();
      const socket = manager.getSocket();
      socket!.emit("data", Buffer.from("test data"));

      expect(onData).toHaveBeenCalledWith(Buffer.from("test data"));
    });

    it("errorイベントが転送される", async () => {
      const onError = vi.fn();
      manager.on("error", onError);

      await manager.connect();
      const socket = manager.getSocket();
      const testError = new Error("Test error");
      socket!.emit("error", testError);

      expect(onError).toHaveBeenCalledWith(testError);
    });
  });
});

describe("ConnectionManager reconnect", () => {
  it("再接続中はreconnecting状態", async () => {
    const { isDaemonRunning } = await import("../../src/client/start-daemon.js");
    vi.mocked(isDaemonRunning).mockResolvedValue(true);

    const manager = new ConnectionManager({
      socketPath: "/tmp/test.sock",
      databasePath: "/tmp/test.duckdb",
      repoRoot: "/tmp/repo",
      maxReconnectAttempts: 1,
      reconnectInitialDelayMs: 10,
      jitterMs: 0,
    });

    const onReconnecting = vi.fn();
    manager.on("reconnecting", onReconnecting);

    await manager.connect();

    // 接続を切断してから再接続
    manager.getSocket()!.emit("end");

    // 少し待って再接続イベントを確認
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(onReconnecting).toHaveBeenCalled();

    manager.close();
  });
});
