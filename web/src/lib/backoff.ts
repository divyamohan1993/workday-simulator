/**
 * Exponential backoff with full jitter, used by the reconnecting telemetry
 * socket. Pure and deterministic under an injected RNG so the delay policy is
 * unit tested without timers.
 *
 * WHY full jitter: many dashboard tabs reconnecting to the same backend after a
 * server restart would otherwise retry in lockstep and hammer the origin. Full
 * jitter spreads them uniformly across the window (AWS "exponential backoff and
 * jitter" recommendation).
 */

export interface BackoffOptions {
  /** Base delay in ms for attempt 0. */
  baseMs: number;
  /** Hard ceiling on any single delay. */
  capMs: number;
  /** When true, return a uniform random value in [0, window]; else the window. */
  jitter: boolean;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 500,
  capMs: 15_000,
  jitter: true,
};

/**
 * Compute the delay before retry `attempt` (0-indexed). The uncapped window is
 * `base * 2^attempt`, capped at `capMs`; with jitter the result is uniformly
 * sampled from `[0, cappedWindow]`. `rng` defaults to Math.random and is
 * injectable for tests.
 */
export function computeBackoff(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  rng: () => number = Math.random,
): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  // Cap the exponent so 2^attempt cannot overflow to Infinity on long outages.
  const exponent = Math.min(safeAttempt, 30);
  const uncapped = options.baseMs * 2 ** exponent;
  const window = Math.min(options.capMs, uncapped);
  if (!options.jitter) return Math.round(window);
  return Math.round(rng() * window);
}
