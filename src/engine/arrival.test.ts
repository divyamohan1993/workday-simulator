import { describe, it, expect } from 'vitest';
import type { TimezoneWeights } from '../types/index.js';
import { ALL_LOCATIONS } from '../types/index.js';
import { createArrivalProcess } from './arrival.js';

function weightsOnly(...active: string[]): TimezoneWeights {
  const byLocation = {} as TimezoneWeights['byLocation'];
  for (const loc of ALL_LOCATIONS) byLocation[loc] = active.includes(loc) ? 1 : 0;
  return { byLocation };
}

const FFT = weightsOnly('FFT');
const CORE_INSTANT = Date.UTC(2026, 5, 16, 8, 30, 0); // Berlin 10:30 Tuesday

describe('createArrivalProcess', () => {
  it('shapes a monotonic rate across the Frankfurt morning ramp', () => {
    const arrival = createArrivalProcess({ baselineRps: 100, maxRps: 1_000_000, timezoneWeights: FFT, seed: 's' });
    const base = Date.UTC(2026, 5, 16, 4, 0, 0); // Berlin 06:00
    const step = 30 * 60 * 1000;
    let previous = -Infinity;
    for (let k = 0; k <= 5; k += 1) {
      const rate = arrival.rateAt(base + k * step);
      expect(rate).toBeGreaterThan(previous);
      previous = rate;
    }
  });

  it('never exceeds maxRps', () => {
    const arrival = createArrivalProcess({ baselineRps: 100_000, maxRps: 200, timezoneWeights: FFT, seed: 's' });
    for (let h = 0; h < 24; h += 1) {
      const rate = arrival.rateAt(Date.UTC(2026, 5, 16, h, 0, 0));
      expect(rate).toBeLessThanOrEqual(200);
    }
  });

  it('draws inter-arrivals whose mean matches 1000 / rate', () => {
    const arrival = createArrivalProcess({ baselineRps: 100, maxRps: 1_000_000, timezoneWeights: FFT, seed: 'mean' });
    const rate = arrival.rateAt(CORE_INSTANT);
    expect(rate).toBeGreaterThan(0);
    const expected = 1000 / rate;
    const n = 30_000;
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += arrival.nextInterArrivalMs(CORE_INSTANT, 1);
    const mean = sum / n;
    expect(Math.abs(mean - expected) / expected).toBeLessThan(0.06);
  });

  it('lengthens inter-arrivals proportionally under throttle', () => {
    const full = createArrivalProcess({ baselineRps: 100, maxRps: 1_000_000, timezoneWeights: FFT, seed: 'thr' });
    const half = createArrivalProcess({ baselineRps: 100, maxRps: 1_000_000, timezoneWeights: FFT, seed: 'thr' });
    const n = 30_000;
    let sumFull = 0;
    let sumHalf = 0;
    for (let i = 0; i < n; i += 1) {
      sumFull += full.nextInterArrivalMs(CORE_INSTANT, 1);
      sumHalf += half.nextInterArrivalMs(CORE_INSTANT, 0.5);
    }
    const ratio = sumHalf / sumFull;
    expect(ratio).toBeGreaterThan(1.8);
    expect(ratio).toBeLessThan(2.2);
  });

  it('pauses (returns the max gap) at throttle 0', () => {
    const arrival = createArrivalProcess({ baselineRps: 100, maxRps: 1_000_000, timezoneWeights: FFT, seed: 's' });
    expect(arrival.nextInterArrivalMs(CORE_INSTANT, 0)).toBe(60_000);
  });

  it('is deterministic for a fixed seed and clock trajectory', () => {
    const a = createArrivalProcess({ baselineRps: 80, maxRps: 5000, timezoneWeights: FFT, seed: 'rep' });
    const b = createArrivalProcess({ baselineRps: 80, maxRps: 5000, timezoneWeights: FFT, seed: 'rep' });
    const seqA = Array.from({ length: 200 }, () => a.nextInterArrivalMs(CORE_INSTANT, 1));
    const seqB = Array.from({ length: 200 }, () => b.nextInterArrivalMs(CORE_INSTANT, 1));
    expect(seqA).toEqual(seqB);
  });

  it('reseed restarts the same deterministic stream', () => {
    const arrival = createArrivalProcess({ baselineRps: 80, maxRps: 5000, timezoneWeights: FFT, seed: 'first' });
    const before = Array.from({ length: 50 }, () => arrival.nextInterArrivalMs(CORE_INSTANT, 1));
    arrival.reseed('first');
    const after = Array.from({ length: 50 }, () => arrival.nextInterArrivalMs(CORE_INSTANT, 1));
    expect(after).toEqual(before);
  });
});
