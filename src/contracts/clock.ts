import type { ClockState } from '../types/index.js';

/**
 * Accelerated workday clock. Simulated time runs at `accel` simulated seconds per
 * real second so a full multi-timezone banking day can be exercised in minutes.
 *
 * The runtime is the only caller of `advance`; everything else reads time. Two
 * clocks are exposed on purpose: simulated time drives the arrival model and event
 * timestamps, wall time drives delivery-latency measurement.
 */
export interface Clock {
  /** Current simulated time as epoch milliseconds. */
  now(): number;
  /** Current simulated time as an ISO 8601 string. */
  nowISO(): string;
  /** Current real (wall) time as epoch milliseconds. */
  wallNow(): number;
  /** Full clock snapshot including business phase and weekday. */
  state(): ClockState;
  /**
   * Advance simulated time by `realDeltaMs * accel`. Called once per runtime tick
   * with the real elapsed time since the previous tick. Never moves time backward.
   */
  advance(realDeltaMs: number): void;
  /** Change the acceleration factor mid-run. Must be > 0. */
  setAccel(accel: number): void;
  /** Reset simulated time to `startSimEpochMs` (defaults to real now). */
  reset(startSimEpochMs?: number): void;
}
