/**
 * A sliding, per-second window over delivery outcomes, producing a smoothed
 * delivered-events-per-second rate and a recent error rate with bounded memory.
 *
 * WHY per-second buckets over a fixed window rather than an ever-growing timestamp
 * list: memory is O(windowSeconds) regardless of throughput, and both the rate and
 * the error rate reflect only "recent" activity (the last few seconds), which is what
 * the dashboard should show. The window smooths the instantaneous spikes that a raw
 * per-tick count would produce.
 *
 * `nowMs` is passed in on every call so the window is a pure function of wall time
 * and therefore deterministic under test (no hidden `Date.now`).
 *
 * Outcome classification mirrors the runtime's own accounting so the registry's
 * numbers never disagree with `RunState.counters`: `dropped` events were never
 * attempted, so they are counted for context but EXCLUDED from the error rate
 * (error rate = failed / (delivered + failed)).
 */

/** Which windowed counter an observation increments. */
export type RateKind = 'delivered' | 'failed' | 'dropped';

interface Bucket {
  /** The wall-clock second this bucket represents; -1 means unused. */
  sec: number;
  delivered: number;
  failed: number;
  dropped: number;
}

export interface RateWindow {
  /** Record one outcome at wall time `nowMs`. */
  record(kind: RateKind, nowMs: number): void;
  /** Smoothed delivered events per second over the window. */
  rps(nowMs: number): number;
  /** Recent failure fraction, 0..1, excluding dropped (never-attempted) events. */
  errorRate(nowMs: number): number;
  /** Reset all buckets. */
  reset(): void;
}

/**
 * Build a sliding rate window.
 *
 * @param windowSec Number of one-second buckets to average over (>= 1). Default 5.
 * @returns A `RateWindow`.
 */
export function createRateWindow(windowSec = 5): RateWindow {
  const width = Math.max(1, Math.trunc(windowSec));
  const buckets: Bucket[] = Array.from({ length: width }, () => ({
    sec: -1,
    delivered: 0,
    failed: 0,
    dropped: 0,
  }));
  let startSec: number | null = null;

  const indexFor = (sec: number): number => ((sec % width) + width) % width;

  const aggregate = (nowMs: number): { delivered: number; failed: number } => {
    const sec = Math.floor(nowMs / 1000);
    const lo = sec - width + 1;
    let delivered = 0;
    let failed = 0;
    for (const bucket of buckets) {
      if (bucket.sec >= lo && bucket.sec <= sec) {
        delivered += bucket.delivered;
        failed += bucket.failed;
      }
    }
    return { delivered, failed };
  };

  return {
    record(kind: RateKind, nowMs: number): void {
      const sec = Math.floor(nowMs / 1000);
      if (startSec === null) startSec = sec;
      const bucket = buckets[indexFor(sec)];
      if (bucket === undefined) return; // Unreachable: index is always in range.
      if (bucket.sec !== sec) {
        // The slot is being reused for a newer second: clear the stale counts first.
        bucket.sec = sec;
        bucket.delivered = 0;
        bucket.failed = 0;
        bucket.dropped = 0;
      }
      bucket[kind] += 1;
    },

    rps(nowMs: number): number {
      if (startSec === null) return 0;
      const sec = Math.floor(nowMs / 1000);
      const { delivered } = aggregate(nowMs);
      // Average over the seconds actually elapsed, capped at the window width, so the
      // first few seconds of a run are not divided by a full window they have not
      // filled yet.
      const elapsed = sec - startSec + 1;
      const denom = Math.min(width, Math.max(1, elapsed));
      return delivered / denom;
    },

    errorRate(nowMs: number): number {
      const { delivered, failed } = aggregate(nowMs);
      const attempted = delivered + failed;
      return attempted > 0 ? failed / attempted : 0;
    },

    reset(): void {
      for (const bucket of buckets) {
        bucket.sec = -1;
        bucket.delivered = 0;
        bucket.failed = 0;
        bucket.dropped = 0;
      }
      startSec = null;
    },
  };
}
