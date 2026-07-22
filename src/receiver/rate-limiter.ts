/**
 * A per-source token-bucket rate limiter for inbound requests.
 *
 * WHY token bucket: it admits short bursts (up to `burst`) while capping the
 * sustained rate at `ratePerSec`, which is how a real identity manager's API
 * gateway sheds excess load. When a bucket is empty the caller is told to back off
 * with a computed Retry-After, so a well-behaved client (the delivery adapter,
 * which honors Retry-After) self-throttles rather than hammering.
 *
 * Memory is bounded: idle buckets are evicted once the tracked-source count
 * exceeds a cap, so a flood from many spoofed source addresses cannot grow the map
 * without limit (a DoS on the limiter itself).
 */

/** A single source's bucket: current tokens and when they were last refilled. */
interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

/** Options for {@link createRateLimiter}. */
export interface RateLimiterOptions {
  /** Sustained requests/second admitted per source. 0 disables limiting. */
  ratePerSec: number;
  /** Burst capacity (max tokens) per source. */
  burst: number;
  /** Max distinct sources tracked before the least-recent are evicted. */
  maxKeys: number;
}

/** The result of an admission check. */
export interface RateDecision {
  allowed: boolean;
  /** Seconds until at least one token is available, when not allowed. */
  retryAfterSec: number;
}

/** The rate limiter surface. */
export interface RateLimiter {
  /** Try to admit one request from `key` at `nowMs`, consuming a token on success. */
  tryAdmit(key: string, nowMs: number): RateDecision;
  /** Number of currently tracked sources (for diagnostics/tests). */
  size(): number;
  /** Clear all buckets. */
  reset(): void;
}

/**
 * Build a token-bucket rate limiter.
 *
 * @param options Rate, burst and the tracked-source cap.
 * @returns The limiter.
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const ratePerSec = Math.max(0, options.ratePerSec);
  const burst = Math.max(1, options.burst);
  const maxKeys = Math.max(1, options.maxKeys);
  const buckets = new Map<string, Bucket>();

  /** Evict the least-recently-inserted bucket when over the cap. */
  const evictIfNeeded = (): void => {
    if (buckets.size <= maxKeys) return;
    const oldest = buckets.keys().next().value;
    if (oldest !== undefined) buckets.delete(oldest);
  };

  return {
    tryAdmit(key: string, nowMs: number): RateDecision {
      // A zero rate means "no limiting": always admit.
      if (ratePerSec <= 0) return { allowed: true, retryAfterSec: 0 };

      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { tokens: burst, lastRefillMs: nowMs };
        buckets.set(key, bucket);
        evictIfNeeded();
      } else {
        // Refill proportional to elapsed time, capped at burst.
        const elapsedSec = Math.max(0, (nowMs - bucket.lastRefillMs) / 1000);
        if (elapsedSec > 0) {
          bucket.tokens = Math.min(burst, bucket.tokens + elapsedSec * ratePerSec);
          bucket.lastRefillMs = nowMs;
        }
      }

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return { allowed: true, retryAfterSec: 0 };
      }
      // Time for one whole token to accrue.
      const deficit = 1 - bucket.tokens;
      const retryAfterSec = Math.max(1, Math.ceil(deficit / ratePerSec));
      return { allowed: false, retryAfterSec };
    },

    size(): number {
      return buckets.size;
    },

    reset(): void {
      buckets.clear();
    },
  };
}
