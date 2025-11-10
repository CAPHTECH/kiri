/**
 * DartAnalysisClient: Dart Analysis Server との JSON-RPC 通信クライアント
 */

import { spawn, type ChildProcess, execSync } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import PQueue from "p-queue";
import { detectDartSdk } from "./sdk.js";
import { normalizeFileKey } from "./pathKey.js";
import { parseFileQueueTtlMs } from "./config.js";

// Fix #4: File queue TTL (default: 30000ms = 30 seconds)
// Fix #15 (Codex Critical Review): Enforce minimum 1000ms to prevent memory leak when set to 0
// Fix #19 (Codex Critical Review Round 3): Validate TTL to prevent NaN
// Extracted to config.ts for testability
const FILE_QUEUE_TTL_MS = parseFileQueueTtlMs();

import type {
  RpcRequest,
  RpcResponse,
  RpcNotification,
  UpdateContentParams,
  GetOutlineResult,
  GetLibraryDependenciesResult,
  DartAnalysisPayload,
  ServerConnectedParams,
  ServerErrorParams,
} from "./types.js";

export interface DartAnalysisClientOptions {
  workspaceRoots: string[];
  logPath?: string;
}

export interface DisposeOptions {
  timeoutMs?: number; // Fix #3: Graceful shutdown timeout (default: 5000ms)
  skipShutdown?: boolean; // Fix #3: Skip server.shutdown RPC for immediate kill
}

/**
 * DAPProtocolError: Analysis Server プロトコルエラー
 */
export class DAPProtocolError extends Error {
  constructor(
    message: string,
    public code?: number,
    public data?: unknown
  ) {
    super(message);
    this.name = "DAPProtocolError";
  }
}

/**
 * DartAnalysisClient: Dart Analysis Server プロセス管理と JSON-RPC 通信
 */
export class DartAnalysisClient {
  private process: ChildProcess | null = null;
  private readline: Interface | null = null;
  private requestId = 0;
  private pendingRequests = new Map<
    string,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  private serverVersion: string | null = null;
  private initialized = false;
  private initializePromise: Promise<void> | null = null;
  // Fix #2: ファイル単位のリクエストキューでオーバーレイ競合を防ぐ
  // Fix #4: TTL cleanup to prevent memory leak
  private fileQueues = new Map<
    string,
    {
      queue: PQueue;
      lastUsed: number;
      cleanupTimer?: NodeJS.Timeout;
    }
  >();

  constructor(private options: DartAnalysisClientOptions) {}

  /**
   * Analysis Server プロセスを起動し初期化する
   *
   * 並行呼び出しを安全に処理: 既に初期化中の場合は同じPromiseを返す
   *
   * @throws MissingToolError - Dart SDK が見つからない場合
   * @throws DAPProtocolError - サーバー起動失敗時
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // 既に初期化中なら、そのPromiseを返す（並行初期化の競合を防ぐ）
    if (this.initializePromise) {
      return this.initializePromise;
    }

    this.initializePromise = (async () => {
      try {
        // Dart SDK 検出
        const sdkInfo = detectDartSdk();
        console.log(
          `[DartAnalysisClient] Detected Dart SDK ${sdkInfo.version} at ${sdkInfo.sdkPath}`
        );

        // Analysis Server プロセス起動
        // Windows対応: dartExecutable の絶対パスを使用
        const args = [
          "--disable-dart-dev",
          sdkInfo.analysisServerPath,
          "--protocol=instrumentation",
        ];

        if (this.options.logPath) {
          args.push(`--instrumentation-log-file=${this.options.logPath}`);
        }

        this.process = spawn(sdkInfo.dartExecutable, args, {
          stdio: ["pipe", "pipe", "pipe"],
        });

        if (!this.process.stdout || !this.process.stdin) {
          throw new DAPProtocolError("Failed to spawn Analysis Server: stdio not available");
        }

        // readline で行単位で JSON を読み取る
        this.readline = createInterface({
          input: this.process.stdout,
          crlfDelay: Infinity,
        });

        this.readline.on("line", (line) => {
          this.handleMessage(line);
        });

        this.process.stderr?.on("data", (data) => {
          console.error(`[DartAnalysisClient] stderr: ${data}`);
        });

        this.process.on("error", (error) => {
          console.error(`[DartAnalysisClient] process error:`, error);
          this.rejectAllPending(
            new DAPProtocolError(`Analysis Server process error: ${error.message}`)
          );
          // Fix #1: Reset state to allow reinitialization after crash
          this.cleanupState();
        });

        this.process.on("exit", (code, signal) => {
          console.log(`[DartAnalysisClient] process exited: code=${code}, signal=${signal}`);
          this.rejectAllPending(
            new DAPProtocolError(`Analysis Server exited unexpectedly: code=${code}`)
          );
          // Fix #1: Reset state to allow reinitialization after crash
          this.cleanupState();
        });

        // server.setSubscriptions で接続通知を受け取る
        await this.sendRequest("server.setSubscriptions", {
          subscriptions: ["STATUS"],
        });

        // analysis.setAnalysisRoots でワークスペースルートを設定
        await this.sendRequest("analysis.setAnalysisRoots", {
          included: this.options.workspaceRoots,
          excluded: [],
        });

        this.initialized = true;
        console.log(`[DartAnalysisClient] Initialized with roots:`, this.options.workspaceRoots);
      } finally {
        // 初期化完了（成功/失敗問わず）後はPromiseをリセット
        this.initializePromise = null;
      }
    })();

    await this.initializePromise;
  }

  /**
   * ファイルを解析してシンボル情報を取得（MVP版）
   *
   * Fix #2: 同一ファイルの並列解析でオーバーレイ競合を防ぐため、
   * ファイル単位でリクエストをシリアライズ
   *
   * @param filePath - 解析対象ファイルの絶対パス
   * @param content - ファイル内容
   * @returns DartAnalysisPayload
   */
  async analyzeFile(filePath: string, content: string): Promise<DartAnalysisPayload> {
    // Fix #5: Normalize file path for Windows case-insensitivity
    const fileKey = normalizeFileKey(filePath);

    // Fix #4: ファイルパス単位でキューを取得または作成（TTL cleanup付き）
    let entry = this.fileQueues.get(fileKey);
    if (!entry) {
      entry = {
        queue: new PQueue({ concurrency: 1 }),
        lastUsed: Date.now(),
      };
      this.fileQueues.set(fileKey, entry);
    }

    // Fix #4: 既存のクリーンアップタイマーをキャンセル（再利用時）
    if (entry.cleanupTimer) {
      clearTimeout(entry.cleanupTimer);
      delete entry.cleanupTimer;
    }

    // Fix #4: 使用時刻を更新
    entry.lastUsed = Date.now();

    // キューに追加して順次実行を保証
    return entry.queue
      .add(async () => {
        if (!this.initialized) {
          await this.initialize();
        }

        // analysis.updateContent でファイル内容を送信
        const updateParams: UpdateContentParams = {
          files: {
            [filePath]: {
              type: "add",
              content,
            },
          },
        };

        await this.sendRequest("analysis.updateContent", updateParams);

        try {
          // analysis.getOutline でシンボル階層を取得
          const outlineResult = await this.sendRequest<GetOutlineResult>("analysis.getOutline", {
            file: filePath,
          });

          return {
            outline: outlineResult.outline,
          };
        } finally {
          // メモリリーク防止: オーバーレイを必ず削除
          // キューによって直列化されているため、他のリクエストのオーバーレイを削除する心配がない
          await this.sendRequest("analysis.updateContent", {
            files: {
              [filePath]: {
                type: "remove",
              },
            },
          }).catch((error) => {
            console.warn(`[analyzeFile] Failed to remove overlay for ${filePath}:`, error);
          });
        }
      })
      .finally(() => {
        // Fix #4: TTL cleanup timer を設定（キュー実行完了後）
        const currentEntry = this.fileQueues.get(fileKey);
        if (currentEntry && FILE_QUEUE_TTL_MS > 0) {
          currentEntry.cleanupTimer = setTimeout(() => {
            // アイドル状態（size=0, pending=0）の場合のみ削除
            if (currentEntry.queue.size === 0 && currentEntry.queue.pending === 0) {
              this.fileQueues.delete(fileKey);
            }
          }, FILE_QUEUE_TTL_MS);

          // Fix #4: unref() to prevent blocking Node.js exit
          currentEntry.cleanupTimer.unref();
        }
      });
  }

  /**
   * ライブラリの依存関係を取得（Phase 3）
   *
   * @param _filePath - 解析対象ファイルの絶対パス (現在未使用: workspace全体の依存関係を返すため)
   * @returns GetLibraryDependenciesResult
   */
  async getLibraryDependencies(_filePath: string): Promise<GetLibraryDependenciesResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    const result = await this.sendRequest<GetLibraryDependenciesResult>(
      "analysis.getLibraryDependencies",
      {}
    );

    return result;
  }

  /**
   * Analysis Server プロセスを終了
   *
   * Fix #3: dispose に options パラメータを追加して柔軟な終了処理を実現
   *
   * @param options - 終了オプション
   * @param options.timeoutMs - Graceful shutdown timeout (デフォルト: 5000ms)
   * @param options.skipShutdown - server.shutdown RPC をスキップして即時強制終了
   */
  async dispose(options?: DisposeOptions): Promise<void> {
    if (!this.process) {
      return;
    }

    const timeoutMs = options?.timeoutMs ?? 5000;
    const skipShutdown = options?.skipShutdown ?? false;

    // Fix #27 (Codex Critical Review Round 5): Store timer handle for cleanup
    let killTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      this.readline?.close();
      this.process = null;
      this.readline = null;
      this.initialized = false;
    };

    try {
      if (!skipShutdown && this.initialized) {
        // Fix #3: server.shutdown を短いタイムアウトで実行
        await this.sendRequest("server.shutdown", {}, timeoutMs).catch((error) => {
          console.warn(`[DartAnalysisClient] shutdown request failed:`, error);
        });

        // プロセス終了を待つ
        await new Promise<void>((resolve) => {
          if (!this.process) {
            resolve();
            return;
          }
          this.process.once("exit", () => resolve());
          // Fix #14 (Codex Critical Review): Use forceKill() on timeout (includes Windows taskkill)
          // Fix #27 (Codex Critical Review Round 5): Store timer handle and use unref() to prevent event loop hanging
          killTimer = setTimeout(() => {
            this.forceKill();
            resolve();
          }, timeoutMs);
          // CRITICAL: unref() prevents event loop from staying alive waiting for this timer
          killTimer.unref();
        });
      } else {
        // Fix #3: skipShutdown または未初期化の場合は即時強制終了
        this.forceKill();
      }
    } catch (error) {
      console.error(`[DartAnalysisClient] dispose error:`, error);
      this.forceKill(); // エラー時は強制終了
    } finally {
      cleanup();
    }
  }

  /**
   * Fix #1 & #3: プロセスを同期的に強制終了
   *
   * exit フォールバックや緊急時に使用
   * Windows対応: SIGKILLは存在しないため、プラットフォーム別に処理
   */
  forceKill(): void {
    if (this.process) {
      try {
        this.process.kill("SIGTERM");
        // SIGKILL fallback after 100ms
        setTimeout(() => {
          if (this.process && !this.process.killed) {
            try {
              if (process.platform === "win32") {
                // Windows: Use taskkill for forceful termination
                // Fix #7 (Critical Review): More aggressive than default kill()
                // Fix #11 (Codex Critical Review): Use ESM import instead of require()
                execSync(`taskkill /PID ${this.process.pid} /F /T`, { stdio: "ignore" });
              } else {
                // Unix: Use SIGKILL for force termination
                this.process.kill("SIGKILL");
              }
            } catch {
              // Force kill may fail if process is already gone
            }
          }
        }, 100);
      } catch {
        // kill 失敗は無視（既に終了している可能性）
      }
    }
  }

  /**
   * JSON-RPC リクエスト送信
   *
   * Fix #3: タイムアウト時間を可変にして dispose や初期化での短縮タイムアウトを実現
   *
   * @param method - RPC メソッド名
   * @param params - RPC パラメータ
   * @param timeoutMs - タイムアウト時間（デフォルト: 30000ms）
   */
  private async sendRequest<TResult = unknown>(
    method: string,
    params: unknown,
    timeoutMs: number = 30000
  ): Promise<TResult> {
    if (!this.process?.stdin) {
      throw new DAPProtocolError("Analysis Server process not running");
    }

    const id = `${++this.requestId}`;
    const request: RpcRequest = { id, method, params };

    return new Promise<TResult>((resolve, reject) => {
      // Fix #3: タイムアウト設定（可変）
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new DAPProtocolError(`Request timeout: ${method}`, -32000, { method, params }));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timeout,
      });

      // JSON-RPC メッセージ送信（改行区切り）
      const message = JSON.stringify(request) + "\n";
      this.process!.stdin!.write(message);
    });
  }

  /**
   * サーバーからのメッセージを処理
   */
  private handleMessage(line: string): void {
    if (!line.trim()) {
      return;
    }

    try {
      const message = JSON.parse(line);

      // レスポンス処理
      if ("id" in message && message.id) {
        this.handleResponse(message as RpcResponse);
      }
      // 通知処理
      else if ("event" in message) {
        this.handleNotification(message as RpcNotification);
      }
    } catch (error) {
      console.error(`[DartAnalysisClient] Failed to parse message:`, line, error);
    }
  }

  /**
   * レスポンス処理
   */
  private handleResponse(response: RpcResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      console.warn(`[DartAnalysisClient] Received response for unknown request: ${response.id}`);
      return;
    }

    this.pendingRequests.delete(response.id);
    clearTimeout(pending.timeout);

    if (response.error) {
      pending.reject(
        new DAPProtocolError(response.error.message, response.error.code, response.error.data)
      );
    } else {
      pending.resolve(response.result);
    }
  }

  /**
   * 通知処理
   */
  private handleNotification(notification: RpcNotification): void {
    switch (notification.event) {
      case "server.connected": {
        const params = notification.params as ServerConnectedParams;
        this.serverVersion = params.version;
        console.log(
          `[DartAnalysisClient] Server connected: version=${params.version}, pid=${params.pid}`
        );
        break;
      }
      case "server.error": {
        const params = notification.params as ServerErrorParams;
        console.error(
          `[DartAnalysisClient] Server error (fatal=${params.isFatal}):`,
          params.message
        );
        if (params.isFatal) {
          this.rejectAllPending(new DAPProtocolError(`Fatal server error: ${params.message}`));
          // Fix #21 (Codex Critical Review Round 3): Auto-recovery after fatal server.error
          this.cleanupState(); // Reset initialized flag to allow reinitialization
        }
        break;
      }
      case "analysis.errors":
        // MVP では無視（後のフェーズで処理）
        break;
      default:
        // その他の通知は無視
        break;
    }
  }

  /**
   * 全ての pending リクエストを reject
   */
  private rejectAllPending(error: Error): void {
    for (const [_id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  /**
   * プロセス状態をクリーンアップ（Fix #1: crash recovery用）
   *
   * dispose() とは異なり、server.shutdown を送らずに状態のみリセット。
   * プロセスクラッシュ後の再初期化を可能にする。
   */
  private cleanupState(): void {
    this.readline?.close();
    this.readline = null;
    this.process = null;
    this.initialized = false;
    this.initializePromise = null;
  }
}
