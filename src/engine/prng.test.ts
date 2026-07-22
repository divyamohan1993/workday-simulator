import { describe, it, expect } from 'vitest';
import { createPrng } from './prng.js';

describe('createPrng', () => {
  it('is deterministic for a given seed', () => {
    const a = createPrng('seed-x');
    const b = createPrng('seed-x');
    const seqA = Array.from({ length: 100 }, () => a.next());
    const seqB = Array.from({ length: 100 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('produces different streams for different seeds', () => {
    const a = createPrng('seed-x');
    const b = createPrng('seed-y');
    const seqA = Array.from({ length: 50 }, () => a.next());
    const seqB = Array.from({ length: 50 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it('returns uniforms in [0, 1)', () => {
    const prng = createPrng('range');
    for (let i = 0; i < 10_000; i += 1) {
      const u = prng.next();
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });

  it('draws exponential inter-arrivals whose mean matches 1/rate', () => {
    const prng = createPrng('exp');
    const ratePerSec = 50;
    const n = 40_000;
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += prng.exponentialMs(ratePerSec);
    const meanMs = sum / n;
    const expectedMs = 1000 / ratePerSec;
    expect(Math.abs(meanMs - expectedMs) / expectedMs).toBeLessThan(0.05);
  });

  it('returns Infinity for a non-positive exponential rate', () => {
    const prng = createPrng('exp0');
    expect(prng.exponentialMs(0)).toBe(Number.POSITIVE_INFINITY);
    expect(prng.exponentialMs(-3)).toBe(Number.POSITIVE_INFINITY);
  });

  it('weightedIndex respects the weights', () => {
    const prng = createPrng('weights');
    const weights = [1, 0, 9]; // index 2 should dominate, index 1 never
    const counts: Record<number, number> = { 0: 0, 1: 0, 2: 0 };
    for (let i = 0; i < 20_000; i += 1) {
      const idx = prng.weightedIndex(weights);
      counts[idx] = (counts[idx] ?? 0) + 1;
    }
    const c0 = counts[0] ?? 0;
    const c1 = counts[1] ?? 0;
    const c2 = counts[2] ?? 0;
    expect(c1).toBe(0);
    expect(c2).toBeGreaterThan(c0);
    // Roughly 90/10 split within a generous band.
    expect(c2 / 20_000).toBeGreaterThan(0.85);
  });

  it('fork yields deterministic, independent child streams', () => {
    const parentA = createPrng('root');
    const parentB = createPrng('root');
    const childA = parentA.fork('arrival');
    const childB = parentB.fork('arrival');
    const other = parentA.fork('engine');
    expect(Array.from({ length: 20 }, () => childA.next())).toEqual(
      Array.from({ length: 20 }, () => childB.next()),
    );
    expect(Array.from({ length: 20 }, () => parentA.fork('arrival').next())).not.toEqual(
      Array.from({ length: 20 }, () => other.next()),
    );
  });
});
