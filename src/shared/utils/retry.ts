export interface RetryOptions {
  maxAttempts: number;
  delayMs: number;
  jitterMs?: number;
  /** 最大遅延時間（ミリ秒）。指数バックオフの上限を設定 */
  maxDelayMs?: number;
  /** バックオフ倍率。指定時は指数バックオフを使用（デフォルト: 1 = 線形） */
  backoffMultiplier?: number;
  isRetriable?: (error: unknown) => boolean;
}

/**
 * 指数バックオフ付きの遅延時間を計算
 *
 * @param baseDelayMs - 基本遅延時間
 * @param attempt - 現在の試行回数（1から始まる）
 * @param backoffMultiplier - バックオフ倍率（デフォルト: 1 = 線形）
 * @param maxDelayMs - 最大遅延時間（上限）
 * @param jitterMs - ジッター（ランダムな追加遅延）
 * @returns 計算された遅延時間（ミリ秒）
 */
export function calculateBackoffDelay(
  baseDelayMs: number,
  attempt: number,
  backoffMultiplier: number = 1,
  maxDelayMs?: number,
  jitterMs: number = 0
): number {
  // 指数バックオフ: baseDelay * (multiplier ^ (attempt - 1))
  // attempt=1 では baseDelay、attempt=2 では baseDelay * multiplier、...
  const exponentialDelay = baseDelayMs * Math.pow(backoffMultiplier, attempt - 1);

  // 最大遅延を適用
  const cappedDelay =
    maxDelayMs !== undefined ? Math.min(exponentialDelay, maxDelayMs) : exponentialDelay;

  // ジッターを追加
  const jitter = jitterMs > 0 ? Math.random() * jitterMs : 0;

  return cappedDelay + jitter;
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  {
    maxAttempts,
    delayMs,
    jitterMs = 0,
    maxDelayMs,
    backoffMultiplier = 1,
    isRetriable,
  }: RetryOptions
): Promise<T> {
  if (maxAttempts < 1) {
    throw new Error("maxAttempts must be >= 1");
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const shouldRetry = attempt < maxAttempts && (isRetriable ? isRetriable(error) : true);
      if (!shouldRetry) {
        throw error;
      }
      const delay = calculateBackoffDelay(
        delayMs,
        attempt,
        backoffMultiplier,
        maxDelayMs,
        jitterMs
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error("Retry attempts exhausted");
}
