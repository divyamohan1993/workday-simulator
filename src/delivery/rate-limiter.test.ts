import { describe, expect, it } from 'vitest';
import { TokenBucketRateLimiter } from './rate-limiter.js';

/** A controllable clock for deterministic token maths. */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('TokenBucketRateLimiter', () => {
  it('caps sustained rate at rps once the burst is spent', () => {
    const clock = fakeClock();
    const limiter = new TokenBucketRateLimiter({ rps: 10, burst: 10, now: clock.now });

    // The initial burst of 10 is immediately available.
    for (let i = 0; i < 10; i += 1) expect(limiter.tryAcquire()).toBe(true);
    // The 11th is denied: the bucket is empty.
    expect(limiter.tryAcquire()).toBe(false);
    // At 10 rps a token accrues every 100ms.
    expect(limiter.nextAvailableMs()).toBe(100);

    clock.advance(99);
    expect(limiter.tryAcquire()).toBe(false);
    clock.advance(1); // now 100ms elapsed -> exactly one token
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
  });

  it('never exceeds the average rate across a window', () => {
    const clock = fakeClock();
    const limiter = new TokenBucketRateLimiter({ rps: 100, burst: 100, now: clock.now });
    let granted = 0;
    // Simulate 1 second in 10ms steps, asking for a token each step.
    for (let elapsed = 0; elapsed <= 1_000; elapsed += 10) {
      while (limiter.tryAcquire()) granted += 1;
      clock.advance(10);
    }
    // Burst (100) + one second of refill (100) is the ceiling.
    expect(granted).toBeLessThanOrEqual(200);
    expect(granted).toBeGreaterThanOrEqual(190);
  });

  it('defaults burst to ceil(rps) when unset', () => {
    const clock = fakeClock();
    const limiter = new TokenBucketRateLimiter({ rps: 5, burst: 0, now: clock.now });
    let granted = 0;
    while (limiter.tryAcquire()) granted += 1;
    expect(granted).toBe(5);
  });

  it('treats rps<=0 as unlimited', () => {
    const clock = fakeClock();
    const limiter = new TokenBucketRateLimiter({ rps: 0, burst: 0, now: clock.now });
    for (let i = 0; i < 1_000; i += 1) expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.nextAvailableMs()).toBe(0);
  });

  it('blocks all acquisitions until a 429 Retry-After penalty elapses', () => {
    const clock = fakeClock();
    const limiter = new TokenBucketRateLimiter({ rps: 100, burst: 100, now: clock.now });
    limiter.penalize(500);
    expect(limiter.tryAcquire()).toBe(false);
    expect(limiter.nextAvailableMs()).toBe(500);
    clock.advance(499);
    expect(limiter.tryAcquire()).toBe(false);
    clock.advance(1);
    expect(limiter.tryAcquire()).toBe(true);
  });

  it('penalizes an unlimited bucket too', () => {
    const clock = fakeClock();
    const limiter = new TokenBucketRateLimiter({ rps: 0, burst: 0, now: clock.now });
    limiter.penalize(200);
    expect(limiter.tryAcquire()).toBe(false);
    clock.advance(200);
    expect(limiter.tryAcquire()).toBe(true);
  });

  it('acquire() waits exactly one refill interval when starved', async () => {
    const clock = fakeClock();
    const limiter = new TokenBucketRateLimiter({ rps: 10, burst: 1, now: clock.now });
    const slept: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      slept.push(ms);
      clock.advance(ms);
    };
    await limiter.acquire(sleep); // consumes the single burst token immediately
    expect(slept).toEqual([]);
    await limiter.acquire(sleep); // must wait ~100ms for the next token
    expect(slept.length).toBeGreaterThan(0);
    expect(clock.now()).toBeGreaterThanOrEqual(100);
  });
});
