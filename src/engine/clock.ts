/**
 * The accelerated workday clock.
 *
 * Simulated time runs at `accel` simulated seconds per real second so a full
 * multi-timezone banking day can be exercised in minutes. Two independent time
 * bases are exposed on purpose: simulated time drives the arrival model and the
 * timestamps stamped onto events, while wall time drives delivery-latency
 * measurement. The runtime is the only caller of `advance`; every other consumer
 * only reads time.
 */

import type { ClockOptions } from '../contracts/factories.js';
import type { Clock } from '../contracts/clock.js';
import type { ClockState, WorkdayPhase } from '../types/index.js';
import { FRANKFURT_TZ, localTimeInfo } from './tz.js';

/**
 * Map a Frankfurt local hour to a business phase. Frankfurt is the HQ reference for
 * phase because the German trading day anchors the group's core hours. Core hours
 * appears twice (morning and afternoon) around the lunch break, which is intended.
 */
function phaseOf(hourFrac: number): WorkdayPhase {
  if (hourFrac < 5) return 'overnight';
  if (hourFrac < 8) return 'pre_market';
  if (hourFrac < 9.5) return 'market_open';
  if (hourFrac < 12) return 'core_hours';
  if (hourFrac < 13.5) return 'lunch';
  if (hourFrac < 16.5) return 'core_hours';
  if (hourFrac < 18.5) return 'market_close';
  return 'evening';
}

/**
 * Create an accelerated workday clock.
 *
 * @param options.accel Simulated seconds per real second. Must be greater than 0.
 * @param options.startSimEpochMs Simulated epoch to start at; defaults to real now.
 * @throws Error when `accel` is not a positive finite number.
 */
export function createClock(options: ClockOptions): Clock {
  let accel = options.accel;
  if (!(accel > 0) || !Number.isFinite(accel)) {
    throw new Error(`Clock accel must be a positive finite number, got ${accel}`);
  }

  let simEpochMs = options.startSimEpochMs ?? Date.now();

  const clock: Clock = {
    now(): number {
      return simEpochMs;
    },
    nowISO(): string {
      return new Date(simEpochMs).toISOString();
    },
    wallNow(): number {
      return Date.now();
    },
    advance(realDeltaMs: number): void {
      // Never move simulated time backward. A non-positive or non-finite delta (a
      // clock adjustment, a paused tick, a scheduler hiccup) is ignored rather than
      // rewinding history, which would corrupt event ordering and latency math.
      if (!Number.isFinite(realDeltaMs) || realDeltaMs <= 0) return;
      simEpochMs += realDeltaMs * accel;
    },
    setAccel(nextAccel: number): void {
      if (!(nextAccel > 0) || !Number.isFinite(nextAccel)) {
        throw new Error(`Clock accel must be a positive finite number, got ${nextAccel}`);
      }
      accel = nextAccel;
    },
    reset(startSimEpochMs?: number): void {
      simEpochMs = startSimEpochMs ?? Date.now();
    },
    state(): ClockState {
      const info = localTimeInfo(FRANKFURT_TZ, simEpochMs);
      return {
        simEpochMs,
        simISO: new Date(simEpochMs).toISOString(),
        wallEpochMs: Date.now(),
        accel,
        phase: phaseOf(info.hourFrac),
        weekday: info.weekday,
        // Business day is Monday to Friday in Frankfurt. Public holidays are not
        // modeled; a scenario that needs them can shape traffic via its weights.
        isBusinessDay: info.weekday >= 1 && info.weekday <= 5,
      };
    },
  };

  return clock;
}
