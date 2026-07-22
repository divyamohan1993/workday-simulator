import { beforeEach, describe, expect, it } from 'vitest';
import type { RunState, TelemetryFrame, WorkdayEvent } from '@/types/api';
import { TELEMETRY_LIMITS } from '@/lib/constants';
import { useTelemetryStore } from '@/store/telemetry-store';

function makeEvent(id: string): WorkdayEvent {
  return {
    id,
    kind: 'login.success',
    category: 'AUTH',
    timestamp: '2026-07-22T09:00:00.000Z',
    emittedAtWall: '2026-07-22T09:00:00.000Z',
    correlationId: `corr-${id}`,
    severity: 'info',
    actor: { kind: 'system', id: 'sys', component: 'auth' },
    location: 'FFT',
    division: 'Operations',
    seq: 1,
    payload: {},
  };
}

function makeFrame(overrides: Partial<TelemetryFrame> = {}): TelemetryFrame {
  return {
    clock: {
      simEpochMs: Date.parse('2026-07-22T09:00:00.000Z'),
      simISO: '2026-07-22T09:00:00.000Z',
      wallEpochMs: Date.now(),
      accel: 60,
      phase: 'core_hours',
      weekday: 3,
      isBusinessDay: true,
    },
    currentRps: 100,
    targetRps: 120,
    latency: { p50: 10, p95: 40, p99: 80, max: 120, count: 100 },
    errorRate: 0.01,
    eventMix: { byCategory: { AUTH: 10, JML: 2, ACCESS: 4, TXN: 8, COMPLIANCE: 1 }, byKind: {} },
    receiver: {
      queueDepth: 0,
      provisioned: 10,
      failed: 0,
      sodViolations: 0,
      orphans: 0,
      dormant: 0,
      avgProvisionMs: 25,
      byConnector: {},
      totalIngested: 10,
    },
    delivery: {
      currentRps: 100,
      targetRps: 120,
      inFlight: 2,
      queueDepth: 0,
      circuit: 'closed',
      deliveredTotal: 100,
      failedTotal: 0,
      droppedTotal: 0,
      latency: { p50: 10, p95: 40, p99: 80, max: 120, count: 100 },
    },
    recentEvents: [],
    activeChaos: [],
    run: null,
    frameSeq: 1,
    emittedAt: new Date().toISOString(),
    ...overrides,
  };
}

const sampleRun: RunState = {
  id: 'run-1',
  scenarioId: 'sc-1',
  targetId: 'tg-1',
  status: 'running',
  elapsedSec: 5,
  currentRps: 100,
  targetRps: 120,
  counters: { generated: 100, delivered: 100, failed: 0, dropped: 0, byCategory: { AUTH: 10, JML: 2, ACCESS: 4, TXN: 8, COMPLIANCE: 1 } },
  activeChaos: [],
  seed: 'seed-1',
};

describe('telemetry store ingestFrame', () => {
  beforeEach(() => {
    useTelemetryStore.getState().reset();
  });

  it('merges recentEvents newest-first, deduped by id, across frames', () => {
    const store = useTelemetryStore.getState();
    store.ingestFrame(makeFrame({ recentEvents: [makeEvent('e3'), makeEvent('e2'), makeEvent('e1')] }));
    expect(useTelemetryStore.getState().ticker.map((e) => e.id)).toEqual(['e3', 'e2', 'e1']);

    // Next frame overlaps e3 and adds e5, e4 (newest-first).
    store.ingestFrame(makeFrame({ recentEvents: [makeEvent('e5'), makeEvent('e4'), makeEvent('e3')] }));
    expect(useTelemetryStore.getState().ticker.map((e) => e.id)).toEqual(['e5', 'e4', 'e3', 'e2', 'e1']);
  });

  it('caps the chart points buffer at the configured maximum', () => {
    const store = useTelemetryStore.getState();
    for (let i = 0; i < TELEMETRY_LIMITS.maxFrames + 10; i += 1) {
      store.ingestFrame(makeFrame({ frameSeq: i }));
    }
    expect(useTelemetryStore.getState().points).toHaveLength(TELEMETRY_LIMITS.maxFrames);
  });

  it('tracks the run carried on the frame', () => {
    useTelemetryStore.getState().ingestFrame(makeFrame({ run: sampleRun }));
    expect(useTelemetryStore.getState().run?.id).toBe('run-1');
  });

  it('caps the ticker ring', () => {
    const store = useTelemetryStore.getState();
    for (let i = 0; i < TELEMETRY_LIMITS.maxTickerEvents + 20; i += 1) {
      store.ingestFrame(makeFrame({ recentEvents: [makeEvent(`ev-${i}`)] }));
    }
    expect(useTelemetryStore.getState().ticker.length).toBeLessThanOrEqual(TELEMETRY_LIMITS.maxTickerEvents);
  });
});
