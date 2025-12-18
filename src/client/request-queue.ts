/**
 * RequestQueue - 再接続中のリクエストをバッファリングし、再接続後に再送信する
 *
 * @see Issue #156: MCP接続がデーモン再起動時に切断され、自動再接続しない問題への対応
 */

import type * as net from "net";

/**
 * 保留中のリクエスト情報
 */
export interface PendingRequest {
  /** JSON-RPC リクエストID */
  id: string | number;
  /** JSON-RPC リクエスト文字列（送信用） */
  data: string;
  /** 送信時刻（タイムアウト計算用） */
  timestamp: number;
  /** タイムアウト時間（ミリ秒） */
  timeoutMs: number;
  /** リトライ回数 */
  retryCount: number;
  /** タイムアウトタイマーID */
  timeoutTimer?: NodeJS.Timeout;
}

/**
 * RequestQueueのオプション
 */
export interface RequestQueueOptions {
  /** リクエストタイムアウト時間（ミリ秒）。デフォルト: 30000 */
  requestTimeoutMs?: number;
  /** 最大保留リクエスト数。デフォルト: 100 */
  maxPendingRequests?: number;
  /** 最大リトライ回数。デフォルト: 3 */
  maxRetryCount?: number;
  /** タイムアウト時のコールバック */
  onTimeout?: (request: PendingRequest) => void;
  /** キュー満杯時のコールバック */
  onQueueFull?: (request: PendingRequest) => void;
}

/**
 * JSON-RPCリクエストからIDを抽出するユーティリティ
 */
export function extractRequestId(data: string): string | number | null {
  try {
    const parsed = JSON.parse(data);
    // JSON-RPC 2.0のidフィールドを取得
    // idがない場合はnotificationなのでキューイング不要
    if (parsed.id !== undefined && parsed.id !== null) {
      return parsed.id;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * リクエストキュー
 *
 * 再接続中のリクエストをバッファリングし、再接続後に再送信する。
 * タイムアウト管理とリトライ制限を提供する。
 */
export class RequestQueue {
  private readonly queue: Map<string | number, PendingRequest> = new Map();
  private readonly requestTimeoutMs: number;
  private readonly maxPendingRequests: number;
  private readonly maxRetryCount: number;
  private readonly onTimeout: ((request: PendingRequest) => void) | undefined;
  private readonly onQueueFull: ((request: PendingRequest) => void) | undefined;

  constructor(options: RequestQueueOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.maxPendingRequests = options.maxPendingRequests ?? 100;
    this.maxRetryCount = options.maxRetryCount ?? 3;
    this.onTimeout = options.onTimeout ?? undefined;
    this.onQueueFull = options.onQueueFull ?? undefined;
  }

  /**
   * リクエストをキューに追加
   *
   * @param data - JSON-RPC リクエスト文字列
   * @returns 追加されたリクエスト情報、またはnull（notificationの場合やキュー満杯の場合）
   */
  enqueue(data: string): PendingRequest | null {
    const id = extractRequestId(data);

    // idがない場合はnotification（応答不要）なのでキューイング不要
    if (id === null) {
      return null;
    }

    // キュー満杯チェック
    if (this.queue.size >= this.maxPendingRequests) {
      const request: PendingRequest = {
        id,
        data,
        timestamp: Date.now(),
        timeoutMs: this.requestTimeoutMs,
        retryCount: 0,
      };
      this.onQueueFull?.(request);
      return null;
    }

    // 既存のリクエストがある場合は上書き（同じIDのリクエストは最新のみ保持）
    const existing = this.queue.get(id);
    if (existing?.timeoutTimer) {
      clearTimeout(existing.timeoutTimer);
    }

    const request: PendingRequest = {
      id,
      data,
      timestamp: Date.now(),
      timeoutMs: this.requestTimeoutMs,
      retryCount: existing?.retryCount ?? 0,
    };

    // タイムアウトタイマーを設定
    request.timeoutTimer = setTimeout(() => {
      this.handleTimeout(id);
    }, this.requestTimeoutMs);

    this.queue.set(id, request);
    return request;
  }

  /**
   * レスポンス受信時にキューからリクエストを削除
   *
   * @param id - JSON-RPC リクエストID
   * @returns 削除されたリクエスト情報、またはundefined
   */
  dequeue(id: string | number): PendingRequest | undefined {
    const request = this.queue.get(id);
    if (request) {
      if (request.timeoutTimer) {
        clearTimeout(request.timeoutTimer);
      }
      this.queue.delete(id);
    }
    return request;
  }

  /**
   * 再接続後に保留中のリクエストを再送信
   *
   * @param socket - 再接続後のソケット
   * @returns 再送信されたリクエスト数
   */
  async replayAll(socket: net.Socket): Promise<number> {
    let replayedCount = 0;
    const toRemove: (string | number)[] = [];

    for (const [id, request] of this.queue) {
      // リトライ上限チェック
      if (request.retryCount >= this.maxRetryCount) {
        toRemove.push(id);
        continue;
      }

      // リトライ回数を増加
      request.retryCount++;

      // タイムアウトタイマーをリセット
      if (request.timeoutTimer) {
        clearTimeout(request.timeoutTimer);
      }
      request.timeoutTimer = setTimeout(() => {
        this.handleTimeout(id);
      }, this.requestTimeoutMs);

      // ソケットに再送信
      try {
        await this.writeToSocket(socket, request.data);
        replayedCount++;
      } catch {
        // 書き込みエラーは無視（次の再接続で再試行）
      }
    }

    // リトライ上限に達したリクエストを削除
    for (const id of toRemove) {
      const request = this.queue.get(id);
      if (request?.timeoutTimer) {
        clearTimeout(request.timeoutTimer);
      }
      this.queue.delete(id);
      if (request) {
        this.onTimeout?.(request);
      }
    }

    return replayedCount;
  }

  /**
   * キュー内のリクエスト数を取得
   */
  size(): number {
    return this.queue.size;
  }

  /**
   * キューをクリア（全リクエストのタイムアウトタイマーも解除）
   */
  clear(): void {
    for (const request of this.queue.values()) {
      if (request.timeoutTimer) {
        clearTimeout(request.timeoutTimer);
      }
    }
    this.queue.clear();
  }

  /**
   * 全ての保留中リクエストを取得（デバッグ用）
   */
  getAll(): PendingRequest[] {
    return Array.from(this.queue.values());
  }

  /**
   * 特定のリクエストを取得
   */
  get(id: string | number): PendingRequest | undefined {
    return this.queue.get(id);
  }

  /**
   * タイムアウト処理
   */
  private handleTimeout(id: string | number): void {
    const request = this.queue.get(id);
    if (request) {
      this.queue.delete(id);
      this.onTimeout?.(request);
    }
  }

  /**
   * ソケットへの書き込み（Promise化）
   */
  private writeToSocket(socket: net.Socket, data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.write(data + "\n", (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
}
