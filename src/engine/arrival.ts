/**
 * The non-homogeneous Poisson arrival process.
 *
 * Event arrivals follow a time-varying rate lambda(t) shaped by the multi-timezone
 * workday (see diurnal.ts). The instantaneous rate is re-evaluated at every arrival
 * by the runtime, which calls `nextInterArrivalMs` with the current simulated
 * instant; because inter-arrival gaps (milliseconds) are minuscule compared with the
 * timescale over which lambda changes (hours), sampling an exponential gap at the
 * instantaneous rate is the piecewise-constant limit of the thinning method and is
 * both exact for practical purposes and O(1) on the hot path.
 *
 * Determinism: all randomness comes from a seeded PRNG, so the same seed and the
 * same clock trajectory reproduce the same arrivals exactly.
 *
 * Design note on the signature: `nextInterArrivalMs` receives a simulated instant but
 * no acceleration factor, so it cannot itself probe future simulated instants to run
 * multi-step thinning. That is deliberate; the runtime owns the clock and performs
 * the piecewise re-evaluation by calling this method afresh at each arrival.
 */

import type { ArrivalOptions } from '../contracts/factories.js';
import type { ArrivalProcess } from '../contracts/arrival.js';
import { diurnalShape } from './diurnal.js';
import { createPrng, type Prng } from './prng.js';

/** Longest gap returned so the control loop keeps ticking during deep troughs. */
const MAX_GAP_MS = 60_000;

/**
 * Create a seeded non-homogeneous Poisson arrival process.
 *
 * @param options.baselineRps Steady-state events/sec before diurnal shaping.
 * @param options.maxRps Hard ceiling; the instantaneous rate is clamped to this.
 * @param options.timezoneWeights Per-site activity weights shaping the curve.
 * @param options.seed Seed for the internal PRNG.
 */
export function createArrivalProcess(options: ArrivalOptions): ArrivalProcess {
  const baselineRps = Math.max(0, options.baselineRps);
  const maxRps = Math.max(0, options.maxRps);
  const { timezoneWeights } = options;
  let prng: Prng = createPrng(options.seed);

  const process: ArrivalProcess = {
    rateAt(simEpochMs: number): number {
      const shape = diurnalShape(simEpochMs, timezoneWeights);
      const rate = baselineRps * shape;
      if (!Number.isFinite(rate) || rate <= 0) return 0;
      return rate > maxRps ? maxRps : rate;
    },

    nextInterArrivalMs(simEpochMs: number, throttle = 1): number {
      const t = throttle <= 0 ? 0 : throttle >= 1 ? 1 : throttle;
      const effectiveRate = this.rateAt(simEpochMs) * t;
      if (!(effectiveRate > 0)) return MAX_GAP_MS;

      const gap = prng.exponentialMs(effectiveRate);
      if (!Number.isFinite(gap)) return MAX_GAP_MS;
      // Only the upper bound is clamped. Leaving the lower bound free preserves the
      // exponential distribution's mean of 1000/effectiveRate; per-tick burst work is
      // bounded by the runtime, not by truncating small gaps here.
      return gap > MAX_GAP_MS ? MAX_GAP_MS : gap;
    },

    reseed(seed: string): void {
      prng = createPrng(seed);
    },
  };

  return process;
}
