import { describe, expect, it } from 'vitest';
import { FailedAuthTracker, timingSafeEqualStr } from './auth.js';

describe('timingSafeEqualStr', () => {
  it('is true for identical non-empty strings', () => {
    expect(timingSafeEqualStr('super-secret-token', 'super-secret-token')).toBe(true);
  });

  it('is false for different strings of equal length', () => {
    expect(timingSafeEqualStr('token-aaaaaaaaaa', 'token-bbbbbbbbbb')).toBe(false);
  });

  it('is false for different lengths (no comparison performed)', () => {
    expect(timingSafeEqualStr('short', 'a-much-longer-token')).toBe(false);
  });

  it('is false when either side is empty', () => {
    expect(timingSafeEqualStr('', '')).toBe(false);
    expect(timingSafeEqualStr('', 'nonempty')).toBe(false);
  });
});

describe('FailedAuthTracker', () => {
  it('blocks a source only after reaching the failure threshold', () => {
    const clock = 0;
    const tracker = new FailedAuthTracker({ now: () => clock, threshold: 3, windowMs: 1_000 });
    const ip = '203.0.113.7';

    expect(tracker.isBlocked(ip)).toBe(false);
    expect(tracker.recordFailure(ip)).toBe(false); // 1
    expect(tracker.recordFailure(ip)).toBe(false); // 2
    expect(tracker.isBlocked(ip)).toBe(false);
    expect(tracker.recordFailure(ip)).toBe(true); //  3 -> blocked
    expect(tracker.isBlocked(ip)).toBe(true);
  });

  it('resets the window after it elapses', () => {
    let clock = 0;
    const tracker = new FailedAuthTracker({ now: () => clock, threshold: 3, windowMs: 1_000 });
    const ip = '203.0.113.8';

    tracker.recordFailure(ip);
    tracker.recordFailure(ip);
    tracker.recordFailure(ip);
    expect(tracker.isBlocked(ip)).toBe(true);

    clock += 1_001; // window elapsed
    expect(tracker.isBlocked(ip)).toBe(false);
  });

  it('clears a source on demand (successful auth)', () => {
    const tracker = new FailedAuthTracker({ threshold: 3, windowMs: 1_000 });
    const ip = '203.0.113.9';
    tracker.recordFailure(ip);
    tracker.recordFailure(ip);
    tracker.recordFailure(ip);
    expect(tracker.isBlocked(ip)).toBe(true);
    tracker.clear(ip);
    expect(tracker.isBlocked(ip)).toBe(false);
  });

  it('bounds memory by evicting the oldest source past the cap', () => {
    const tracker = new FailedAuthTracker({ threshold: 3, windowMs: 60_000, maxKeys: 2 });
    tracker.recordFailure('a');
    tracker.recordFailure('b');
    tracker.recordFailure('c'); // evicts 'a'
    // 'a' was evicted, so its prior failure is forgotten and it is not blocked.
    expect(tracker.isBlocked('a')).toBe(false);
  });
});
