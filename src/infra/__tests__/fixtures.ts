/**
 * Shared, valid domain fixtures for the infra tests. Lives under `__tests__/` so it
 * is excluded from the production build (`tsconfig.build.json`) yet still type-checked
 * by `tsc --noEmit`. Every builder returns a complete object that satisfies the frozen
 * types, with cheap overrides for the fields a given test cares about.
 */

import pino from 'pino';
import type { Logger } from 'pino';
import type {
  ClockState,
  DeliveryResult,
  DeliveryStats,
  DeliveryTarget,
  EventCategory,
  EventKind,
  LoginSuccessPayload,
  ReceiverStats,
  RunState,
  RunSummary,
  ScenarioConfig,
  WorkdayEvent,
} from '../../types/index.js';
import {
  ALL_EVENT_CATEGORIES,
  ALL_LOCATIONS,
  EVENT_CATEGORY,
} from '../../types/index.js';
import type { FrameContext } from '../../contracts/metrics-registry.js';

/** A pino logger that emits nothing, for stores under test. */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

/** Full per-location weight map (all eight sites present). */
function byLocation(value = 1): Record<string, number> {
  const out: Record<string, number> = {};
  for (const loc of ALL_LOCATIONS) out[loc] = value;
  return out;
}

/** Full per-category weight/count map (all five categories present). */
function byCategory(value = 0): Record<EventCategory, number> {
  const out = {} as Record<EventCategory, number>;
  for (const cat of ALL_EVENT_CATEGORIES) out[cat] = value;
  return out;
}

export function makeScenario(overrides: Partial<ScenarioConfig> = {}): ScenarioConfig {
  const iso = '2026-07-22T09:00:00.000Z';
  return {
    id: 'scn-1',
    name: 'Baseline Frankfurt Morning',
    description: 'Steady-state morning traffic',
    baselineRps: 50,
    maxRps: 2000,
    workdayAccel: 60,
    timezoneWeights: { byLocation: byLocation(1) as ScenarioConfig['timezoneWeights']['byLocation'] },
    eventMix: { byCategory: { AUTH: 5, JML: 1, ACCESS: 2, TXN: 3, COMPLIANCE: 1 } },
    chaos: [],
    targetId: 'tgt-builtin',
    createdAt: iso,
    updatedAt: iso,
    ...overrides,
  };
}

export function makeTarget(overrides: Partial<DeliveryTarget> = {}): DeliveryTarget {
  const iso = '2026-07-22T09:00:00.000Z';
  return {
    id: 'tgt-1',
    name: 'Reference OneIM',
    kind: 'scim',
    url: 'http://localhost:8477/scim/v2',
    auth: { kind: 'bearer', token: 'super-secret-token' }, // pragma: allowlist secret (deterministic test fixture, not a real credential)
    headers: {},
    rateLimit: { rps: 500, burst: 100 },
    concurrency: 8,
    retry: {
      maxRetries: 3,
      baseDelayMs: 100,
      maxDelayMs: 5000,
      jitter: true,
      retryableStatuses: [429, 502, 503, 504],
    },
    queueHighWater: 10_000,
    overflowPolicy: 'drop_oldest',
    builtIn: false,
    createdAt: iso,
    updatedAt: iso,
    ...overrides,
  };
}

export function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    id: 'run-1',
    scenarioId: 'scn-1',
    targetId: 'tgt-builtin',
    status: 'running',
    startedAt: '2026-07-22T09:00:00.000Z',
    elapsedSec: 0,
    currentRps: 0,
    targetRps: 50,
    counters: { generated: 0, delivered: 0, failed: 0, dropped: 0, byCategory: byCategory(0) },
    activeChaos: [],
    seed: 'seed-abc',
    ...overrides,
  };
}

export function makeDeliveryStats(overrides: Partial<DeliveryStats> = {}): DeliveryStats {
  return {
    currentRps: 0,
    targetRps: 0,
    inFlight: 0,
    queueDepth: 0,
    circuit: 'closed',
    deliveredTotal: 0,
    failedTotal: 0,
    droppedTotal: 0,
    latency: { p50: 0, p95: 0, p99: 0, max: 0, count: 0 },
    ...overrides,
  };
}

export function makeReceiverStats(overrides: Partial<ReceiverStats> = {}): ReceiverStats {
  return {
    queueDepth: 0,
    provisioned: 0,
    failed: 0,
    sodViolations: 0,
    orphans: 0,
    dormant: 0,
    avgProvisionMs: 0,
    byConnector: {},
    totalIngested: 0,
    ...overrides,
  };
}

export function makeRunSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: 'run-1',
    scenarioId: 'scn-1',
    targetId: 'tgt-builtin',
    status: 'completed',
    startedAt: '2026-07-22T09:00:00.000Z',
    endedAt: '2026-07-22T09:10:00.000Z',
    durationSec: 600,
    totals: { generated: 100, delivered: 95, failed: 3, dropped: 2, byCategory: byCategory(20) },
    byKind: { 'login.success': 40 },
    latency: { p50: 12, p95: 40, p99: 80, max: 120, count: 95 },
    errorRate: 0.03,
    delivery: makeDeliveryStats({ deliveredTotal: 95, failedTotal: 3, droppedTotal: 2 }),
    receiver: makeReceiverStats({ provisioned: 95, totalIngested: 100 }),
    chaosFired: [],
    seed: 'seed-abc',
    ...overrides,
  };
}

const LOGIN_PAYLOAD: LoginSuccessPayload = {
  ip: '10.0.0.1',
  userAgent: 'Mozilla/5.0',
  method: 'password',
  geo: { city: 'Frankfurt', country: 'DE', lat: 50.11, lng: 8.68 },
  deviceId: 'dev-1',
  sessionId: 'sess-1',
  riskScore: 3,
};

/** A valid `login.success` event; override any base field via `overrides`. */
export function makeEvent(
  overrides: Partial<WorkdayEvent> = {},
): WorkdayEvent {
  const base: WorkdayEvent = {
    id: 'evt-1',
    kind: 'login.success',
    category: 'AUTH',
    timestamp: '2026-07-22T09:00:01.000Z',
    emittedAtWall: '2026-07-22T09:00:01.000Z',
    correlationId: 'corr-1',
    severity: 'info',
    actor: {
      kind: 'employee',
      id: 'emp-1',
      employeeId: 'DB00000001',
      displayName: 'Ada Lovelace',
      email: 'ada.lovelace@db.com',
      division: 'Technology, Data & Innovation',
      location: 'FFT',
      grade: 'VP',
      type: 'FTE',
    },
    location: 'FFT',
    division: 'Technology, Data & Innovation',
    delivery: {
      operation: 'notify',
      resource: 'session',
      idempotencyKey: 'idem-1',
      priority: 'normal',
      requiresApproval: false,
    },
    seq: 1,
    payload: LOGIN_PAYLOAD,
  };
  return { ...base, ...overrides } as WorkdayEvent;
}

/**
 * A minimal event carrying a given kind/category, for mix-count assertions. The
 * payload stays a login payload (the metrics registry never reads it), so this is a
 * cast the tests own.
 */
export function makeEventWith(kind: EventKind, seq: number): WorkdayEvent {
  return makeEvent({ kind, category: EVENT_CATEGORY[kind], seq } as Partial<WorkdayEvent>);
}

export function makeDeliveryResult(overrides: Partial<DeliveryResult> = {}): DeliveryResult {
  return {
    eventId: 'evt-1',
    correlationId: 'corr-1',
    targetId: 'tgt-builtin',
    kind: 'scim',
    outcome: 'delivered',
    attempts: 1,
    latencyMs: 20,
    at: '2026-07-22T09:00:01.050Z',
    ...overrides,
  };
}

export function makeClockState(overrides: Partial<ClockState> = {}): ClockState {
  return {
    simEpochMs: Date.parse('2026-07-22T09:00:00.000Z'),
    simISO: '2026-07-22T09:00:00.000Z',
    wallEpochMs: Date.parse('2026-07-22T09:00:00.000Z'),
    accel: 60,
    phase: 'core_hours',
    weekday: 3,
    isBusinessDay: true,
    ...overrides,
  };
}

export function makeFrameContext(overrides: Partial<FrameContext> = {}): FrameContext {
  return {
    clock: makeClockState(),
    run: null,
    activeChaos: [],
    frameSeq: 1,
    ...overrides,
  };
}
