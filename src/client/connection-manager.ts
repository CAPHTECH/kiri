/**
 * ConnectionManager - ソケット接続の確立・維持・再接続を管理
 *
 * @see Issue #156: MCP接続がデーモン再起動時に切断され、自動再接続しない問題への対応
 */

import { EventEmitter } from "events";
import * as net from "net";

import { calculateBackoffDelay } from "../shared/utils/retry.js";

import { RequestQueue } from "./request-queue.js";
import { startDaemon, isDaemonRunning } from "./start-daemon.js";

/**
 * 接続状態
 */
export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting";

/**
 * 接続状態の詳細情報
 */
export interface ConnectionState {
  status: ConnectionStatus;
  lastConnectedAt?: number;
  disconnectedAt?: number;
  reconnectAttempt: number;
}

/**
 * 再接続可能なエラーコード
 */
const RETRIABLE_ERROR_CODES = new Set([
  "ECONNREFUSED", // デーモン未起動
  "EPIPE", // 接続切断
  "ECONNRESET", // 接続リセット
  "ENOENT", // ソケットファイル未作成
  "ETIMEDOUT", // 接続タイムアウト
]);

/**
 * エラーが再接続可能かどうかを判定
 */
export function isRetriableError(error: unknown): boolean {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== undefined && RETRIABLE_ERROR_CODES.has(code);
  }
  return false;
}

/**
 * ConnectionManagerのオプション
 */
export interface ConnectionManagerOptions {
  /** ソケットパス */
  socketPath: string;
  /** データベースパス（デーモン起動用） */
  databasePath: string;
  /** リポジトリルート（デーモン起動用） */
  repoRoot: string;
  /** 最大再接続試行回数。デフォルト: 10 */
  maxReconnectAttempts?: number | undefined;
  /** 初期再接続遅延（ミリ秒）。デフォルト: 500 */
  reconnectInitialDelayMs?: number | undefined;
  /** 最大再接続遅延（ミリ秒）。デフォルト: 30000 */
  reconnectMaxDelayMs?: number | undefined;
  /** バックオフ倍率。デフォルト: 2 */
  backoffMultiplier?: number | undefined;
  /** ジッター（ミリ秒）。デフォルト: 100 */
  jitterMs?: number | undefined;
  /** リクエストキュー（外部から注入可能） */
  requestQueue?: RequestQueue | undefined;
  /** ウォッチモード */
  watchMode?: boolean | undefined;
  /** デバウンス時間（ミリ秒） */
  debounceMs?: number | undefined;
  /** 縮退モード許可 */
  allowDegrade?: boolean | undefined;
  /** セキュリティ設定パス */
  securityConfigPath?: string | undefined;
  /** セキュリティロックパス */
  securityLockPath?: string | undefined;
}

/**
 * ConnectionManagerイベント
 */
export interface ConnectionManagerEvents {
  connected: [];
  disconnected: [reason: string];
  reconnecting: [attempt: number, maxAttempts: number, delayMs: number];
  reconnected: [];
  maxRetriesExceeded: [];
  data: [data: Buffer];
  error: [error: Error];
}

/**
 * 接続マネージャー
 *
 * ソケット接続の確立・維持・再接続を管理する。
 * 指数バックオフ付きリトライ戦略を提供する。
 */
export class ConnectionManager extends EventEmitter {
  private socket: net.Socket | null = null;
  private state: ConnectionState = {
    status: "disconnected",
    reconnectAttempt: 0,
  };
  private readonly socketPath: string;
  private readonly databasePath: string;
  private readonly repoRoot: string;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectInitialDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly backoffMultiplier: number;
  private readonly jitterMs: number;
  private readonly requestQueue: RequestQueue;
  private readonly watchMode: boolean;
  private readonly debounceMs: number;
  private readonly allowDegrade: boolean;
  private readonly securityConfigPath: string | undefined;
  private readonly securityLockPath: string | undefined;
  private isReconnecting = false;
  private isClosed = false;
  /** 再接続待機中のintervalをトラッキング（close時にクリーンアップ） */
  private pendingWaitIntervals: Set<NodeJS.Timeout> = new Set();

  constructor(options: ConnectionManagerOptions) {
    super();
    this.socketPath = options.socketPath;
    this.databasePath = options.databasePath;
    this.repoRoot = options.repoRoot;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
    this.reconnectInitialDelayMs = options.reconnectInitialDelayMs ?? 500;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30000;
    this.backoffMultiplier = options.backoffMultiplier ?? 2;
    this.jitterMs = options.jitterMs ?? 100;
    this.requestQueue = options.requestQueue ?? new RequestQueue();
    this.watchMode = options.watchMode ?? false;
    this.debounceMs = options.debounceMs ?? 500;
    this.allowDegrade = options.allowDegrade ?? false;
    this.securityConfigPath = options.securityConfigPath;
    this.securityLockPath = options.securityLockPath;
  }

  /**
   * 型安全なイベント発火
   */
  override emit<K extends keyof ConnectionManagerEvents>(
    event: K,
    ...args: ConnectionManagerEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }

  /**
   * 型安全なイベントリスナー登録
   */
  override on<K extends keyof ConnectionManagerEvents>(
    event: K,
    listener: (...args: ConnectionManagerEvents[K]) => void
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  /**
   * 初回接続を確立
   */
  async connect(): Promise<net.Socket> {
    if (this.isClosed) {
      throw new Error("ConnectionManager is closed");
    }

    if (this.socket && this.state.status === "connected") {
      return this.socket;
    }

    this.state.status = "connecting";

    // デーモンが起動していない場合は起動（カスタムソケットパスを考慮）
    const running = await isDaemonRunning(this.databasePath, this.socketPath);
    if (!running) {
      console.error("[ConnectionManager] Daemon not running. Starting daemon...");
      await startDaemon({
        repoRoot: this.repoRoot,
        databasePath: this.databasePath,
        socketPath: this.socketPath,
        watchMode: this.watchMode,
        debounceMs: this.debounceMs,
        allowDegrade: this.allowDegrade,
        securityConfigPath: this.securityConfigPath,
        securityLockPath: this.securityLockPath,
      });
      console.error("[ConnectionManager] Daemon started successfully");
    }

    this.socket = await this.createConnection();
    this.setupSocketListeners(this.socket);

    this.state.status = "connected";
    this.state.lastConnectedAt = Date.now();
    this.state.reconnectAttempt = 0;

    this.emit("connected");

    return this.socket;
  }

  /**
   * 再接続を試行
   */
  async reconnect(): Promise<net.Socket> {
    if (this.isClosed) {
      throw new Error("ConnectionManager is closed");
    }

    if (this.isReconnecting) {
      // 既に再接続中の場合は完了を待機（タイムアウト付き）
      const waitTimeoutMs = this.maxReconnectAttempts * this.reconnectMaxDelayMs + 10000;
      return new Promise((resolve, reject) => {
        const startTime = Date.now();
        const checkInterval = setInterval(() => {
          // タイムアウトチェック
          if (Date.now() - startTime > waitTimeoutMs) {
            clearInterval(checkInterval);
            this.pendingWaitIntervals.delete(checkInterval);
            reject(new Error("Reconnection wait timeout"));
            return;
          }
          // close()が呼ばれた場合
          if (this.isClosed) {
            clearInterval(checkInterval);
            this.pendingWaitIntervals.delete(checkInterval);
            reject(new Error("ConnectionManager is closed"));
            return;
          }
          // 再接続完了チェック
          if (!this.isReconnecting) {
            clearInterval(checkInterval);
            this.pendingWaitIntervals.delete(checkInterval);
            if (this.socket && this.state.status === "connected") {
              resolve(this.socket);
            } else {
              reject(new Error("Reconnection failed"));
            }
          }
        }, 100);
        this.pendingWaitIntervals.add(checkInterval);
      });
    }

    this.isReconnecting = true;
    this.state.status = "reconnecting";
    this.state.disconnectedAt = Date.now();

    try {
      for (let attempt = 1; attempt <= this.maxReconnectAttempts; attempt++) {
        this.state.reconnectAttempt = attempt;

        const delayMs = calculateBackoffDelay(
          this.reconnectInitialDelayMs,
          attempt,
          this.backoffMultiplier,
          this.reconnectMaxDelayMs,
          this.jitterMs
        );

        this.emit("reconnecting", attempt, this.maxReconnectAttempts, delayMs);
        console.error(
          `[ConnectionManager] Reconnection attempt ${attempt}/${this.maxReconnectAttempts} (delay: ${Math.round(delayMs)}ms)`
        );

        // 遅延
        await new Promise((resolve) => setTimeout(resolve, delayMs));

        // デーモンが起動していない場合は起動を試みる（カスタムソケットパスを考慮）
        const running = await isDaemonRunning(this.databasePath, this.socketPath);
        if (!running) {
          console.error("[ConnectionManager] Daemon not running. Attempting to start...");
          try {
            await startDaemon({
              repoRoot: this.repoRoot,
              databasePath: this.databasePath,
              socketPath: this.socketPath,
              watchMode: this.watchMode,
              debounceMs: this.debounceMs,
              allowDegrade: this.allowDegrade,
              securityConfigPath: this.securityConfigPath,
              securityLockPath: this.securityLockPath,
            });
          } catch (startErr) {
            console.error(
              `[ConnectionManager] Failed to start daemon: ${(startErr as Error).message}`
            );
            continue;
          }
        }

        try {
          // 古いソケットをクリーンアップ
          if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.destroy();
            this.socket = null;
          }

          this.socket = await this.createConnection();
          this.setupSocketListeners(this.socket);

          this.state.status = "connected";
          this.state.lastConnectedAt = Date.now();
          this.state.reconnectAttempt = 0;

          // 保留中のリクエストを再送信
          const replayedCount = await this.requestQueue.replayAll(this.socket);
          if (replayedCount > 0) {
            console.error(`[ConnectionManager] Replayed ${replayedCount} pending requests`);
          }

          this.emit("reconnected");
          console.error("[ConnectionManager] Reconnected to daemon successfully");

          return this.socket;
        } catch (err) {
          console.error(
            `[ConnectionManager] Reconnection attempt ${attempt} failed: ${(err as Error).message}`
          );
        }
      }

      // 最大リトライ回数超過
      this.state.status = "disconnected";
      this.emit("maxRetriesExceeded");
      console.error(
        `[ConnectionManager] Max reconnection attempts (${this.maxReconnectAttempts}) exceeded`
      );
      throw new Error(`Failed to reconnect after ${this.maxReconnectAttempts} attempts`);
    } finally {
      this.isReconnecting = false;
    }
  }

  /**
   * データを送信（キュー経由）
   *
   * 接続中の場合は即座に送信。未接続の場合はキューに追加し、
   * 再接続後にreplayAll()で自動送信される。
   */
  async send(data: string): Promise<void> {
    // 接続中の場合は即座に送信
    if (this.socket && this.state.status === "connected") {
      // キューに追加（レスポンス受信時にdequeueされる）
      this.requestQueue.enqueue(data);
      return new Promise((resolve, reject) => {
        this.socket!.write(data + "\n", (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    }

    // 未接続の場合はキューに追加して再接続
    // 再接続成功時にreplayAll()で自動送信されるため、ここでは送信しない
    this.requestQueue.enqueue(data);
    await this.reconnect();
    // replayAll()で既に送信済みなので、追加の送信は不要
  }

  /**
   * 接続を閉じる
   */
  close(): void {
    this.isClosed = true;
    this.requestQueue.clear();

    // 待機中のintervalをすべてクリア
    for (const interval of this.pendingWaitIntervals) {
      clearInterval(interval);
    }
    this.pendingWaitIntervals.clear();

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }

    this.state.status = "disconnected";
  }

  /**
   * 現在の接続状態を取得
   */
  getState(): ConnectionState {
    return { ...this.state };
  }

  /**
   * 現在のソケットを取得
   */
  getSocket(): net.Socket | null {
    return this.socket;
  }

  /**
   * リクエストキューを取得
   */
  getRequestQueue(): RequestQueue {
    return this.requestQueue;
  }

  /**
   * ソケット接続を作成
   */
  private createConnection(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.socketPath);

      const onConnect = () => {
        socket.removeListener("error", onError);
        resolve(socket);
      };

      const onError = (err: Error) => {
        socket.removeListener("connect", onConnect);
        reject(err);
      };

      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
  }

  /**
   * ソケットイベントリスナーを設定
   */
  private setupSocketListeners(socket: net.Socket): void {
    // 大きなレスポンスは複数のチャンクに分割されて到着するため、
    // バッファリングして完全な行のみを処理する
    let dequeueBuffer = "";

    socket.on("data", (data) => {
      this.emit("data", data);

      // レスポンスを受信したらキューから削除
      dequeueBuffer += data.toString();
      const lines = dequeueBuffer.split("\n");
      dequeueBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line);
          if (response.id !== undefined && response.id !== null) {
            this.requestQueue.dequeue(response.id);
          }
        } catch {
          // JSONパースエラーは無視
        }
      }
    });

    socket.on("end", () => {
      console.error("[ConnectionManager] Connection ended");
      this.emit("disconnected", "Connection ended");
      this.handleDisconnection();
    });

    socket.on("error", (err) => {
      console.error(`[ConnectionManager] Socket error: ${err.message}`);
      this.emit("error", err);

      if (isRetriableError(err)) {
        this.emit("disconnected", `Socket error: ${err.message}`);
        this.handleDisconnection();
      }
    });

    socket.on("close", () => {
      if (this.state.status === "connected") {
        console.error("[ConnectionManager] Connection closed");
        this.emit("disconnected", "Connection closed");
        this.handleDisconnection();
      }
    });
  }

  /**
   * 切断時の処理
   */
  private handleDisconnection(): void {
    if (this.isClosed || this.isReconnecting) {
      return;
    }

    this.state.status = "disconnected";
    this.state.disconnectedAt = Date.now();

    // 自動再接続を開始
    this.reconnect().catch((err) => {
      console.error(`[ConnectionManager] Auto-reconnection failed: ${err.message}`);
    });
  }
}
