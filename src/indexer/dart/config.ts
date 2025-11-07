/**
 * Dart Analysis Server 設定のパース・バリデーション
 *
 * Fix #17-21 (Codex Critical Review Round 3):
 * 環境変数の異常値（NaN、空文字、負数）からデフォルト値へのフォールバックを一元管理
 */

/**
 * MAX_CLIENTS環境変数をパースして検証
 *
 * @returns 検証済みの MAX_CLIENTS 値（デフォルト: 8）
 */
export function parseMaxClients(): number {
  const parsed = Number.parseInt(process.env.DART_ANALYSIS_MAX_CLIENTS ?? "8", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8;
}

/**
 * CLIENT_WAIT_MS環境変数をパースして検証
 *
 * @returns 検証済みの CLIENT_WAIT_MS 値（デフォルト: 10000）
 */
export function parseClientWaitMs(): number {
  const parsed = Number.parseInt(process.env.DART_ANALYSIS_CLIENT_WAIT_MS ?? "10000", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10000;
}

/**
 * IDLE_TTL_MS環境変数をパースして検証
 *
 * 0 = TTL無効化（無期限保持、LRUで管理）
 * 負数 = デフォルト値にフォールバック
 *
 * @returns 検証済みの IDLE_TTL_MS 値（デフォルト: 60000）
 */
export function parseIdleTtlMs(): number {
  const envValue = process.env.DART_ANALYSIS_IDLE_MS ?? "60000";

  // Empty string check first (Number("") returns 0, which is ambiguous)
  if (envValue.trim() === "") {
    return 60000;
  }

  const parsed = Number(envValue);

  // NaN check (handles non-numeric values)
  if (!Number.isFinite(parsed)) {
    return 60000;
  }

  // Explicit 0 is valid (TTL disabled)
  if (parsed === 0) {
    return 0;
  }

  // Negative values fallback to default
  return parsed > 0 ? parsed : 60000;
}

/**
 * FILE_QUEUE_TTL_MS環境変数をパースして検証
 *
 * 最小値: 1000ms（メモリリーク防止）
 *
 * @returns 検証済みの FILE_QUEUE_TTL_MS 値（デフォルト: 30000、最小: 1000）
 */
export function parseFileQueueTtlMs(): number {
  const parsed = Number.parseInt(process.env.DART_FILE_QUEUE_TTL_MS ?? "30000", 10);
  return Number.isFinite(parsed) ? Math.max(1000, parsed) : 30000;
}
