/**
 * Chaos injectors: composable modifiers layered onto the arrival and event stream.
 *
 * WHY a single generic instance driven by a per-kind spec table (rather than eight
 * bespoke classes): every injector answers the same four questions to the runtime,
 * "am I active", "how much extra rate", "which kinds do I bias", and "emit any
 * targeted burst", so the shared machinery lives once and each scenario is a small
 * declarative spec. Two composition mechanisms cover every case:
 *
 * 1. Continuous modifiers. While active an injector multiplies the arrival rate and
 *    multiplies the mix weight of its signature kinds, and its kind is flagged in the
 *    generation context so the event generator can bias payloads (attacker IPs,
 *    anomalous service activity, off-hours geo). This models sustained pressure like
 *    credential stuffing or a quarter-end audit surge.
 * 2. Discrete bursts. On activation, and optionally each tick, an injector emits a
 *    cohort of fully-formed events built by the real generator so payloads stay
 *    realistic. This models one-shot shocks like a payroll batch, a mass password
 *    reset, or a reorganization's mass termination.
 *
 * Targeting a single identity (the insider-threat pattern) is done by re-stamping the
 * event envelope onto a chosen victim. This is the only contract-legal way to force a
 * specific actor, because the generation context cannot. Re-stamping is restricted to
 * envelope-safe non-JML kinds; JML kinds already mutated the pool for the generator's
 * own pick and must never be retargeted, or identity state would desync from events.
 */

import type { Logger } from 'pino';
import type {
  ActiveChaos,
  ActorRef,
  ChaosInjectorConfig,
  ChaosInjectorKind,
  Employee,
  EventKind,
  IdentityRef,
  WorkdayEvent,
} from '../types/index.js';
import type { IdentityPool } from '../contracts/identity-pool.js';
import { isJmlKind } from './jml.js';
import type { Prng } from './prng.js';

/** A tunable parameter as surfaced to the dashboard's chaos catalog. */
export interface ChaosInjectorCatalogParam {
  name: string;
  type: 'number' | 'string' | 'boolean';
  default: number | string | boolean;
}

/** Catalog entry shape, matching GET /api/chaos/injectors exactly. */
export interface ChaosInjectorCatalogEntry {
  kind: ChaosInjectorKind;
  description: string;
  params: ChaosInjectorCatalogParam[];
}

/**
 * What the runtime provides to an injector so it can build and publish targeted
 * bursts without knowing how the generator or bus are wired.
 */
export interface ChaosContext {
  pool: IdentityPool;
  prng: Prng;
  logger: Logger;
  /** Chaos kinds active this tick, for the generator's payload biasing. */
  activeChaosKinds: ChaosInjectorKind[];
  /** Build a realistic event of `kind`, or null if the generator cannot. */
  generate(kind: EventKind): WorkdayEvent | null;
  /** Publish an event into the stream and account for it in run counters. */
  emit(event: WorkdayEvent): void;
  /** Sample up to `count` identities matching an optional predicate. */
  sampleEmployees(count: number, predicate?: (employee: Employee) => boolean): Employee[];
}

/** A live chaos injector bound to one run. */
export interface ChaosInjector {
  readonly kind: ChaosInjectorKind;
  readonly config: ChaosInjectorConfig;
  readonly signatureKinds: readonly EventKind[];
  /** Total events this injector has directly emitted or been credited for. */
  eventsInjected: number;
  isActive(elapsedSec: number): boolean;
  hasExpired(elapsedSec: number): boolean;
  /** Rate multiplier contributed while active; 1 when inactive. */
  rateMultiplier(elapsedSec: number): number;
  /** Per-kind weight multipliers contributed while active; empty when inactive. */
  mixBias(elapsedSec: number): Map<EventKind, number>;
  /** Advance one tick: activate on first entry to the window, then run burst logic. */
  tick(ctx: ChaosContext, elapsedSec: number, tickDeltaMs: number): void;
  /** Credit an ambient generated event to this injector when it is a signature kind. */
  creditAmbient(kind: EventKind): void;
  /** Telemetry view for the frame and the run summary. */
  toActiveChaos(runStartWallMs: number): ActiveChaos;
}

/** Per-run mutable scratch carried by an injector between ticks. */
interface InjectorState {
  eventsInjected: number;
  activated: boolean;
  victimId: string | null;
  remainingBurst: number;
}

/** Static behavior of one injector kind. */
interface InjectorSpec {
  kind: ChaosInjectorKind;
  description: string;
  params: ChaosInjectorCatalogParam[];
  signatureKinds: EventKind[];
  /** Arrival-rate multiplier at full intensity; 1 means no ambient rate change. */
  peakRateMultiplier: number;
  /** Signature-kind weight multiplier at full intensity; higher concentrates the mix. */
  peakMixBoost: number;
  /** Active-window length when the config omits durationSec. */
  defaultDurationSec: number;
  onActivate?: (state: InjectorState, ctx: ChaosContext, tools: InjectorTools) => void;
  onTick?: (
    state: InjectorState,
    ctx: ChaosContext,
    elapsedSec: number,
    tickDeltaMs: number,
    tools: InjectorTools,
  ) => void;
}

/** Helpers passed to spec callbacks so burst logic stays terse and consistent. */
interface InjectorTools {
  intensity: number;
  /** Read a numeric param with a fallback. */
  num(name: string, fallback: number): number;
  /** Generate, optionally retarget to a victim (non-JML only), emit, and credit one. */
  inject(ctx: ChaosContext, kind: EventKind, victim?: Employee): void;
}

/** Absolute cap on a single burst so a hostile config cannot exhaust memory. */
const BURST_HARD_CAP = 5000;

const clamp01 = (n: number): number => (n <= 0 ? 0 : n >= 1 ? 1 : n);

/** Build a compact identity reference from a full employee record. */
function identityRefOf(employee: Employee): IdentityRef {
  return {
    id: employee.id,
    employeeId: employee.employeeId,
    displayName: employee.displayName,
    email: employee.email,
    division: employee.division,
    location: employee.location,
    grade: employee.grade,
    type: employee.type,
  };
}

/** Build an actor reference from an employee, honoring the non-human distinction. */
function actorRefOf(employee: Employee): ActorRef {
  const ref = identityRefOf(employee);
  return employee.isNonHuman ? { kind: 'service', ...ref } : { kind: 'employee', ...ref };
}

/**
 * Re-stamp an event's envelope onto a victim identity. Mutates actor, division and
 * location, and clears subject so `subject ?? actor` resolves to the victim. Callers
 * must never pass a JML event here.
 */
function retargetEvent(event: WorkdayEvent, victim: Employee): void {
  event.actor = actorRefOf(victim);
  event.subject = undefined;
  event.division = victim.division;
  event.location = victim.location;
}

/* --- The injector catalog (single source of truth for specs) --------------- */

const SPECS: Record<ChaosInjectorKind, InjectorSpec> = {
  credential_stuffing: {
    kind: 'credential_stuffing',
    description:
      'A burst of automated login attempts from hostile IP ranges: failed logins, MFA failures, lockouts and the occasional breakthrough.',
    params: [
      { name: 'sourceIpCount', type: 'number', default: 200 },
      { name: 'targetCount', type: 'number', default: 50 },
    ],
    signatureKinds: ['login.failure', 'mfa.failure', 'account.lockout', 'login.success', 'impossible.travel'],
    peakRateMultiplier: 6,
    peakMixBoost: 12,
    defaultDurationSec: 90,
  },

  mass_termination_reorg: {
    kind: 'mass_termination_reorg',
    description:
      'A reorganization terminates a large cohort and reassigns managers en masse, driving leaver and access-revoke traffic.',
    params: [
      { name: 'targetCount', type: 'number', default: 100 },
      { name: 'managerChangeRatio', type: 'number', default: 0.4 },
    ],
    signatureKinds: ['leaver.termination', 'mover.manager_change', 'access.revoke'],
    peakRateMultiplier: 1.5,
    peakMixBoost: 6,
    defaultDurationSec: 30,
    onActivate(state, ctx, tools) {
      const count = Math.min(BURST_HARD_CAP, Math.max(1, Math.round(tools.num('targetCount', 100) * tools.intensity)));
      const managerRatio = clamp01(tools.num('managerChangeRatio', 0.4));
      for (let i = 0; i < count; i += 1) {
        // JML kinds: the generator picks and mutates the pool. Do not retarget.
        tools.inject(ctx, 'leaver.termination');
        if (ctx.prng.bool(managerRatio)) tools.inject(ctx, 'mover.manager_change');
      }
    },
  },

  insider_threat: {
    kind: 'insider_threat',
    description:
      'A single compromised identity acts off-hours: mass data pulls, privileged access requests and step-up prompts concentrated on one person.',
    params: [{ name: 'downloadEvents', type: 'number', default: 20 }],
    signatureKinds: ['nhi.activity', 'access.request', 'session.start', 'login.success', 'stepup', 'audit.pull'],
    peakRateMultiplier: 1.2,
    peakMixBoost: 3,
    defaultDurationSec: 60,
    onActivate(state, ctx, tools) {
      const victim = ctx.sampleEmployees(1, (e) => !e.isNonHuman && e.status === 'active')[0];
      if (!victim) {
        ctx.logger.debug('insider_threat found no eligible victim; running as ambient only');
        return;
      }
      state.victimId = victim.id;
      state.remainingBurst = Math.min(BURST_HARD_CAP, Math.max(1, Math.round(tools.num('downloadEvents', 20) * tools.intensity)));
      // Establish the session on the victim.
      tools.inject(ctx, 'login.success', victim);
      tools.inject(ctx, 'session.start', victim);
    },
    onTick(state, ctx, _elapsedSec, tickDeltaMs, tools) {
      if (state.victimId === null || state.remainingBurst <= 0) return;
      const victim = ctx.pool.get(state.victimId);
      if (!victim) {
        state.remainingBurst = 0;
        return;
      }
      // Spread the exfiltration across the window rather than dumping it at once.
      const perTickProbability = clamp01(tickDeltaMs / 1500);
      if (!ctx.prng.bool(perTickProbability)) return;
      const exfilKinds: EventKind[] = ['nhi.activity', 'access.request', 'stepup', 'audit.pull'];
      tools.inject(ctx, ctx.prng.pick(exfilKinds), victim);
      state.remainingBurst -= 1;
    },
  },

  audit_season_surge: {
    kind: 'audit_season_surge',
    description:
      'Quarter-end audit and recertification drive a sustained surge of audit pulls, access reviews, approvals and data-subject requests.',
    params: [{ name: 'regulator', type: 'string', default: 'BaFin' }],
    signatureKinds: ['audit.pull', 'recertification', 'access.request', 'gdpr.request', 'access.approve'],
    peakRateMultiplier: 2.5,
    peakMixBoost: 8,
    defaultDurationSec: 180,
  },

  ransomware_lateral: {
    kind: 'ransomware_lateral',
    description:
      'Ransomware spreads laterally: service accounts light up, privileged access is seized, break-glass fires and failed logins spike.',
    params: [{ name: 'hostCount', type: 'number', default: 40 }],
    signatureKinds: ['nhi.activity', 'login.failure', 'access.provision', 'breakglass', 'impossible.travel', 'firefighter.grant'],
    peakRateMultiplier: 5,
    peakMixBoost: 10,
    defaultDurationSec: 60,
    onActivate(state, ctx, tools) {
      const detonations = Math.min(BURST_HARD_CAP, Math.max(1, Math.round(tools.num('hostCount', 40) * tools.intensity * 0.25)));
      for (let i = 0; i < detonations; i += 1) {
        tools.inject(ctx, 'breakglass');
        tools.inject(ctx, 'nhi.activity');
      }
    },
  },

  payroll_batch: {
    kind: 'payroll_batch',
    description:
      'Payroll day pushes a batch of SEPA and SWIFT payments, wire approvals and high-value screening alerts.',
    params: [{ name: 'paymentCount', type: 'number', default: 200 }],
    signatureKinds: ['payment.sepa', 'payment.swift', 'wire.approval', 'highvalue.alert'],
    peakRateMultiplier: 1.3,
    peakMixBoost: 5,
    defaultDurationSec: 20,
    onActivate(state, ctx, tools) {
      const count = Math.min(BURST_HARD_CAP, Math.max(1, Math.round(tools.num('paymentCount', 200) * tools.intensity)));
      const kinds: EventKind[] = ['payment.sepa', 'payment.swift', 'wire.approval'];
      for (let i = 0; i < count; i += 1) {
        tools.inject(ctx, kinds[i % kinds.length] ?? 'payment.sepa');
      }
    },
  },

  mass_password_reset: {
    kind: 'mass_password_reset',
    description:
      'A forced credential rotation triggers a wave of password resets and re-authentication across the workforce.',
    params: [{ name: 'targetCount', type: 'number', default: 150 }],
    signatureKinds: ['password.reset', 'login.success', 'mfa.challenge', 'mfa.success'],
    peakRateMultiplier: 1.4,
    peakMixBoost: 6,
    defaultDurationSec: 25,
    onActivate(state, ctx, tools) {
      const count = Math.min(BURST_HARD_CAP, Math.max(1, Math.round(tools.num('targetCount', 150) * tools.intensity)));
      for (let i = 0; i < count; i += 1) {
        tools.inject(ctx, 'password.reset');
      }
    },
  },

  connector_outage: {
    kind: 'connector_outage',
    description:
      'A provisioning connector stalls, so provisioning and revoke traffic backs up and orphan and dormant accounts surface. Models the event-stream consequences; actual delivery failure is simulated by the receiver and delivery adapter.',
    params: [{ name: 'connector', type: 'string', default: 'ActiveDirectory' }],
    signatureKinds: ['access.provision', 'access.revoke', 'orphan.detected', 'dormant.detected'],
    peakRateMultiplier: 1.1,
    peakMixBoost: 7,
    defaultDurationSec: 120,
  },
};

/**
 * The chaos catalog served by GET /api/chaos/injectors. Derived from the spec table
 * so it can never drift from the implemented behavior.
 */
export const CHAOS_INJECTOR_CATALOG: ChaosInjectorCatalogEntry[] = Object.values(SPECS).map((spec) => ({
  kind: spec.kind,
  description: spec.description,
  params: spec.params.map((p) => ({ ...p })),
}));

/**
 * Create a live chaos injector for a run.
 *
 * @param config The injector configuration from the scenario or an ad-hoc injection.
 *   `startAtSec` is measured in real seconds from run start; `durationSec` falls back
 *   to the spec default; `intensity` scales both the ambient multipliers and the
 *   burst volume.
 */
export function createChaosInjector(config: ChaosInjectorConfig): ChaosInjector {
  const spec = SPECS[config.kind];
  const intensity = clamp01(config.intensity);
  const startAtSec = config.startAtSec !== undefined && config.startAtSec >= 0 ? config.startAtSec : 0;
  const durationSec = config.durationSec !== undefined && config.durationSec > 0 ? config.durationSec : spec.defaultDurationSec;
  const endAtSec = startAtSec + durationSec;

  const state: InjectorState = {
    eventsInjected: 0,
    activated: false,
    victimId: null,
    remainingBurst: 0,
  };

  const tools: InjectorTools = {
    intensity,
    num(name: string, fallback: number): number {
      const raw = config.params[name];
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
    },
    inject(ctx: ChaosContext, kind: EventKind, victim?: Employee): void {
      const event = ctx.generate(kind);
      if (!event) return;
      if (victim && !isJmlKind(kind)) retargetEvent(event, victim);
      ctx.emit(event);
      state.eventsInjected += 1;
    },
  };

  const active = (elapsedSec: number): boolean =>
    config.enabled && intensity > 0 && elapsedSec >= startAtSec && elapsedSec < endAtSec;

  const injector: ChaosInjector = {
    kind: config.kind,
    config,
    signatureKinds: spec.signatureKinds,
    get eventsInjected(): number {
      return state.eventsInjected;
    },
    set eventsInjected(value: number) {
      state.eventsInjected = value;
    },
    isActive(elapsedSec: number): boolean {
      return active(elapsedSec);
    },
    hasExpired(elapsedSec: number): boolean {
      return elapsedSec >= endAtSec;
    },
    rateMultiplier(elapsedSec: number): number {
      if (!active(elapsedSec)) return 1;
      return 1 + (spec.peakRateMultiplier - 1) * intensity;
    },
    mixBias(elapsedSec: number): Map<EventKind, number> {
      const bias = new Map<EventKind, number>();
      if (!active(elapsedSec)) return bias;
      const factor = 1 + spec.peakMixBoost * intensity;
      for (const kind of spec.signatureKinds) bias.set(kind, factor);
      return bias;
    },
    tick(ctx: ChaosContext, elapsedSec: number, tickDeltaMs: number): void {
      if (!active(elapsedSec)) return;
      if (!state.activated) {
        state.activated = true;
        spec.onActivate?.(state, ctx, tools);
      }
      spec.onTick?.(state, ctx, elapsedSec, tickDeltaMs, tools);
    },
    creditAmbient(kind: EventKind): void {
      if (spec.signatureKinds.includes(kind)) state.eventsInjected += 1;
    },
    toActiveChaos(runStartWallMs: number): ActiveChaos {
      return {
        kind: config.kind,
        startedAt: new Date(runStartWallMs + startAtSec * 1000).toISOString(),
        endsAt: new Date(runStartWallMs + endAtSec * 1000).toISOString(),
        intensity,
        eventsInjected: state.eventsInjected,
      };
    },
  };

  return injector;
}
