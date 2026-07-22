/**
 * Token-bucket rate limiter that honours BOTH the target's configured rps and a
 * server-directed 429 Retry-After penalty.
 *
 * WHY a token bucket: it caps the sustained request rate at `rps` while allowing
 * short bursts up to `burst`, which matches how real IdM ingress is provisioned
 * (a steady quota with headroom). The bucket refills continuously, so callers
 * are paced smoothly rather than in fixed windows.
 *
 * The core (`refill`, `tryAcquire`, `nextAvailableMs`) is pure over an injected
 * clock so the maths are unit-testable without timers; the async `acquire`
 * wrapper layers real waiting on top.
 */

/** Configuration for {@link TokenBucketRateLimiter}. */
export interface RateLimiterOptions {
  /** Sustained requests/second. `0` (or negative) means unlimited. */
  rps: number;
  /** Bucket capacity (max burst). When `0` and rps>0, defaults to ceil(rps). */
  burst: number;
  /** Injected clock; defaults to `Date.now`. */
  now?: () => number;
}

export class TokenBucketRateLimiter {
  private readonly unlimited: boolean;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;

  private tokens: number;
  private lastRefillMs: number;
  /** All acquisitions are blocked until this wall time (server Retry-After). */
  private penaltyUntilMs = 0;

  constructor(options: RateLimiterOptions) {
    this.now = options.now ?? Date.now;
    this.unlimited = options.rps <= 0;
    // A rps>0 target with burst 0 would never accumulate a whole token; give it
    // a one-request bucket so it can make progress at exactly the rate.
    this.capacity = this.unlimited
      ? 0
      : Math.max(1, options.burst > 0 ? options.burst : Math.ceil(options.rps));
    this.refillPerMs = this.unlimited ? 0 : options.rps / 1000;
    this.tokens = this.capacity;
    this.lastRefillMs = this.now();
  }

  /**
   * Block every acquisition until `now + ms`. Called when a target answers 429
   * (or 503) with a Retry-After: the whole bucket must back off, not just the
   * one request, so we do not immediately re-flood the target.
   *
   * @param ms Server-directed wait in milliseconds.
   */
  penalize(ms: number): void {
    if (ms <= 0) return;
    const until = this.now() + ms;
    if (until > this.penaltyUntilMs) this.penaltyUntilMs = until;
  }

  /** Accrue tokens for the elapsed time since the last refill (no-op if unlimited). */
  private refill(nowMs: number): void {
    if (this.unlimited) return;
    const elapsed = nowMs - this.lastRefillMs;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefillMs = nowMs;
  }

  /**
   * Milliseconds until an acquisition could succeed (0 if one is available now).
   * Accounts for both an active penalty and token starvation.
   */
  nextAvailableMs(nowMs: number = this.now()): number {
    const penaltyWait = Math.max(0, this.penaltyUntilMs - nowMs);
    if (this.unlimited) return penaltyWait;
    this.refill(nowMs);
    if (this.tokens >= 1) return penaltyWait;
    const tokenWait = Math.ceil((1 - this.tokens) / this.refillPerMs);
    return Math.max(penaltyWait, tokenWait);
  }

  /**
   * Consume one token if the bucket is neither penalized nor empty. Synchronous
   * and atomic within the single-threaded event loop, so two workers can never
   * take the same token.
   *
   * @returns true when a token was consumed.
   */
  tryAcquire(nowMs: number = this.now()): boolean {
    if (nowMs < this.penaltyUntilMs) return false;
    if (this.unlimited) return true;
    this.refill(nowMs);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Await a token, sleeping exactly as long as the bucket dictates. Re-checks
   * after each sleep because another worker may consume the freed token first.
   *
   * @param sleep Injected delay function (real setTimeout in production).
   */
  async acquire(sleep: (ms: number) => Promise<void>): Promise<void> {
    for (;;) {
      if (this.tryAcquire()) return;
      const wait = this.nextAvailableMs();
      // Never busy-spin: wait at least 1ms so the loop yields even if the
      // computed wait rounds to zero under clock granularity.
      await sleep(Math.max(1, wait));
    }
  }
}
