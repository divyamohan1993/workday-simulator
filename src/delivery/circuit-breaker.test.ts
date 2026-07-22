import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from './circuit-breaker.js';

function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('CircuitBreaker', () => {
  it('opens after the configured consecutive failures', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 3, openMs: 1_000, halfOpenMaxProbes: 1, now: clock.now });

    expect(breaker.current).toBe('closed');
    expect(breaker.tryPass().allowed).toBe(true);

    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.current).toBe('closed'); // 2 < 3
    expect(breaker.tryPass().allowed).toBe(true);

    breaker.onFailure(); // 3rd consecutive
    expect(breaker.current).toBe('open');
    expect(breaker.tryPass().allowed).toBe(false);
  });

  it('a success resets the consecutive-failure count', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 3, openMs: 1_000, halfOpenMaxProbes: 1, now: clock.now });
    breaker.onFailure();
    breaker.onFailure();
    breaker.onSuccess();
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.current).toBe('closed');
  });

  it('admits a single probe after the cool-down and closes on probe success', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 2, openMs: 1_000, halfOpenMaxProbes: 1, now: clock.now });
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.current).toBe('open');

    clock.advance(999);
    expect(breaker.tryPass().allowed).toBe(false); // still cooling down

    clock.advance(1); // cool-down elapsed
    const gate = breaker.tryPass();
    expect(gate).toEqual({ allowed: true, probe: true });
    expect(breaker.current).toBe('half_open');
    // A concurrent second caller is denied while the lone probe is outstanding.
    expect(breaker.tryPass().allowed).toBe(false);

    breaker.onSuccess();
    expect(breaker.current).toBe('closed');
    expect(breaker.tryPass()).toEqual({ allowed: true, probe: false });
  });

  it('re-opens immediately when the half-open probe fails', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 2, openMs: 1_000, halfOpenMaxProbes: 1, now: clock.now });
    breaker.onFailure();
    breaker.onFailure();
    clock.advance(1_000);
    expect(breaker.tryPass().probe).toBe(true); // half-open probe admitted

    breaker.onFailure(); // probe fails
    expect(breaker.current).toBe('open');
    // The cool-down restarts from the re-open moment.
    expect(breaker.tryPass().allowed).toBe(false);
    clock.advance(1_000);
    expect(breaker.tryPass().allowed).toBe(true);
  });
});
