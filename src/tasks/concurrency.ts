import { TaskTimeoutError } from '../utils/errors';

/**
 * Bounded Asynchronous Concurrency Limiter (Semaphore).
 * Ensures no more than `maxConcurrent` operations execute simultaneously.
 */
export class ConcurrencyLimiter {
  private activeCount = 0;
  private readonly queue: Array<() => void> = [];

  constructor(public readonly maxConcurrent: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error('maxConcurrent must be a positive integer');
    }
  }

  public getActiveCount(): number {
    return this.activeCount;
  }

  public getPendingCount(): number {
    return this.queue.length;
  }

  public async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.activeCount < this.maxConcurrent) {
      this.activeCount++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.activeCount++;
        resolve();
      });
    });
  }

  private release(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }
}

/**
 * Wraps an asynchronous operation with a strict timeout.
 */
export async function withOperationTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new TaskTimeoutError(
          `تجاوزت العملية المهلة المحددة (${Math.round(timeoutMs / 1000)} ثانية).`
        )
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
