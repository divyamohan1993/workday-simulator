/**
 * Shared test fixtures for the events module.
 *
 * Lives under __tests__ so the production build excludes it (tsconfig.build ignores
 * `__tests__/**`) while colocated `*.test.ts` files import it. Vitest only collects
 * `*.test.ts`, so nothing here runs as a test.
 *
 * Determinism hygiene: the clock is FIXED (constant `now`, `nowISO` and `wallNow`) so
 * `emittedAtWall` and every derived timestamp are reproducible across runs; each test
 * that compares two runs must seed a FRESH pool per side, because `pickActive` advances
 * the pool's sampling RNG.
 */

import { pino } from 'pino';
import type { Logger } from 'pino';
import type { Clock, GenerationContext, IdentityPool } from '../../contracts/index.js';
import { createIdentityPool } from '../../domain/index.js';
import type { ChaosInjectorKind, ClockState } from '../../types/index.js';

/** A logger that emits nothing, so tests stay quiet. */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

/** A weekday mid-morning Frankfurt instant, so active humans are plentiful. */
export const FIXED_SIM_ISO = '2026-06-15T09:30:00.000Z';
const FIXED_SIM_MS = Date.parse(FIXED_SIM_ISO);
const FIXED_WALL_MS = Date.parse('2026-06-15T09:30:01.000Z');

/**
 * A clock stub frozen at a fixed simulated and wall instant. Only `now`, `nowISO` and
 * `wallNow` are exercised by the generators; the rest satisfy the interface.
 */
export function fixedClock(simMs: number = FIXED_SIM_MS): Clock {
  const state: ClockState = {
    simEpochMs: simMs,
    simISO: new Date(simMs).toISOString(),
    wallEpochMs: FIXED_WALL_MS,
    accel: 60,
    phase: 'core_hours',
    weekday: 1,
    isBusinessDay: true,
  };
  return {
    now: () => simMs,
    nowISO: () => new Date(simMs).toISOString(),
    wallNow: () => FIXED_WALL_MS,
    state: () => state,
    advance: () => undefined,
    setAccel: () => undefined,
    reset: () => undefined,
  };
}

/** Create and seed an identity pool for tests. */
export function seededPool(size = 3000, seed = 'events-test-seed'): IdentityPool {
  const pool = createIdentityPool({ logger: silentLogger() });
  pool.seed(size, seed);
  return pool;
}

/**
 * Build a generation context over a pool and clock, with a monotonic sequence source.
 * The runtime supplies no correlation on the context, so this mirrors that.
 */
export function makeCtx(
  pool: IdentityPool,
  clock: Clock = fixedClock(),
  overrides: Partial<Pick<GenerationContext, 'activeChaos' | 'correlationId' | 'causationId' | 'runId'>> = {},
): GenerationContext {
  let seq = 0;
  return {
    clock,
    pool,
    runId: overrides.runId ?? 'test-run',
    nextSeq: () => (seq += 1),
    correlationId: overrides.correlationId,
    causationId: overrides.causationId,
    activeChaos: overrides.activeChaos ?? ([] as ChaosInjectorKind[]),
  };
}
