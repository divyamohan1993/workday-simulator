/**
 * Non-homogeneous Poisson arrival process. Event arrivals follow a time-varying
 * rate lambda(t) shaped by the multi-timezone workday: overlapping business hours
 * across Frankfurt, London, New York, Singapore, Hong Kong, Bangalore, Pune and
 * Jacksonville, with weekend and overnight troughs. Implementations use the
 * thinning method so the instantaneous rate can change continuously.
 *
 * The process is seeded for deterministic replay: the same seed and the same clock
 * trajectory produce the same arrivals.
 */
export interface ArrivalProcess {
  /**
   * Instantaneous arrival rate lambda(t) in events/second at a simulated instant,
   * after diurnal and per-location weighting. Excludes chaos and runtime throttle.
   */
  rateAt(simEpochMs: number): number;

  /**
   * Real milliseconds until the next arrival, drawn from an exponential
   * inter-arrival distribution with the effective rate at `simEpochMs`.
   *
   * @param throttle Factor in [0,1] applied by the runtime under delivery
   *   backpressure. 1 = full rate, 0 = paused. Values below 1 lengthen the
   *   inter-arrival time proportionally.
   */
  nextInterArrivalMs(simEpochMs: number, throttle?: number): number;

  /** Reseed the internal PRNG so a run can be replayed deterministically. */
  reseed(seed: string): void;
}
