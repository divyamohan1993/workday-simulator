import { describe, expect, it } from 'vitest';
import { DEFAULT_RATE_LIMIT_BURST, DEFAULT_RATE_LIMIT_RPS } from './constants.js';
import { createRateLimiter } from './rate-limiter.js';

describe('default rate-limit calibration', () => {
  it('sits far above the simulator throughput so backpressure, not the per-IP cap, sheds', () => {
    // The built-in delivery is a single loopback source; the per-source default
    // must comfortably exceed MAX_RPS (default 2000) or it would 429 legit traffic.
    expect(DEFAULT_RATE_LIMIT_RPS).toBeGreaterThan(2_000);
    expect(DEFAULT_RATE_LIMIT_BURST).toBeGreaterThanOrEqual(DEFAULT_RATE_LIMIT_RPS);
  });
});

describe('rate limiter (token bucket)', () => {
  it('admits up to the burst then refuses with a Retry-After', () => {
    const limiter = createRateLimiter({ ratePerSec: 10, burst: 2, maxKeys: 100 });
    expect(limiter.tryAdmit('ip', 0).allowed).toBe(true);
    expect(limiter.tryAdmit('ip', 0).allowed).toBe(true);
    const refused = limiter.tryAdmit('ip', 0);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it('refills tokens over elapsed time', () => {
    const limiter = createRateLimiter({ ratePerSec: 10, burst: 2, maxKeys: 100 });
    limiter.tryAdmit('ip', 0);
    limiter.tryAdmit('ip', 0);
    expect(limiter.tryAdmit('ip', 0).allowed).toBe(false);
    // 1 second later, 10 tokens/sec have accrued (capped at burst 2), so admits again.
    expect(limiter.tryAdmit('ip', 1000).allowed).toBe(true);
  });

  it('treats a zero rate as unlimited', () => {
    const limiter = createRateLimiter({ ratePerSec: 0, burst: 1, maxKeys: 10 });
    for (let i = 0; i < 100; i += 1) expect(limiter.tryAdmit('ip', 0).allowed).toBe(true);
  });

  it('bounds tracked sources by evicting the least-recent', () => {
    const limiter = createRateLimiter({ ratePerSec: 10, burst: 1, maxKeys: 3 });
    for (let i = 0; i < 10; i += 1) limiter.tryAdmit(`ip-${i}`, 0);
    expect(limiter.size()).toBeLessThanOrEqual(3);
  });

  it('isolates sources from one another', () => {
    const limiter = createRateLimiter({ ratePerSec: 1, burst: 1, maxKeys: 100 });
    expect(limiter.tryAdmit('a', 0).allowed).toBe(true);
    expect(limiter.tryAdmit('a', 0).allowed).toBe(false);
    // A different source has its own full bucket.
    expect(limiter.tryAdmit('b', 0).allowed).toBe(true);
  });
});
