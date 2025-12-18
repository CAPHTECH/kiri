/**
 * RequestQueue のユニットテスト
 *
 * @see Issue #156: MCP接続がデーモン再起動時に切断され、自動再接続しない問題への対応
 */

import { EventEmitter } from "events";
import type * as net from "net";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { RequestQueue, extractRequestId } from "../../src/client/request-queue.js";

describe("extractRequestId", () => {
  it("JSON-RPCリクエストからIDを抽出できる", () => {
    const data = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(extractRequestId(data)).toBe(1);
  });

  it("文字列IDを抽出できる", () => {
    const data = JSON.stringify({ jsonrpc: "2.0", id: "test-id", method: "ping" });
    expect(extractRequestId(data)).toBe("test-id");
  });

  it("idがない場合はnullを返す（notification）", () => {
    const data = JSON.stringify({ jsonrpc: "2.0", method: "ping" });
    expect(extractRequestId(data)).toBeNull();
  });

  it("idがnullの場合はnullを返す", () => {
    const data = JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" });
    expect(extractRequestId(data)).toBeNull();
  });

  it("不正なJSONの場合はnullを返す", () => {
    expect(extractRequestId("invalid json")).toBeNull();
  });
});

describe("RequestQueue", () => {
  let queue: RequestQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new RequestQueue({
      requestTimeoutMs: 1000,
      maxPendingRequests: 10,
      maxRetryCount: 3,
    });
  });

  afterEach(() => {
    queue.clear();
    vi.useRealTimers();
  });

  describe("enqueue", () => {
    it("リクエストをキューに追加できる", () => {
      const data = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
      const request = queue.enqueue(data);

      expect(request).not.toBeNull();
      expect(request?.id).toBe(1);
      expect(queue.size()).toBe(1);
    });

    it("notificationはキューに追加されない", () => {
      const data = JSON.stringify({ jsonrpc: "2.0", method: "ping" });
      const request = queue.enqueue(data);

      expect(request).toBeNull();
      expect(queue.size()).toBe(0);
    });

    it("同じIDのリクエストは上書きされる", () => {
      const data1 = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { v: 1 } });
      const data2 = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { v: 2 } });

      queue.enqueue(data1);
      queue.enqueue(data2);

      expect(queue.size()).toBe(1);
      const request = queue.get(1);
      expect(request?.data).toBe(data2);
    });

    it("キュー満杯時はonQueueFullが呼ばれる", () => {
      const onQueueFull = vi.fn();
      const smallQueue = new RequestQueue({
        maxPendingRequests: 2,
        onQueueFull,
      });

      smallQueue.enqueue(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
      smallQueue.enqueue(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }));
      const result = smallQueue.enqueue(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }));

      expect(result).toBeNull();
      expect(onQueueFull).toHaveBeenCalledTimes(1);
      expect(smallQueue.size()).toBe(2);

      smallQueue.clear();
    });
  });

  describe("dequeue", () => {
    it("レスポンス受信時にリクエストを削除できる", () => {
      const data = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
      queue.enqueue(data);

      const request = queue.dequeue(1);

      expect(request?.id).toBe(1);
      expect(queue.size()).toBe(0);
    });

    it("存在しないIDの場合はundefinedを返す", () => {
      const request = queue.dequeue(999);
      expect(request).toBeUndefined();
    });
  });

  describe("timeout", () => {
    it("タイムアウト時にonTimeoutが呼ばれる", () => {
      const onTimeout = vi.fn();
      const timeoutQueue = new RequestQueue({
        requestTimeoutMs: 1000,
        onTimeout,
      });

      const data = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
      timeoutQueue.enqueue(data);

      // タイムアウト前
      expect(timeoutQueue.size()).toBe(1);
      expect(onTimeout).not.toHaveBeenCalled();

      // タイムアウト後
      vi.advanceTimersByTime(1000);

      expect(timeoutQueue.size()).toBe(0);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(onTimeout).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));

      timeoutQueue.clear();
    });

    it("dequeue後はタイムアウトしない", () => {
      const onTimeout = vi.fn();
      const timeoutQueue = new RequestQueue({
        requestTimeoutMs: 1000,
        onTimeout,
      });

      const data = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
      timeoutQueue.enqueue(data);
      timeoutQueue.dequeue(1);

      vi.advanceTimersByTime(1000);

      expect(onTimeout).not.toHaveBeenCalled();

      timeoutQueue.clear();
    });
  });

  describe("replayAll", () => {
    it("再接続後に保留中のリクエストを再送信できる", async () => {
      const data1 = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
      const data2 = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "pong" });

      queue.enqueue(data1);
      queue.enqueue(data2);

      const mockSocket = createMockSocket();
      const replayedCount = await queue.replayAll(mockSocket as unknown as net.Socket);

      expect(replayedCount).toBe(2);
      expect(mockSocket.write).toHaveBeenCalledTimes(2);
    });

    it("リトライ回数を増加させる", async () => {
      const data = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
      queue.enqueue(data);

      const mockSocket = createMockSocket();
      await queue.replayAll(mockSocket as unknown as net.Socket);

      const request = queue.get(1);
      expect(request?.retryCount).toBe(1);
    });

    it("リトライ上限に達したリクエストはキューから削除される", async () => {
      const onTimeout = vi.fn();
      const retryQueue = new RequestQueue({
        maxRetryCount: 2,
        onTimeout,
      });

      const data = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
      retryQueue.enqueue(data);

      const mockSocket = createMockSocket();

      // 1回目のリプレイ
      await retryQueue.replayAll(mockSocket as unknown as net.Socket);
      expect(retryQueue.get(1)?.retryCount).toBe(1);

      // 2回目のリプレイ
      await retryQueue.replayAll(mockSocket as unknown as net.Socket);
      expect(retryQueue.get(1)?.retryCount).toBe(2);

      // 3回目のリプレイ（上限超過）
      await retryQueue.replayAll(mockSocket as unknown as net.Socket);
      expect(retryQueue.size()).toBe(0);
      expect(onTimeout).toHaveBeenCalledTimes(1);

      retryQueue.clear();
    });
  });

  describe("clear", () => {
    it("キューをクリアできる", () => {
      queue.enqueue(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
      queue.enqueue(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "pong" }));

      queue.clear();

      expect(queue.size()).toBe(0);
    });

    it("タイムアウトタイマーもクリアされる", () => {
      const onTimeout = vi.fn();
      const timeoutQueue = new RequestQueue({
        requestTimeoutMs: 1000,
        onTimeout,
      });

      timeoutQueue.enqueue(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
      timeoutQueue.clear();

      vi.advanceTimersByTime(1000);

      expect(onTimeout).not.toHaveBeenCalled();

      timeoutQueue.clear();
    });
  });

  describe("getAll", () => {
    it("全ての保留中リクエストを取得できる", () => {
      queue.enqueue(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
      queue.enqueue(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "pong" }));

      const all = queue.getAll();

      expect(all).toHaveLength(2);
      expect(all.map((r) => r.id)).toContain(1);
      expect(all.map((r) => r.id)).toContain(2);
    });
  });
});

/**
 * モックソケットを作成
 */
function createMockSocket() {
  const emitter = new EventEmitter();
  const mockSocket = {
    ...emitter,
    write: vi.fn((data: string, callback?: (err?: Error) => void) => {
      if (callback) {
        callback();
      }
      return true;
    }),
    end: vi.fn(),
    destroy: vi.fn(),
  };
  return mockSocket;
}
