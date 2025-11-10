/**
 * Dart Analysis Server を使った Dart ファイル解析のエントリポイント
 */

import path from "node:path";
import type { SymbolRecord, SnippetRecord, DependencyRecord } from "../codeintel.js";
import { DartAnalysisClient } from "./client.js";
import { outlineToSymbols } from "./transform.js";
import { isDartSdkAvailable } from "./sdk.js";
// import { extractDependencies } from "./dependencies.js"; // Phase 4で使用予定
import { normalizeWorkspaceKey } from "./pathKey.js";
import { createCapacityLimiter, type CapacityLimiter } from "./poolGate.js";
import { parseMaxClients, parseClientWaitMs, parseIdleTtlMs } from "./config.js";

// ワークスペース毎のクライアント管理（参照カウント + アイドルTTL方式）
interface ClientEntry {
  client: DartAnalysisClient;
  refs: number;
  initPromise: Promise<DartAnalysisClient> | null;
  idleTimer: NodeJS.Timeout | null; // Fix #2: アイドルタイマー
  lastUsed: number; // Fix #2: 最終使用時刻
}

const clients = new Map<string, ClientEntry>();

// Fix #2: アイドルTTL (デフォルト: 60秒、環境変数で調整可能)
// Fix #6: ?? 演算子を使用して IDLE_TTL_MS=0 でTTLを無効化可能にする
// Fix #20 (Codex Critical Review Round 3): Extracted to config.ts for testability
const IDLE_TTL_MS = parseIdleTtlMs();

// Fix #4: 最大クライアント数制限（デフォルト: 8、環境変数で調整可能）
// 大規模モノレポでメモリ枯渇を防ぐため、LRU evictionを実施
// Fix #18 (Codex Critical Review Round 3): Validate MAX_CLIENTS to prevent NaN
// Extracted to config.ts for testability
const MAX_CLIENTS = parseMaxClients();

// Fix #1: Client wait timeout (default: 10000ms = 10 seconds)
// Extracted to config.ts for testability
const DART_ANALYSIS_CLIENT_WAIT_MS = parseClientWaitMs();

// Fix #1 & #2: Pool capacity limiter to enforce MAX_CLIENTS
const poolLimiter: CapacityLimiter = createCapacityLimiter(MAX_CLIENTS);

// Fix #24 (Codex Critical Review Round 4): Shutdown flag to prevent client respawn during cleanup
let isShuttingDown = false;

/**
 * Dart Analysis Client の取得（参照カウント方式）
 *
 * 進行中のリクエストがあるクライアントは dispose されず、
 * 全ての参照が解放されるまで維持される
 *
 * @param workspaceRoot - ワークスペースルート（リポジトリパス）
 * @returns DartAnalysisClient インスタンス
 */
async function acquireClient(workspaceRoot: string): Promise<DartAnalysisClient> {
  // Fix #24 (Codex Critical Review Round 4): Check shutdown flag
  if (isShuttingDown) {
    throw new Error(
      `[acquireClient] System is shutting down. Cannot acquire new clients for ${workspaceRoot}.`
    );
  }

  // Fix #3: Normalize workspace path for Windows case-insensitivity
  const workspaceKey = normalizeWorkspaceKey(workspaceRoot);
  let entry = clients.get(workspaceKey);

  // Fix #9 (Codex Critical Review): Track whether this call acquired a permit
  // to prevent double release when concurrent requests wait on existing initPromise
  let didAcquirePermit = false;

  if (!entry) {
    // Fix #10 (Codex Critical Review): Try LRU eviction BEFORE acquire()
    // This ensures eviction actually runs when pool is full, instead of timing out
    if (clients.size >= MAX_CLIENTS) {
      // Find least recently used idle client
      let lruWorkspace: string | null = null;
      let oldestTime = Infinity;

      for (const [ws, ent] of clients.entries()) {
        if (ent.refs === 0 && ent.lastUsed < oldestTime) {
          oldestTime = ent.lastUsed;
          lruWorkspace = ws;
        }
      }

      // Evict LRU client synchronously to free up permit slot
      if (lruWorkspace) {
        const lruEntry = clients.get(lruWorkspace)!;
        if (lruEntry.idleTimer) {
          clearTimeout(lruEntry.idleTimer);
        }
        // Fix #28 (Codex Critical Review Round 5): Check delete() return value to prevent double eviction
        const wasDeleted = clients.delete(lruWorkspace);

        if (wasDeleted) {
          // Only this thread successfully deleted the entry
          console.log(
            `[acquireClient] Evicting LRU client for ${lruWorkspace} (pool size: ${MAX_CLIENTS})`
          );

          // Dispose synchronously and release permit immediately
          await lruEntry.client.dispose({ timeoutMs: 2000 }).catch((error) => {
            console.error(
              `[acquireClient] Failed to dispose LRU client for ${lruWorkspace}:`,
              error
            );
          });
          poolLimiter.release(); // Free up slot for new client
        } else {
          // Another thread already evicted this client - this is safe, just retry
        }
      }
    }

    // Fix #1 & #2: Acquire pool permit before creating new client
    // This enforces MAX_CLIENTS limit and provides waiting queue with timeout
    await poolLimiter.acquire({ timeoutMs: DART_ANALYSIS_CLIENT_WAIT_MS });
    didAcquirePermit = true; // Mark that we acquired a permit

    // Re-check after await (another request might have created the same client)
    entry = clients.get(workspaceKey);
    if (entry) {
      // Client was created by concurrent request - release permit and use existing
      poolLimiter.release();
      didAcquirePermit = false; // We released it
    } else {
      // Fix #23 (Codex Critical Review Round 4): Retry LRU eviction if pool is still full
      // Instead of immediately throwing, try to evict idle clients and retry
      while (clients.size >= MAX_CLIENTS) {
        // Find least recently used idle client
        let lruWorkspace: string | null = null;
        let oldestTime = Infinity;

        for (const [ws, ent] of clients.entries()) {
          if (ent.refs === 0 && ent.lastUsed < oldestTime) {
            oldestTime = ent.lastUsed;
            lruWorkspace = ws;
          }
        }

        if (lruWorkspace) {
          // Evict LRU client to make space
          const lruEntry = clients.get(lruWorkspace)!;
          if (lruEntry.idleTimer) {
            clearTimeout(lruEntry.idleTimer);
          }
          // Fix #28 (Codex Critical Review Round 5): Check delete() return value to prevent double eviction
          const wasDeleted = clients.delete(lruWorkspace);

          if (wasDeleted) {
            // Only this thread successfully deleted the entry
            console.log(
              `[acquireClient] Pool full after acquire, evicting LRU client for ${lruWorkspace}`
            );

            await lruEntry.client.dispose({ timeoutMs: 2000 }).catch((error) => {
              console.error(
                `[acquireClient] Failed to dispose LRU client for ${lruWorkspace}:`,
                error
              );
            });
            // Note: We don't release permit here because we already acquired one
            break; // Exit retry loop - we made space
          } else {
            // Another thread already evicted this client - retry with updated state
            continue;
          }
        } else {
          // No idle clients available - all clients are active
          poolLimiter.release();
          didAcquirePermit = false;
          throw new Error(
            `[acquireClient] Dart Analysis Server pool is full with ${MAX_CLIENTS} active clients. ` +
              `Cannot create new client for workspace ${workspaceRoot}. ` +
              `Consider increasing DART_ANALYSIS_MAX_CLIENTS or reducing concurrent indexing.`
          );
        }
      }

      // Create new client only if we still don't have one
      const client = new DartAnalysisClient({
        workspaceRoots: [workspaceRoot],
      });

      entry = {
        client,
        refs: 1, // Fix #12 (Codex Critical Review): Reserve immediately to prevent LRU race
        initPromise: client.initialize().then(() => client),
        idleTimer: null, // Fix #2: アイドルタイマー初期化
        lastUsed: Date.now(), // Fix #2: 最終使用時刻初期化
      };

      clients.set(workspaceKey, entry);
    }
  }

  // Fix #2: アイドルタイマーをクリア（再利用時）
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  // Fix #3: 初期化を待つ（失敗時はエントリを削除してリトライ可能にする）
  // Fix #17 (Codex Critical Review Round 3): Track concurrent waiters for refs accounting
  const waitingOnInit = entry.initPromise !== null && !didAcquirePermit;
  if (waitingOnInit) {
    // Concurrent request waiting on initialization - increment refs
    entry.refs += 1;
  }

  if (entry.initPromise) {
    try {
      await entry.initPromise;
      entry.initPromise = null;
    } catch (error) {
      // 初期化失敗: エントリを削除して次回リトライ可能にする
      clients.delete(workspaceKey);
      // Fix #3: skipShutdown で即時強制終了（二重タイムアウト回避）
      await entry.client.dispose({ skipShutdown: true }).catch(() => {});

      // Fix #17: Roll back refs increment for waiting requests
      if (waitingOnInit) {
        // Entry was deleted, no need to decrement
      }

      // Fix #9 (Codex Critical Review): Only release if WE acquired the permit
      // Concurrent requests waiting on initPromise didn't acquire permits
      if (didAcquirePermit) {
        poolLimiter.release();
      }
      throw error;
    }
  } else {
    // Fix #12: Entry exists and is initialized - increment refs for this acquisition
    entry.refs += 1;
  }

  entry.lastUsed = Date.now(); // Fix #2: 最終使用時刻更新

  return entry.client;
}

/**
 * Dart Analysis Client の解放（参照カウント + アイドルTTL方式）
 *
 * Fix #2: 参照カウントが 0 になったら即座に dispose せず、アイドルTTL後に dispose
 * これによりファイル毎のサーバー再起動を回避し、性能を大幅に改善
 *
 * @param workspaceRoot - ワークスペースルート（リポジトリパス）
 */
function releaseClient(workspaceRoot: string): void {
  // Fix #3: Normalize workspace path for Windows case-insensitivity
  const workspaceKey = normalizeWorkspaceKey(workspaceRoot);
  const entry = clients.get(workspaceKey);
  if (!entry) {
    console.warn(`[releaseClient] No entry found for ${workspaceRoot}`);
    return;
  }

  entry.refs -= 1;

  // Fix #14 (Codex Critical Review): Defensive check for refs underflow
  if (entry.refs < 0) {
    console.error(
      `[releaseClient] refs underflow for ${workspaceRoot}: ${entry.refs}. ` +
        `This indicates a bug in acquire/release pairing.`
    );
    entry.refs = 0;
  }

  // Fix #2: refs が 0 になったらアイドルタイマーを起動（即座に dispose しない）
  // Fix #20 (Codex Critical Review Round 3): IDLE_TTL_MS=0 means "disable TTL" (unlimited hold)
  // Fix #22 (Codex Critical Review Round 4): Check queue depth - if waiters exist, skip TTL and release immediately
  if (entry.refs === 0) {
    const stats = poolLimiter.stats();

    // If there are waiters in the queue, skip TTL and release permit immediately
    if (stats.queueDepth > 0) {
      console.log(
        `[releaseClient] Pool has ${stats.queueDepth} waiters, disposing idle client for ${workspaceRoot} immediately`
      );
      clients.delete(workspaceKey);
      entry.client
        .dispose({ timeoutMs: 2000 })
        .catch((error) => {
          console.error(`[releaseClient] Failed to dispose client for ${workspaceRoot}:`, error);
        })
        .finally(() => {
          poolLimiter.release();
        });
      return;
    }

    if (IDLE_TTL_MS === 0) {
      // TTL disabled: keep client alive indefinitely (LRU will handle eviction if pool full)
      return;
    }

    const delay = Math.max(1, IDLE_TTL_MS);
    entry.idleTimer = setTimeout(() => {
      // タイムアウト時に再度 refs をチェック（タイマー中に再取得された可能性）
      if (entry.refs === 0) {
        console.log(`[releaseClient] Disposing idle client for ${workspaceRoot}`);
        clients.delete(workspaceKey);
        entry.client
          .dispose({ timeoutMs: 2000 })
          .catch((error) => {
            console.error(`[releaseClient] Failed to dispose client for ${workspaceRoot}:`, error);
          })
          .finally(() => {
            // Fix #1: Release pool permit after disposal
            poolLimiter.release();
          });
      }
    }, delay);

    // Fix #1: Node.jsがタイマー待ちでハングしないように unref() を呼ぶ
    // これによりCLIプロセスがアイドルタイマーを待たずに終了できる
    entry.idleTimer.unref();
  }
}

/**
 * Dart ファイルを解析してシンボル・スニペット・依存関係を抽出
 *
 * Fix #5: status フィールドを追加してエラーをリトライ可能にする
 *
 * @param filePath - ファイルパス（相対パスの場合は workspaceRoot からの相対パス）
 * @param content - ファイル内容
 * @param workspaceRoot - ワークスペースルート（絶対パス）
 * @returns { symbols, snippets, dependencies, status, error? }
 */
export async function analyzeDartSource(
  filePath: string,
  content: string,
  workspaceRoot: string
): Promise<{
  symbols: SymbolRecord[];
  snippets: SnippetRecord[];
  dependencies: DependencyRecord[];
  status: "success" | "error" | "sdk_unavailable";
  error?: string;
}> {
  // Dart SDK が利用できない場合は空の結果を返す
  if (!isDartSdkAvailable()) {
    console.warn(`[analyzeDartSource] Dart SDK not available, skipping analysis for ${filePath}`);
    return { symbols: [], snippets: [], dependencies: [], status: "sdk_unavailable" };
  }

  // Analysis Server は絶対パスを要求するため、相対パスの場合は絶対パスに変換
  const absoluteFilePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(workspaceRoot, filePath);

  // Fix #26 (Codex Critical Review Round 4): Wrap acquireClient in try/catch to prevent index rollback
  // Pool errors and initialization failures should not bubble up and rollback entire repository index
  let client: DartAnalysisClient | null = null;

  try {
    // クライアントを取得（参照カウント増加）
    client = await acquireClient(workspaceRoot);

    const payload = await client.analyzeFile(absoluteFilePath, content);

    const { symbols, snippets } = outlineToSymbols(payload.outline, content);

    // Phase 3 (disabled): 依存関係を取得
    // TODO: analysis.getLibraryDependencies は workspace 全体の依存関係を返すため、
    // ファイル単位の依存関係を正しく取得できない。
    // Phase 4 で analysis.getOutline から import/export ディレクティブを抽出するか、
    // analysis.getNavigation を使用した実装に切り替える必要がある。
    // 現在は誤ったデータを返さないために空配列を返す。
    const dependencies: DependencyRecord[] = [];

    return { symbols, snippets, dependencies, status: "success" };
  } catch (error) {
    console.error(`[analyzeDartSource] Failed to analyze ${absoluteFilePath}:`, error);
    // Fix #5: エラー時はstatusとerrorフィールドを返して呼び出し元がリトライ可能にする
    // Fix #26: This now includes pool acquisition errors and initialization failures
    return {
      symbols: [],
      snippets: [],
      dependencies: [],
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // Fix #26: Only release if client was successfully acquired
    if (client) {
      releaseClient(workspaceRoot);
    }
  }
}

// Fix #13 (Codex Critical Review): Re-entrancy guard for cleanup()
let cleanupInProgress = false;

/**
 * 全クライアントのクリーンアップ
 *
 * プロセス終了時やインデクサー終了時に呼ぶ
 * 全てのワークスペースのクライアントを強制的に dispose する
 */
export async function cleanup(): Promise<void> {
  // Fix #13: Prevent concurrent/double cleanup
  if (cleanupInProgress) {
    console.warn("[cleanup] Already in progress, skipping duplicate call");
    return;
  }
  cleanupInProgress = true;

  // Fix #24 (Codex Critical Review Round 4): Set shutdown flag to prevent new client acquisitions
  isShuttingDown = true;

  try {
    const disposePromises: Promise<void>[] = [];
    const entriesToCleanup = Array.from(clients.entries()); // Snapshot

    // Fix #13: Delete all entries immediately to prevent concurrent acquireClient() access
    clients.clear();

    // Fix #30 (Codex Critical Review Round 5): Check pool state before releasing permits
    // to prevent available permits from exceeding maxCapacity
    const poolStats = poolLimiter.stats();
    const permitsToRelease = Math.min(
      entriesToCleanup.length,
      poolStats.maxCapacity - poolStats.available
    );

    if (permitsToRelease < entriesToCleanup.length) {
      console.warn(
        `[cleanup] Pool has ${poolStats.available}/${poolStats.maxCapacity} available permits. ` +
          `Only releasing ${permitsToRelease} of ${entriesToCleanup.length} to prevent overflow.`
      );
    }

    let releasedCount = 0;

    for (const [workspaceRoot, entry] of entriesToCleanup) {
      // Fix #2: アイドルタイマーをクリア
      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
      }

      // Fix #8 (Codex Critical Review): cleanup() で各クライアント dispose 後に permit を release
      // これにより cleanup() 後も poolLimiter が正常に機能し、再利用可能になる
      const disposeAndRelease = async () => {
        try {
          if (entry.initPromise) {
            const client = await entry.initPromise;
            await client.dispose({ timeoutMs: 2000 });
          } else {
            await entry.client.dispose({ timeoutMs: 2000 });
          }
        } catch (error) {
          console.error(`[cleanup] Failed to dispose client for ${workspaceRoot}:`, error);
        } finally {
          // Fix #30: Only release if we haven't exceeded the safe count
          if (releasedCount < permitsToRelease) {
            poolLimiter.release();
            releasedCount++;
          }
        }
      };

      disposePromises.push(disposeAndRelease());
    }

    await Promise.allSettled(disposePromises);
  } finally {
    cleanupInProgress = false;
    // Fix #24: Reset shutdown flag after cleanup completes (allows re-initialization in tests)
    isShuttingDown = false;
  }
}

/**
 * Fix #1: プロセスライフサイクルフックの登録
 *
 * beforeExit/シグナルハンドラで非同期 cleanup を実行し、
 * exit フォールバックでは同期的な強制終了のみ行う
 *
 * Fix #29 (Codex Critical Review Round 5): Guard against multiple registrations
 */
let lifecycleHooksRegistered = false;

function registerDartLifecycleHooks(): void {
  // Fix #29: Prevent duplicate registration in test environments with vi.resetModules()
  if (lifecycleHooksRegistered) {
    return;
  }
  lifecycleHooksRegistered = true;

  let cleanupInProgress = false;

  const gracefulShutdown = async (signal: string) => {
    if (cleanupInProgress) {
      return; // 二重実行防止
    }
    cleanupInProgress = true;

    console.log(`[DartLifecycle] Received ${signal}, cleaning up Analysis Server processes...`);
    try {
      await cleanup();
      console.log(`[DartLifecycle] Cleanup completed successfully`);
    } catch (error) {
      console.error(`[DartLifecycle] Cleanup failed:`, error);
    } finally {
      // Fix #29: Set exit code instead of calling process.exit() from library code
      // Let the parent application handle exit
      if (signal !== "beforeExit") {
        process.exitCode = signal === "SIGTERM" ? 0 : 1;
      }
    }
  };

  // Fix #1: beforeExit で非同期 cleanup
  process.once("beforeExit", () => gracefulShutdown("beforeExit"));

  // Fix #1: シグナルハンドラ
  process.once("SIGINT", () => gracefulShutdown("SIGINT"));
  process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.once("SIGQUIT", () => gracefulShutdown("SIGQUIT"));

  // Fix #1: 未捕捉例外時のクリーンアップ
  process.once("uncaughtException", async (error) => {
    console.error(`[DartLifecycle] Uncaught exception:`, error);
    await gracefulShutdown("uncaughtException");
    process.exit(1);
  });

  // Fix #1: exit フォールバック - 同期的な強制終了のみ
  process.once("exit", () => {
    // 非同期処理は実行されないため、同期的にプロセスを強制終了
    for (const [, entry] of clients.entries()) {
      try {
        entry.client.forceKill();
      } catch {
        // exit時なのでエラーは無視
      }
    }
    clients.clear();
  });
}

// Fix #1: ライフサイクルフックを登録
registerDartLifecycleHooks();
