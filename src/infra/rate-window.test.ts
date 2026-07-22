import { describe, expect, it } from 'vitest';
import { createRateWindow } from './rate-window.js';

describe('createRateWindow', () => {
  it('returns zero rate and error rate before any observation', () => {
    const win = createRateWindow(5);
    expect(win.rps(0)).toBe(0);
    expect(win.errorRate(0)).toBe(0);
  });

  it('averages delivered events over the elapsed window (smoothing)', () => {
    const win = createRateWindow(5);
    for (let i = 0; i < 5; i += 1) win.record('delivered', 0);
    // One second elapsed, five delivered -> 5 rps.
    expect(win.rps(0)).toBe(5);

    for (let i = 0; i < 3; i += 1) win.record('delivered', 4_000);
    // Seconds 0..4 elapsed (denominator 5), 8 delivered in-window -> 1.6 rps.
    expect(win.rps(4_000)).toBeCloseTo(1.6, 5);
  });

  it('drops observations that fall out of the trailing window', () => {
    const win = createRateWindow(5);
    win.record('delivered', 0);
    win.record('delivered', 4_000);
    // At second 10 the window is [6, 10]; both prior records are outside it.
    expect(win.rps(10_000)).toBe(0);
  });

  it('computes error rate as failed / (delivered + failed), excluding dropped', () => {
    const win = createRateWindow(5);
    for (let i = 0; i < 8; i += 1) win.record('delivered', 0);
    for (let i = 0; i < 2; i += 1) win.record('failed', 0);
    expect(win.errorRate(0)).toBeCloseTo(0.2, 5);

    // Dropped events were never attempted: they must not move the error rate.
    for (let i = 0; i < 5; i += 1) win.record('dropped', 0);
    expect(win.errorRate(0)).toBeCloseTo(0.2, 5);
  });

  it('resets all buckets', () => {
    const win = createRateWindow(5);
    win.record('delivered', 0);
    win.record('failed', 0);
    win.reset();
    expect(win.rps(0)).toBe(0);
    expect(win.errorRate(0)).toBe(0);
  });
});
