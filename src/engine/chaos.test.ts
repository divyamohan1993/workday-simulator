import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';
import type { IdentityPool } from '../contracts/identity-pool.js';
import type {
  ChaosInjectorConfig,
  ChaosInjectorKind,
  Employee,
  EventKind,
  WorkdayEvent,
} from '../types/index.js';
import { EVENT_CATEGORY } from '../types/index.js';
import { CHAOS_INJECTOR_CATALOG, createChaosInjector, type ChaosContext } from './chaos.js';
import { createPrng } from './prng.js';

const ALL_CHAOS_KINDS: ChaosInjectorKind[] = [
  'credential_stuffing',
  'mass_termination_reorg',
  'insider_threat',
  'audit_season_surge',
  'ransomware_lateral',
  'payroll_batch',
  'mass_password_reset',
  'connector_outage',
];

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

function fakeEvent(kind: EventKind): WorkdayEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    category: EVENT_CATEGORY[kind],
    kind,
    timestamp: new Date().toISOString(),
    emittedAtWall: new Date().toISOString(),
    correlationId: 'corr',
    severity: 'info',
    actor: { kind: 'system', id: 'sys', component: 'generator' },
    location: 'FFT',
    division: 'Operations',
    delivery: { operation: 'noop', resource: 'event', idempotencyKey: 'k', priority: 'normal', requiresApproval: false },
    seq: 1,
    payload: {},
  } as unknown as WorkdayEvent;
}

function fakeEmployee(id: string): Employee {
  return {
    id,
    employeeId: `DB${id}`,
    firstName: 'Ada',
    lastName: 'Byron',
    displayName: 'Ada Byron',
    email: 'ada@example.test',
    username: 'abyron',
    managerId: null,
    division: 'Technology, Data & Innovation',
    jobFamily: 'Software Engineering',
    grade: 'VP',
    type: 'FTE',
    status: 'active',
    location: 'LDN',
    legalEntity: 'Deutsche Bank AG, London Branch',
    costCenter: 'CC-TDI-1',
    entitlements: [],
    startDate: '2020-01-01',
    attributes: {},
    isNonHuman: false,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
  };
}

function makeCtx(overrides: Partial<ChaosContext> = {}): { ctx: ChaosContext; emitted: WorkdayEvent[] } {
  const emitted: WorkdayEvent[] = [];
  const pool = { get: () => undefined } as unknown as IdentityPool;
  const ctx: ChaosContext = {
    pool,
    prng: createPrng('chaos-test'),
    logger: silentLogger,
    activeChaosKinds: [],
    generate: (kind) => fakeEvent(kind),
    emit: (event) => emitted.push(event),
    sampleEmployees: () => [],
    ...overrides,
  };
  return { ctx, emitted };
}

function config(kind: ChaosInjectorKind, partial: Partial<ChaosInjectorConfig> = {}): ChaosInjectorConfig {
  return {
    kind,
    enabled: true,
    intensity: 0.8,
    params: {},
    ...partial,
  };
}

describe('CHAOS_INJECTOR_CATALOG', () => {
  it('exposes all eight injectors in the REST-contract shape', () => {
    expect(CHAOS_INJECTOR_CATALOG).toHaveLength(8);
    const kinds = CHAOS_INJECTOR_CATALOG.map((entry) => entry.kind);
    expect(new Set(kinds)).toEqual(new Set(ALL_CHAOS_KINDS));
    for (const entry of CHAOS_INJECTOR_CATALOG) {
      expect(typeof entry.description).toBe('string');
      expect(entry.description.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.params)).toBe(true);
      for (const param of entry.params) {
        expect(typeof param.name).toBe('string');
        expect(['number', 'string', 'boolean']).toContain(param.type);
        expect(param.default).toBeDefined();
      }
    }
  });
});

describe('createChaosInjector continuous modifiers', () => {
  it('contributes a rate multiplier and mix bias only within its window', () => {
    const injector = createChaosInjector(config('credential_stuffing', { startAtSec: 5, durationSec: 10, intensity: 0.8 }));

    expect(injector.isActive(3)).toBe(false);
    expect(injector.isActive(7)).toBe(true);
    expect(injector.isActive(20)).toBe(false);
    expect(injector.hasExpired(20)).toBe(true);

    expect(injector.rateMultiplier(3)).toBe(1);
    expect(injector.rateMultiplier(7)).toBeGreaterThan(1);

    expect(injector.mixBias(3).size).toBe(0);
    const bias = injector.mixBias(7);
    expect((bias.get('login.failure') ?? 0)).toBeGreaterThan(1);
  });

  it('credits ambient events only for its signature kinds', () => {
    const injector = createChaosInjector(config('credential_stuffing'));
    injector.creditAmbient('login.failure');
    injector.creditAmbient('payment.sepa');
    expect(injector.eventsInjected).toBe(1);
  });

  it('never activates when disabled or at zero intensity', () => {
    expect(createChaosInjector(config('credential_stuffing', { enabled: false })).isActive(7)).toBe(false);
    expect(createChaosInjector(config('credential_stuffing', { intensity: 0 })).isActive(7)).toBe(false);
  });
});

describe('createChaosInjector bursts', () => {
  it('emits a cohort on activation for a burst injector', () => {
    const injector = createChaosInjector(
      config('mass_password_reset', { startAtSec: 2, durationSec: 5, intensity: 0.5, params: { targetCount: 10 } }),
    );
    const { ctx, emitted } = makeCtx();

    injector.tick(ctx, 1, 25); // before the window: nothing
    expect(emitted).toHaveLength(0);

    injector.tick(ctx, 3, 25); // inside the window: activate and emit round(10 * 0.5) = 5
    expect(emitted.length).toBe(5);
    expect(injector.eventsInjected).toBe(5);
    for (const event of emitted) expect(event.kind).toBe('password.reset');

    const before = emitted.length;
    injector.tick(ctx, 4, 25); // no per-tick behavior for this injector
    expect(emitted.length).toBe(before);
  });

  it('retargets an insider burst onto a single victim and clears the subject', () => {
    const victim = fakeEmployee('victim-1');
    const injector = createChaosInjector(
      config('insider_threat', { startAtSec: 0, durationSec: 30, intensity: 1, params: { downloadEvents: 5 } }),
    );
    const { ctx, emitted } = makeCtx({
      sampleEmployees: () => [victim],
      pool: { get: (id: string) => (id === victim.id ? victim : undefined) } as unknown as IdentityPool,
    });

    injector.tick(ctx, 0, 25); // activate: establishes the session on the victim
    expect(emitted.length).toBeGreaterThanOrEqual(2);
    for (const event of emitted) {
      expect(event.actor.kind).toBe('employee');
      expect(event.actor.id).toBe(victim.id);
      expect(event.subject).toBeUndefined();
      expect(event.location).toBe(victim.location);
    }
  });
});

describe('toActiveChaos', () => {
  it('reports the telemetry view with absolute times', () => {
    const injector = createChaosInjector(config('audit_season_surge', { startAtSec: 10, durationSec: 60, intensity: 0.5 }));
    const runStart = Date.UTC(2026, 5, 16, 8, 0, 0);
    const view = injector.toActiveChaos(runStart);
    expect(view.kind).toBe('audit_season_surge');
    expect(view.intensity).toBe(0.5);
    expect(new Date(view.startedAt).getTime()).toBe(runStart + 10_000);
    expect(new Date(view.endsAt ?? '').getTime()).toBe(runStart + 70_000);
    expect(view.eventsInjected).toBe(0);
  });
});
