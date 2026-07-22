import { describe, expect, it } from 'vitest';
import { backoffCeilingMs, computeBackoffMs, type BackoffPolicy } from './backoff.js';

const POLICY: BackoffPolicy = { baseDelayMs: 100, maxDelayMs: 5_000, jitter: true };

describe('backoffCeilingMs', () => {
  it('doubles the base per attempt until clamped to the max', () => {
    expect(backoffCeilingMs(0, 100, 5_000)).toBe(100);
    expect(backoffCeilingMs(1, 100, 5_000)).toBe(200);
    expect(backoffCeilingMs(2, 100, 5_000)).toBe(400);
    expect(backoffCeilingMs(3, 100, 5_000)).toBe(800);
    expect(backoffCeilingMs(4, 100, 5_000)).toBe(1_600);
    expect(backoffCeilingMs(5, 100, 5_000)).toBe(3_200);
    // 100 * 2^6 = 6400 exceeds the cap.
    expect(backoffCeilingMs(6, 100, 5_000)).toBe(5_000);
  });

  it('clamps at the max for very large attempts without overflowing', () => {
    expect(backoffCeilingMs(100, 100, 5_000)).toBe(5_000);
    expect(backoffCeilingMs(1_000_000, 100, 5_000)).toBe(5_000);
    expect(Number.isFinite(backoffCeilingMs(1_000_000, 100, 5_000))).toBe(true);
  });

  it('treats a negative attempt as attempt 0', () => {
    expect(backoffCeilingMs(-5, 100, 5_000)).toBe(100);
  });
});

describe('computeBackoffMs', () => {
  it('returns the ceiling exactly when jitter is disabled', () => {
    const noJitter: BackoffPolicy = { ...POLICY, jitter: false };
    expect(computeBackoffMs(0, noJitter)).toBe(100);
    expect(computeBackoffMs(3, noJitter)).toBe(800);
    expect(computeBackoffMs(10, noJitter)).toBe(5_000);
  });

  it('full jitter spans [0, ceiling] from the injected random source', () => {
    expect(computeBackoffMs(3, POLICY, () => 0)).toBe(0);
    expect(computeBackoffMs(3, POLICY, () => 0.5)).toBe(400); // floor(0.5 * 800)
    expect(computeBackoffMs(3, POLICY, () => 0.999999)).toBe(799); // floor(0.999999 * 800)
  });

  it('never exceeds the ceiling and never goes negative, for any attempt', () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      for (const r of [0, 0.1, 0.37, 0.5, 0.83, 0.999999]) {
        const ceiling = backoffCeilingMs(attempt, POLICY.baseDelayMs, POLICY.maxDelayMs);
        const delay = computeBackoffMs(attempt, POLICY, () => r);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it('clamps an out-of-range random source into [0,1]', () => {
    expect(computeBackoffMs(2, POLICY, () => -1)).toBe(0);
    expect(computeBackoffMs(2, POLICY, () => 5)).toBe(400); // clamped to 1 * 400
  });
});
