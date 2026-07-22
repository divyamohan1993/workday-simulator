import { describe, it, expect } from 'vitest';
import { createClock } from './clock.js';

const BASE = Date.UTC(2026, 5, 16, 8, 30, 0); // Berlin 10:30, Tuesday

describe('createClock', () => {
  it('advances simulated time by realDelta * accel', () => {
    const clock = createClock({ accel: 60, startSimEpochMs: BASE });
    clock.advance(1000);
    expect(clock.now()).toBe(BASE + 60_000);
    clock.advance(500);
    expect(clock.now()).toBe(BASE + 90_000);
  });

  it('never moves simulated time backward', () => {
    const clock = createClock({ accel: 10, startSimEpochMs: BASE });
    clock.advance(1000);
    const after = clock.now();
    clock.advance(-5000);
    clock.advance(Number.NaN);
    clock.advance(0);
    expect(clock.now()).toBe(after);
  });

  it('honors a mid-run acceleration change', () => {
    const clock = createClock({ accel: 10, startSimEpochMs: BASE });
    clock.advance(1000); // +10s
    clock.setAccel(100);
    clock.advance(1000); // +100s
    expect(clock.now()).toBe(BASE + 10_000 + 100_000);
  });

  it('rejects a non-positive acceleration', () => {
    expect(() => createClock({ accel: 0 })).toThrow();
    expect(() => createClock({ accel: -1 })).toThrow();
    const clock = createClock({ accel: 1, startSimEpochMs: BASE });
    expect(() => clock.setAccel(0)).toThrow();
  });

  it('resets simulated time', () => {
    const clock = createClock({ accel: 60, startSimEpochMs: BASE });
    clock.advance(10_000);
    clock.reset(BASE);
    expect(clock.now()).toBe(BASE);
  });

  it('reports the Frankfurt business phase, weekday and business day', () => {
    const core = createClock({ accel: 1, startSimEpochMs: BASE });
    const stateCore = core.state();
    expect(stateCore.phase).toBe('core_hours');
    expect(stateCore.weekday).toBe(2); // Tuesday
    expect(stateCore.isBusinessDay).toBe(true);
    expect(stateCore.accel).toBe(1);

    const overnight = createClock({ accel: 1, startSimEpochMs: Date.UTC(2026, 5, 16, 1, 0, 0) }); // Berlin 03:00
    expect(overnight.state().phase).toBe('overnight');

    const marketOpen = createClock({ accel: 1, startSimEpochMs: Date.UTC(2026, 5, 16, 6, 0, 0) }); // Berlin 08:00
    expect(marketOpen.state().phase).toBe('market_open');

    const saturday = createClock({ accel: 1, startSimEpochMs: Date.UTC(2026, 5, 20, 8, 30, 0) });
    expect(saturday.state().isBusinessDay).toBe(false);
  });

  it('exposes ISO simulated time and wall time', () => {
    const clock = createClock({ accel: 1, startSimEpochMs: BASE });
    expect(clock.nowISO()).toBe(new Date(BASE).toISOString());
    expect(Math.abs(clock.wallNow() - Date.now())).toBeLessThan(1000);
  });
});
