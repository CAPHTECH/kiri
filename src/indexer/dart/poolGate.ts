/**
 * Pool capacity limiting semaphore for DartAnalysisClient pool
 *
 * Fix #1: Enforce MAX_CLIENTS limit with FIFO waiting queue
 */

/**
 * DartPoolBusyError: Thrown when waiting for pool capacity times out
 */
export class DartPoolBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DartPoolBusyError";
  }
}

interface WaitingRequest {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * Capacity limiter with FIFO queue
 *
 * Usage:
 * ```ts
 * const limiter = createCapacityLimiter(8);
 * await limiter.acquire({ timeoutMs: 10000 });
 * try {
 *   // ... create and use client ...
 * } finally {
 *   limiter.release();
 * }
 * ```
 */
export interface CapacityLimiter {
  /**
   * Acquire a permit. Blocks until a permit is available or timeout occurs.
   *
   * @param options - Acquisition options
   * @param options.timeoutMs - Timeout in milliseconds (0 = no timeout)
   * @throws DartPoolBusyError if timeout occurs
   */
  acquire(options?: { timeoutMs?: number }): Promise<void>;

  /**
   * Release a permit. Must be called exactly once after each successful acquire().
   */
  release(): void;

  /**
   * Get current pool statistics
   */
  stats(): {
    available: number;
    queueDepth: number;
    maxCapacity: number;
  };
}

/**
 * Create a capacity limiter with specified maximum capacity
 *
 * @param maxCapacity - Maximum number of concurrent permits
 * @returns CapacityLimiter instance
 */
export function createCapacityLimiter(maxCapacity: number): CapacityLimiter {
  let availablePermits = maxCapacity;
  const waitingQueue: WaitingRequest[] = [];

  function acquire(options?: { timeoutMs?: number }): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? 0;

    return new Promise<void>((resolve, reject) => {
      // Fast path: permit available immediately
      if (availablePermits > 0) {
        availablePermits--;
        resolve();
        return;
      }

      // Slow path: wait in queue
      const request: WaitingRequest = {
        resolve: () => {
          availablePermits--;
          resolve();
        },
        reject,
        timeout: null as unknown as NodeJS.Timeout, // Will be set below
      };

      // Setup timeout if specified
      if (timeoutMs > 0) {
        request.timeout = setTimeout(() => {
          // Remove from queue
          const index = waitingQueue.indexOf(request);
          if (index !== -1) {
            waitingQueue.splice(index, 1);
          }
          reject(
            new DartPoolBusyError(
              `Dart Analysis Server pool busy: waited ${timeoutMs}ms for available slot (queue depth: ${waitingQueue.length})`
            )
          );
        }, timeoutMs);

        // Fix #11 (Codex Critical Review): unref() to prevent blocking Node.js exit
        // Consistent with idle timer pattern in analyze.ts
        request.timeout.unref();
      }

      waitingQueue.push(request);
    });
  }

  function release(): void {
    // Fix #7 (Critical Review): Defensive check to prevent exceeding max capacity
    if (availablePermits >= maxCapacity) {
      console.warn(
        `[poolGate] release() called when pool is at full capacity (${maxCapacity}). ` +
          `This indicates a permit accounting bug. Current stats: ${JSON.stringify(stats())}`
      );
      return;
    }

    availablePermits++;

    // Process waiting queue (FIFO)
    while (waitingQueue.length > 0 && availablePermits > 0) {
      const request = waitingQueue.shift()!;
      clearTimeout(request.timeout);
      request.resolve();
    }
  }

  function stats() {
    return {
      available: availablePermits,
      queueDepth: waitingQueue.length,
      maxCapacity,
    };
  }

  return {
    acquire,
    release,
    stats,
  };
}
