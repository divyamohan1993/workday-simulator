import { describe, expect, it } from 'vitest';
import { computeBackoff, type BackoffOptions } from '@/lib/backoff';

const opts: BackoffOptions = { baseMs: 500, capMs: 15_000, jitter: false };

describe('computeBackoff', () => {
  it('doubles per attempt without jitter', () => {
    expect(computeBackoff(0, opts)).toBe(500);
    expect(computeBackoff(1, opts)).toBe(1000);
    expect(computeBackoff(2, opts)).toBe(2000);
    expect(computeBackoff(3, opts)).toBe(4000);
  });

  it('caps the window', () => {
    expect(computeBackoff(5, opts)).toBe(15_000);
    expect(computeBackoff(50, opts)).toBe(15_000);
  });

  it('never overflows on a very large attempt', () => {
    expect(Number.isFinite(computeBackoff(1000, opts))).toBe(true);
    expect(computeBackoff(1000, opts)).toBe(15_000);
  });

  it('applies full jitter within [0, window] using the injected rng', () => {
    const jittered: BackoffOptions = { ...opts, jitter: true };
    // attempt 2 -> window 2000
    expect(computeBackoff(2, jittered, () => 0)).toBe(0);
    expect(computeBackoff(2, jittered, () => 1)).toBe(2000);
    expect(computeBackoff(2, jittered, () => 0.5)).toBe(1000);
  });

  it('treats negative attempts as attempt 0', () => {
    expect(computeBackoff(-3, opts)).toBe(500);
  });
});
