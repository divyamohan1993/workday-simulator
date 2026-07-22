/**
 * Exponential backoff with full jitter.
 *
 * WHY full jitter: when a target degrades, many in-flight events fail and retry
 * at once. Deterministic backoff re-synchronizes them into retry waves that
 * hammer the recovering target in lockstep (the "thundering herd"). Full jitter
 * (delay uniformly random in [0, cap]) spreads retries evenly across the window,
 * which AWS measured as the lowest-contention strategy. The cap grows
 * exponentially with the attempt and is clamped to `maxDelayMs`.
 */

/** Backoff shape derived from a target's `DeliveryRetryPolicy`. */
export interface BackoffPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

/**
 * The deterministic (un-jittered) backoff ceiling for a 0-based attempt index:
 * `min(maxDelayMs, baseDelayMs * 2^attempt)`. The exponent is capped so a large
 * attempt count cannot overflow to Infinity before the clamp.
 *
 * @param attempt 0-based retry index (0 = the delay before the first retry).
 * @param baseDelayMs Base unit of delay.
 * @param maxDelayMs Absolute ceiling.
 * @returns The clamped exponential ceiling in ms.
 */
export function backoffCeilingMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const safeAttempt = attempt < 0 ? 0 : attempt;
  // 2^30 * base already dwarfs any sane maxDelayMs; capping the exponent keeps
  // the multiplication finite regardless of how many retries a policy allows.
  const exponent = Math.min(safeAttempt, 30);
  const raw = baseDelayMs * 2 ** exponent;
  if (!Number.isFinite(raw) || raw > maxDelayMs) return maxDelayMs;
  return raw;
}

/**
 * Compute the actual backoff delay for a 0-based attempt using full jitter.
 *
 * @param attempt 0-based retry index.
 * @param policy Base/max/jitter shape.
 * @param random Source of uniform [0,1) values; injected for deterministic tests.
 * @returns Integer milliseconds to wait, in [0, ceiling].
 */
export function computeBackoffMs(
  attempt: number,
  policy: BackoffPolicy,
  random: () => number = Math.random,
): number {
  const ceiling = backoffCeilingMs(attempt, policy.baseDelayMs, policy.maxDelayMs);
  if (!policy.jitter) return ceiling;
  const r = random();
  const clamped = r < 0 ? 0 : r > 1 ? 1 : r;
  return Math.floor(clamped * ceiling);
}
