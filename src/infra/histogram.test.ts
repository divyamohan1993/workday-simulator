import { describe, expect, it } from 'vitest';
import { createReservoirHistogram, nearestRank } from './histogram.js';

describe('nearestRank', () => {
  const sorted = [10, 20, 30, 40, 50];

  it('picks the element at the ceil(p*n) rank', () => {
    expect(nearestRank(sorted, 0.5)).toBe(30);
    expect(nearestRank(sorted, 0.2)).toBe(10);
    expect(nearestRank(sorted, 1)).toBe(50);
  });

  it('clamps the extremes and handles empty input', () => {
    expect(nearestRank(sorted, 0)).toBe(10);
    expect(nearestRank([], 0.5)).toBe(0);
  });
});

describe('createReservoirHistogram', () => {
  it('computes exact percentiles when all samples fit the reservoir', () => {
    const hist = createReservoirHistogram(4096, 'seed');
    for (let v = 1; v <= 100; v += 1) hist.record(v);

    const snap = hist.snapshot();
    expect(snap.count).toBe(100);
    expect(snap.max).toBe(100);
    expect(snap.p50).toBe(50);
    expect(snap.p95).toBe(95);
    expect(snap.p99).toBe(99);
  });

  it('reports zeros when empty', () => {
    const hist = createReservoirHistogram();
    expect(hist.snapshot()).toEqual({ p50: 0, p95: 0, p99: 0, max: 0, count: 0 });
  });

  it('keeps exact count and max with a bounded reservoir under overflow', () => {
    const hist = createReservoirHistogram(100, 'seed');
    for (let v = 1; v <= 10_000; v += 1) hist.record(v);

    const snap = hist.snapshot();
    // count and max are tracked outside the reservoir, so they stay exact.
    expect(snap.count).toBe(10_000);
    expect(snap.max).toBe(10_000);
    // Percentiles are a sound estimate from the bounded sample and stay ordered.
    expect(snap.p50).toBeGreaterThan(2_000);
    expect(snap.p50).toBeLessThan(8_000);
    expect(snap.p95).toBeGreaterThanOrEqual(snap.p50);
    expect(snap.p99).toBeGreaterThanOrEqual(snap.p95);
    expect(snap.p99).toBeLessThanOrEqual(snap.max);
  });

  it('is deterministic for a fixed seed', () => {
    const build = (): ReturnType<typeof createReservoirHistogram> => {
      const h = createReservoirHistogram(64, 'fixed');
      for (let v = 1; v <= 5_000; v += 1) h.record(v);
      return h;
    };
    expect(build().snapshot()).toEqual(build().snapshot());
  });

  it('clears on reset', () => {
    const hist = createReservoirHistogram(16, 'seed');
    for (let v = 1; v <= 50; v += 1) hist.record(v);
    hist.reset();
    expect(hist.snapshot()).toEqual({ p50: 0, p95: 0, p99: 0, max: 0, count: 0 });
  });

  it('ignores non-finite values and floors negatives to zero', () => {
    const hist = createReservoirHistogram();
    hist.record(Number.NaN);
    hist.record(Number.POSITIVE_INFINITY);
    hist.record(-5);
    const snap = hist.snapshot();
    expect(snap.count).toBe(1);
    expect(snap.max).toBe(0);
  });
});
