import { describe, expect, it } from 'vitest';
import { createPrng } from './prng.js';
import {
  createThreatScheduler,
  resolveThreatProfile,
  THREAT_INCIDENT_KINDS,
} from './threat-scheduler.js';
import type { ThreatProfile } from '../types/index.js';

const SIM_MIN_MS = 60_000;

interface SpawnedIncident {
  atMin: number;
  kind: string;
  intensity: number;
}

/**
 * Drive the scheduler minute-by-minute over `durationMin` of simulated time. Models each
 * spawned incident as "active" for `activeDurationMin` so the maxConcurrent gate is
 * genuinely exercised; pass a huge active duration to force contention.
 */
function drive(
  seed: string,
  profile: ThreatProfile | undefined,
  durationMin: number,
  activeDurationMin = 0,
): SpawnedIncident[] {
  const sched = createThreatScheduler({ prng: createPrng(seed), profile: resolveThreatProfile(profile) });
  const spawned: SpawnedIncident[] = [];
  const activeUntilMs: number[] = [];
  for (let m = 0; m <= durationMin; m += 1) {
    const simNowMs = m * SIM_MIN_MS;
    const activeCount = activeUntilMs.filter((u) => u > simNowMs).length;
    for (const cfg of sched.due(simNowMs, activeCount)) {
      spawned.push({ atMin: m, kind: cfg.kind, intensity: cfg.intensity });
      activeUntilMs.push(simNowMs + activeDurationMin * SIM_MIN_MS);
    }
  }
  return spawned;
}

describe('createThreatScheduler', () => {
  it('is deterministic for a fixed seed', () => {
    const a = drive('seed:run-1:threat', { enabled: true }, 1440);
    const b = drive('seed:run-1:threat', { enabled: true }, 1440);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('produces a different incident timeline per run id (same base seed)', () => {
    const run1 = drive('base:run-aaaa:threat', { enabled: true }, 1440);
    const run2 = drive('base:run-bbbb:threat', { enabled: true }, 1440);
    // Timing/kinds should differ; compare the serialized timelines.
    expect(JSON.stringify(run1)).not.toEqual(JSON.stringify(run2));
  });

  it('fires roughly day/meanInterval incidents (Poisson band) with no concurrency cap in play', () => {
    // maxConcurrent high + zero active duration -> pure arrival process, mean 60 sim-min.
    const incidents = drive('band:run-x:threat', { enabled: true, maxConcurrent: 8, meanIntervalSimMin: 60 }, 1440, 0);
    // Expected ~24 over 24h; allow a wide Poisson band.
    expect(incidents.length).toBeGreaterThanOrEqual(12);
    expect(incidents.length).toBeLessThanOrEqual(40);
  });

  it('never exceeds maxConcurrent active incidents', () => {
    // maxConcurrent 1 + long active windows: incidents must never overlap in sim time.
    const activeMin = 45;
    const incidents = drive('cap:run-y:threat', { enabled: true, maxConcurrent: 1, meanIntervalSimMin: 20 }, 1440, activeMin);
    for (let i = 1; i < incidents.length; i += 1) {
      const gapMin = incidents[i]!.atMin - incidents[i - 1]!.atMin;
      // With one slot and a 45-min active window, the next incident cannot start until
      // the previous one has cleared its window.
      expect(gapMin).toBeGreaterThanOrEqual(activeMin);
    }
  });

  it('respects kind weights: a zero weight excludes a kind, and a single positive weight is exclusive', () => {
    const onlyInsider = drive(
      'weights:run-z:threat',
      {
        enabled: true,
        maxConcurrent: 8,
        meanIntervalSimMin: 30,
        kindWeights: Object.fromEntries(
          THREAT_INCIDENT_KINDS.map((k) => [k, k === 'insider_threat' ? 1 : 0]),
        ) as ThreatProfile['kindWeights'],
      },
      1440,
      0,
    );
    expect(onlyInsider.length).toBeGreaterThan(0);
    expect(onlyInsider.every((i) => i.kind === 'insider_threat')).toBe(true);
  });

  it('samples intensity within the configured range', () => {
    const incidents = drive(
      'intensity:run-q:threat',
      { enabled: true, maxConcurrent: 8, meanIntervalSimMin: 20, intensityMin: 0.4, intensityMax: 0.6 },
      1440,
      0,
    );
    expect(incidents.length).toBeGreaterThan(0);
    for (const i of incidents) {
      expect(i.intensity).toBeGreaterThanOrEqual(0.4);
      expect(i.intensity).toBeLessThanOrEqual(0.6);
    }
  });

  it('emits nothing before the first (warm-up) interval', () => {
    // At t=0 the very first due() call only arms the schedule; no incident yet.
    const sched = createThreatScheduler({ prng: createPrng('warmup:threat'), profile: resolveThreatProfile({ enabled: true }) });
    expect(sched.due(0, 0)).toEqual([]);
  });
});

describe('resolveThreatProfile', () => {
  it('applies defaults for an empty profile', () => {
    const r = resolveThreatProfile({ enabled: true });
    expect(r.meanIntervalSimMin).toBe(60);
    expect(r.maxConcurrent).toBe(2);
    expect(r.weights).toHaveLength(THREAT_INCIDENT_KINDS.length);
    expect(r.weights.every((w) => w >= 0)).toBe(true);
  });

  it('swaps an inverted intensity range and clamps out-of-range values', () => {
    const r = resolveThreatProfile({ enabled: true, intensityMin: 0.9, intensityMax: 0.2, maxConcurrent: 99, meanIntervalSimMin: 0 });
    expect(r.intensityMin).toBe(0.2);
    expect(r.intensityMax).toBe(0.9);
    expect(r.maxConcurrent).toBe(8);
    expect(r.meanIntervalSimMin).toBe(1);
  });
});
