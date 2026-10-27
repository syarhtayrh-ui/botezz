/**
 * Bounded Exponential Backoff with Jitter
 */

export interface BackoffOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
  jitterRatio?: number;
}

/**
 * Computes bounded exponential backoff delay with random jitter.
 */
export function calculateBackoffDelay(
  attempt: number,
  options: BackoffOptions = {}
): number {
  const baseDelayMs = options.baseDelayMs ?? 1500;
  const maxDelayMs = options.maxDelayMs ?? 30000;
  const jitterRatio = options.jitterRatio ?? 0.25;

  const safeAttempt = Math.max(0, Math.min(attempt, 20));
  const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, safeAttempt));
  const jitterRange = exponential * jitterRatio;
  const randomOffset = (Math.random() * 2 - 1) * jitterRange;
  return Math.max(200, Math.min(maxDelayMs, Math.round(exponential + randomOffset)));
}
