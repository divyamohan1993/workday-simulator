import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/schema.js';
import type { ArrivalProcess } from '../contracts/arrival.js';
import type { DeliveryAdapter, DeliveryAdapterFactory } from '../contracts/delivery-adapter.js';
import type { EventGenerator, GenerationContext } from '../contracts/event-generator.js';
import type { RuntimeDependencies, StoresBundle } from '../contracts/factories.js';
import type { IdentityPool } from '../contracts/identity-pool.js';
import type { FrameContext, MetricsRegistry } from '../contracts/metrics-registry.js';
import type { ScenarioStore, TargetStore } from '../contracts/stores.js';
import type {
  BackpressureState,
  DeliveryStats,
  DeliveryTarget,
  Employee,
  EventKind,
  EventOfKind,
  IdentityRef,
  LatencyHistogram,
  ReceiverStats,
  RunState,
  RunSummary,
  ScenarioConfig,
  TelemetryFrame,
  WorkdayEvent,
} from '../types/index.js';
import { EVENT_CATEGORY } from '../types/index.js';
import { createArrivalProcess } from './arrival.js';
import { createClock } from './clock.js';
import { createEventBus } from './event-bus.js';
import { createScenarioRuntime } from './scenario-runtime.js';

const BASE = Date.UTC(2026, 5, 16, 8, 30, 0); // Berlin 10:30, Tuesday, core hours

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

function emptyHistogram(): LatencyHistogram {
  return { p50: 0, p95: 0, p99: 0, max: 0, count: 0 };
}
function emptyReceiver(): ReceiverStats {
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
  };
}
function emptyDelivery(): DeliveryStats {
  return {
    currentRps: 0,
    targetRps: 0,
    inFlight: 0,
    queueDepth: 0,
    circuit: 'closed',
    deliveredTotal: 0,
    failedTotal: 0,
    droppedTotal: 0,
    latency: emptyHistogram(),
  };
}

function fakeEvent(kind: EventKind, seq: number, timestamp: string): WorkdayEvent {
  return {
    id: `evt-${seq}`,
    category: EVENT_CATEGORY[kind],
    kind,
    timestamp,
    emittedAtWall: timestamp,
    correlationId: `corr-${seq}`,
    severity: 'info',
    actor: { kind: 'system', id: 'sys', component: 'generator' },
    location: 'FFT',
    division: 'Operations',
    delivery: { operation: 'noop', resource: 'event', idempotencyKey: `evt-${seq}`, priority: 'normal', requiresApproval: false },
    seq,
    payload: {},
  } as unknown as WorkdayEvent;
}

function fakeEmployee(id: string): Employee {
  return {
    id,
    employeeId: `DB${id}`,
    firstName: 'Test',
    lastName: 'User',
    displayName: `Test User ${id}`,
    email: `${id}@example.test`,
    username: id,
    managerId: null,
    division: 'Operations',
    jobFamily: 'Operations Processing',
    grade: 'Analyst',
    type: 'FTE',
    status: 'active',
    location: 'FFT',
    legalEntity: 'Deutsche Bank AG',
    costCenter: 'CC-OPS-1',
    entitlements: [],
    startDate: '2021-01-01',
    attributes: {},
    isNonHuman: false,
    createdAt: '2021-01-01T00:00:00.000Z',
    updatedAt: '2021-01-01T00:00:00.000Z',
  };
}

function identityRefOf(e: Employee): IdentityRef {
  return {
    id: e.id,
    employeeId: e.employeeId,
    displayName: e.displayName,
    email: e.email,
    division: e.division,
    location: e.location,
    grade: e.grade,
    type: e.type,
  };
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    NODE_ENV: 'test',
    HOST: '0.0.0.0',
    PORT: 8477,
    DB_PATH: ':memory:',
    ADMIN_TOKEN: 'test-admin-token-0123456789', // pragma: allowlist secret
    LOG_LEVEL: 'silent',
    DEFAULT_TARGET_KIND: 'scim',
    WORKDAY_ACCEL: 60,
    MAX_RPS: 2000,
    SEED: 'runtime-test-seed',
    IDENTITY_POOL_SIZE: 50,
    METRICS_INTERVAL_MS: 200,
    TELEMETRY_RECENT_EVENTS: 10,
    WEB_DIST_PATH: './dist/web',
    CORS_ORIGINS: [],
    ...overrides,
  } as AppConfig;
}

function makeScenario(overrides: Partial<ScenarioConfig> = {}): ScenarioConfig {
  return {
    id: 'scn-1',
    name: 'Test Scenario',
    description: '',
    baselineRps: 200,
    maxRps: 2000,
    workdayAccel: 60,
    timezoneWeights: { byLocation: { FFT: 1, LDN: 0.9, NYC: 0.9, SIN: 0.5, HKG: 0.5, BLR: 0.7, PNQ: 0.5, JAX: 0.4 } },
    eventMix: { byCategory: { AUTH: 1, JML: 0.2, ACCESS: 0.6, TXN: 1, COMPLIANCE: 0.15 } },
    chaos: [],
    targetId: 'tgt-1',
    seed: 'scenario-seed',
    createdAt: new Date(BASE).toISOString(),
    updatedAt: new Date(BASE).toISOString(),
    ...overrides,
  };
}

function makeTarget(overrides: Partial<DeliveryTarget> = {}): DeliveryTarget {
  return {
    id: 'tgt-1',
    name: 'Built-in receiver',
    kind: 'scim',
    url: 'http://localhost/scim',
    auth: { kind: 'none' },
    headers: {},
    rateLimit: { rps: 0, burst: 0 },
    concurrency: 16,
    retry: { maxRetries: 4, baseDelayMs: 200, maxDelayMs: 15_000, jitter: true, retryableStatuses: [429, 502, 503, 504] },
    queueHighWater: 10_000,
    overflowPolicy: 'drop_oldest',
    builtIn: true,
    createdAt: new Date(BASE).toISOString(),
    updatedAt: new Date(BASE).toISOString(),
    ...overrides,
  };
}

function makePool(): IdentityPool {
  let employees: Employee[] = [];
  const pool: IdentityPool = {
    seed(size: number) {
      employees = Array.from({ length: Math.min(size, 50) }, (_unused, i) => fakeEmployee(`emp${i}`));
    },
    size: () => employees.length,
    get: (id: string) => employees.find((e) => e.id === id),
    pickActive: () => employees[0],
    pick: (predicate) => {
      const candidates = predicate ? employees.filter(predicate) : employees;
      return candidates[0];
    },
    ref: (id: string) => {
      const e = employees.find((emp) => emp.id === id);
      return e ? identityRefOf(e) : undefined;
    },
    hire: () => {
      const e = fakeEmployee(`hire${employees.length}`);
      employees.push(e);
      return e;
    },
    transfer: (id: string) => employees.find((e) => e.id === id),
    promote: (id: string) => employees.find((e) => e.id === id),
    changeManager: (id: string) => employees.find((e) => e.id === id),
    setStatus: (id: string) => employees.find((e) => e.id === id),
    grant: (id: string) => employees.find((e) => e.id === id),
    revoke: (id: string) => employees.find((e) => e.id === id),
    all: () => [...employees],
    stats: () => ({}) as unknown as ReturnType<IdentityPool['stats']>,
    sodConflicts: () => [],
  };
  return pool;
}

function makeGenerator(): EventGenerator {
  return {
    generate<K extends EventKind>(kind: K, ctx: GenerationContext): EventOfKind<K> {
      const seq = ctx.nextSeq();
      return fakeEvent(kind, seq, ctx.clock.nowISO()) as unknown as EventOfKind<K>;
    },
    saga: () => [],
  };
}

function makeMetrics(): MetricsRegistry {
  return {
    recordEvent: () => undefined,
    recordDelivery: () => undefined,
    recordReceiver: () => undefined,
    snapshot: (ctx: FrameContext): TelemetryFrame => ({
      clock: ctx.clock,
      currentRps: 0,
      targetRps: 0,
      latency: emptyHistogram(),
      errorRate: 0,
      eventMix: { byCategory: { AUTH: 0, JML: 0, ACCESS: 0, TXN: 0, COMPLIANCE: 0 }, byKind: {} },
      receiver: emptyReceiver(),
      delivery: emptyDelivery(),
      recentEvents: [],
      activeChaos: ctx.activeChaos,
      run: ctx.run,
      frameSeq: ctx.frameSeq,
      emittedAt: new Date().toISOString(),
    }),
    latency: () => emptyHistogram(),
    currentRps: () => 0,
    samples: () => [],
    reset: () => undefined,
  };
}

function makeStores() {
  const runs = new Map<string, RunState>();
  const summaries = new Map<string, RunSummary>();
  const scenarios = { create: (s) => s, update: () => undefined, get: () => undefined, list: (limit, offset) => ({ items: [], total: 0, limit, offset }), remove: () => false } as ScenarioStore;
  const targets = { create: (t) => t, update: () => undefined, get: () => undefined, list: (limit, offset) => ({ items: [], total: 0, limit, offset }), remove: () => false } as TargetStore;
  const bundle: StoresBundle = {
    runs: {
      create: (run) => {
        runs.set(run.id, run);
      },
      update: (id, patch) => {
        const current = runs.get(id);
        if (current) runs.set(id, { ...current, ...patch });
      },
      get: (id) => runs.get(id),
      list: (limit, offset) => {
        const items = [...runs.values()];
        return { items, total: items.length, limit, offset };
      },
      saveSummary: (summary) => {
        summaries.set(summary.runId, summary);
      },
      getSummary: (id) => summaries.get(id),
    },
    scenarios,
    targets,
    close: () => undefined,
  };
  return { bundle, getSummary: (id: string) => summaries.get(id), getRun: (id: string) => runs.get(id) };
}

function makeDelivery() {
  let saturated = false;
  const submitted: WorkdayEvent[] = [];
  const healthy = (): BackpressureState => ({
    queueDepth: 0,
    highWater: 1000,
    inFlight: 0,
    saturated: false,
    circuit: 'closed',
    droppedTotal: 0,
    deliveredTotal: submitted.length,
    failedTotal: 0,
  });
  const congested = (): BackpressureState => ({
    queueDepth: 1000,
    highWater: 1000,
    inFlight: 50,
    saturated: true,
    circuit: 'closed',
    droppedTotal: 0,
    deliveredTotal: 0,
    failedTotal: 0,
  });
  const adapter: DeliveryAdapter = {
    kind: 'scim',
    target: makeTarget(),
    start: async () => undefined,
    submit: (event) => {
      submitted.push(event);
      return true;
    },
    onResult: () => () => undefined,
    pressure: () => (saturated ? congested() : healthy()),
    flush: async () => undefined,
    stop: async () => undefined,
  };
  const factory: DeliveryAdapterFactory = { create: () => adapter };
  return { factory, setSaturated: (value: boolean) => { saturated = value; }, submitted };
}

function makeArrival(): ArrivalProcess {
  const BASE_GAP = 8;
  return {
    rateAt: () => 400,
    nextInterArrivalMs: (_sim: number, throttle = 1) => {
      const t = throttle <= 0 ? 0.0001 : throttle;
      return BASE_GAP / t;
    },
    reseed: () => undefined,
  };
}

function makeHarness(configOverrides: Partial<AppConfig> = {}) {
  const config = makeConfig(configOverrides);
  const stores = makeStores();
  const delivery = makeDelivery();
  const deps: RuntimeDependencies = {
    config,
    logger: silentLogger,
    bus: createEventBus({ logger: silentLogger }),
    pool: makePool(),
    generator: makeGenerator(),
    metrics: makeMetrics(),
    stores: stores.bundle,
    deliveryFactory: delivery.factory,
    createClock,
    createArrival: () => makeArrival(),
  };
  return { deps, stores, delivery };
}

describe('createScenarioRuntime', () => {
  it('starts and stops, persisting a run summary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE));
    try {
      const harness = makeHarness();
      const runtime = createScenarioRuntime(harness.deps);
      const started = await runtime.start(makeScenario(), makeTarget());
      expect(started.status).toBe('running');
      expect(runtime.state()?.id).toBe(started.id);

      await vi.advanceTimersByTimeAsync(500);
      expect((runtime.state()?.counters.generated ?? 0)).toBeGreaterThan(0);

      const summary = await runtime.stop();
      expect(summary.runId).toBe(started.id);
      expect(summary.status).toBe('completed');
      expect(harness.stores.getSummary(started.id)).toBeDefined();
      expect(runtime.state()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('throttles generation when delivery is saturated', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE));
    try {
      const healthyHarness = makeHarness();
      const healthyRuntime = createScenarioRuntime(healthyHarness.deps);
      await healthyRuntime.start(makeScenario(), makeTarget());
      await vi.advanceTimersByTimeAsync(2000);
      const healthyGenerated = healthyRuntime.state()?.counters.generated ?? 0;
      await healthyRuntime.stop();

      const saturatedHarness = makeHarness();
      saturatedHarness.delivery.setSaturated(true);
      const saturatedRuntime = createScenarioRuntime(saturatedHarness.deps);
      await saturatedRuntime.start(makeScenario(), makeTarget());
      await vi.advanceTimersByTimeAsync(2000);
      const saturatedGenerated = saturatedRuntime.state()?.counters.generated ?? 0;
      await saturatedRuntime.stop();

      expect(healthyGenerated).toBeGreaterThan(0);
      expect(saturatedGenerated).toBeLessThan(healthyGenerated * 0.5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('raises the injected count when a chaos injector fires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE));
    try {
      const harness = makeHarness();
      const frames: TelemetryFrame[] = [];
      const runtime = createScenarioRuntime(harness.deps);
      runtime.onFrame((frame) => frames.push(frame));

      const scenario = makeScenario({
        chaos: [
          { kind: 'mass_password_reset', enabled: true, startAtSec: 0, durationSec: 10, intensity: 0.5, params: { targetCount: 20 } },
        ],
      });
      await runtime.start(scenario, makeTarget());
      await vi.advanceTimersByTimeAsync(600);

      expect(runtime.state()?.activeChaos).toContain('mass_password_reset');
      const lastFrame = frames[frames.length - 1];
      expect(lastFrame).toBeDefined();
      const injected = lastFrame?.activeChaos.find((chaos) => chaos.kind === 'mass_password_reset');
      expect(injected).toBeDefined();
      expect(injected?.eventsInjected ?? 0).toBeGreaterThan(0);

      await runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('auto-completes a duration-bounded run', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE));
    try {
      const harness = makeHarness();
      const runtime = createScenarioRuntime(harness.deps);
      const started = await runtime.start(makeScenario({ durationSec: 1 }), makeTarget());

      await vi.advanceTimersByTimeAsync(1500);

      expect(runtime.state()).toBeNull();
      const summary = harness.stores.getSummary(started.id);
      expect(summary?.status).toBe('completed');
      expect((summary?.durationSec ?? 0)).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('injects an ad-hoc chaos scenario immediately', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE));
    try {
      const harness = makeHarness();
      const runtime = createScenarioRuntime(harness.deps);
      await runtime.start(makeScenario(), makeTarget());
      await vi.advanceTimersByTimeAsync(100);

      runtime.injectChaos({ kind: 'audit_season_surge', enabled: true, intensity: 0.6, params: {} });
      await vi.advanceTimersByTimeAsync(100);

      expect(runtime.state()?.activeChaos).toContain('audit_season_surge');
      await runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a second run while one is active', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE));
    try {
      const harness = makeHarness();
      const runtime = createScenarioRuntime(harness.deps);
      await runtime.start(makeScenario(), makeTarget());
      await expect(runtime.start(makeScenario(), makeTarget())).rejects.toThrow(/already active/);
      await runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the last summary when stop is called while idle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE));
    try {
      const harness = makeHarness();
      const runtime = createScenarioRuntime(harness.deps);
      const started = await runtime.start(makeScenario(), makeTarget());
      await vi.advanceTimersByTimeAsync(200);
      const first = await runtime.stop();
      const second = await runtime.stop();
      expect(second.runId).toBe(first.runId);
      expect(second.runId).toBe(started.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it('enforces maxRps as a hard ceiling on the continuous stream under chaos', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE));
    try {
      const harness = makeHarness({ MAX_RPS: 2000 });
      // Use the REAL arrival so the runtime's gap-floor is what bounds the rate, and a
      // high-multiplier injector (credential_stuffing is 6x) that would otherwise
      // overshoot the ceiling.
      const deps: RuntimeDependencies = { ...harness.deps, createArrival: createArrivalProcess };
      const runtime = createScenarioRuntime(deps);
      const scenario = makeScenario({
        baselineRps: 400,
        maxRps: 500,
        chaos: [{ kind: 'credential_stuffing', enabled: true, startAtSec: 0, durationSec: 90, intensity: 1, params: {} }],
      });

      await runtime.start(scenario, makeTarget());
      await vi.advanceTimersByTimeAsync(2000);

      const state = runtime.state();
      const generated = state?.counters.generated ?? 0;
      const elapsed = state?.elapsedSec ?? 1;
      const ratePerSec = generated / elapsed;
      expect(generated).toBeGreaterThan(0);
      // Without the maxRps gap-floor this would run far above 500/s.
      expect(ratePerSec).toBeLessThanOrEqual(500 * 1.3);

      await runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('pauses and resumes generation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE));
    try {
      const harness = makeHarness();
      const runtime = createScenarioRuntime(harness.deps);
      await runtime.start(makeScenario(), makeTarget());
      await vi.advanceTimersByTimeAsync(300);

      runtime.pause();
      expect(runtime.state()?.status).toBe('paused');
      const afterPause = runtime.state()?.counters.generated ?? 0;
      await vi.advanceTimersByTimeAsync(500);
      const whilePaused = runtime.state()?.counters.generated ?? 0;
      expect(whilePaused).toBe(afterPause);

      runtime.resume();
      expect(runtime.state()?.status).toBe('running');
      await vi.advanceTimersByTimeAsync(300);
      expect((runtime.state()?.counters.generated ?? 0)).toBeGreaterThan(whilePaused);

      await runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
