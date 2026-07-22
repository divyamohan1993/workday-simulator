/**
 * A bounded-memory latency histogram using reservoir sampling (Vitter's Algorithm
 * R), producing p50/p95/p99 by the nearest-rank method.
 *
 * WHY a reservoir rather than an unbounded sample array or coarse fixed buckets:
 * - Memory is bounded to the reservoir capacity regardless of how many samples
 *   arrive, satisfying the "never an unbounded sample array" constraint.
 * - When the number of samples is at or below the capacity, the reservoir retains
 *   EVERY sample, so the percentiles are EXACT. This makes the metric trustworthy for
 *   the volumes a demo run produces and makes the percentile math directly testable.
 * - Beyond capacity, Algorithm R keeps a uniform random sample, so percentiles remain
 *   a sound estimate with bounded memory. `max` and `count` are tracked exactly
 *   outside the reservoir so the tail and the total are never underreported.
 *
 * The PRNG is seeded for deterministic replay: two registries built with the same
 * seed sampling the same stream retain the same reservoir.
 */

import type { LatencyHistogram } from '../types/index.js';

export interface Histogram {
  /** Record one latency observation, in milliseconds. */
  record(value: number): void;
  /** Current p50/p95/p99/max/count snapshot. */
  snapshot(): LatencyHistogram;
  /** Reset to empty and re-seed the sampler for deterministic reuse. */
  reset(): void;
}

/** FNV-1a hash of the seed string into a 32-bit unsigned integer. */
function hashSeed(seed: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32: a small, fast, deterministic PRNG returning floats in `[0, 1)`. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The nearest-rank percentile of an ascending-sorted array.
 *
 * For a quantile `p` in `[0, 1]` and `n` samples, the rank is `ceil(p * n)` and the
 * value is the element at 1-based rank (0-based `rank - 1`), clamped into range. With
 * `n = 100`, p50 -> element 50, p95 -> element 95, p99 -> element 99.
 */
export function nearestRank(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const idx = Math.min(Math.max(Math.ceil(p * n) - 1, 0), n - 1);
  return sortedAsc[idx] ?? 0;
}

/**
 * Build a reservoir histogram.
 *
 * @param capacity Reservoir size (bounded memory). Defaults to 4096.
 * @param seed Sampler seed for deterministic reservoir contents.
 * @returns A `Histogram`.
 */
export function createReservoirHistogram(capacity = 4096, seed = 'metrics'): Histogram {
  const cap = Math.max(1, Math.trunc(capacity));
  const seedInt = hashSeed(seed);

  let reservoir: number[] = [];
  let count = 0;
  let max = 0;
  let rand = mulberry32(seedInt);

  return {
    record(value: number): void {
      if (!Number.isFinite(value)) return;
      const v = value < 0 ? 0 : value;
      count += 1;
      if (v > max) max = v;
      if (reservoir.length < cap) {
        reservoir.push(v);
        return;
      }
      // Replace a uniformly-chosen element with probability cap/count.
      const j = Math.floor(rand() * count);
      if (j < cap) reservoir[j] = v;
    },

    snapshot(): LatencyHistogram {
      if (count === 0) return { p50: 0, p95: 0, p99: 0, max: 0, count: 0 };
      const sorted = [...reservoir].sort((a, b) => a - b);
      return {
        p50: nearestRank(sorted, 0.5),
        p95: nearestRank(sorted, 0.95),
        p99: nearestRank(sorted, 0.99),
        max,
        count,
      };
    },

    reset(): void {
      reservoir = [];
      count = 0;
      max = 0;
      rand = mulberry32(seedInt);
    },
  };
}
