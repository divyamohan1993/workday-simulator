/**
 * Internal shared machinery for the event generators: the seeded RNG helper (`Forge`),
 * actor/subject reference construction, the envelope assembler, and the small pool
 * pickers the category builders share.
 *
 * WHY this is separate from `generator.ts`: the category builders (auth/jml/access/
 * txn/compliance) and the top-level generator all need the same envelope logic and
 * the same helpers, so factoring them here gives a clean dependency DAG, builders
 * import only this file, and `generator.ts` imports the builders. Nothing here reads
 * config, the wall clock (except through the injected `Clock`), or global state.
 */

import type { Faker } from '@faker-js/faker';
import type { GenerationContext } from '../contracts/index.js';
import type {
  ActorRef,
  ChaosInjectorKind,
  Division,
  Employee,
  Entitlement,
  EntitlementRef,
  EventKind,
  EventOfKind,
  EventPayloadMap,
  IdentityRef,
  LocationCode,
  Severity,
  WorkdayEventBase,
} from '../types/index.js';
import { EVENT_CATEGORY } from '../types/index.js';
import { SEVERITY_BY_KIND, deliveryMetaFor } from './taxonomy.js';

/**
 * Thrown by a builder when the pool cannot supply a required actor (e.g. an empty
 * pool, or no service identity for an NHI event). The runtime catches generation
 * errors and treats them as a skipped arrival, so this is a normal control-flow
 * signal, not a fault.
 */
export class NoEligibleActorError extends Error {
  public constructor(kind: EventKind, detail: string) {
    super(`no eligible actor for ${kind}: ${detail}`);
    this.name = 'NoEligibleActorError';
  }
}

/**
 * A thin, deterministic RNG facade over a seeded Faker instance. Bundling the few
 * primitives the builders need (ids, probabilities, ranged draws, weighted picks)
 * keeps builder code terse and keeps every random draw flowing through the one seeded
 * source, which is what makes generation replayable.
 */
export interface Forge {
  /** The underlying seeded Faker, for richer draws (names, IPs, user agents). */
  readonly faker: Faker;
  /** A unique, deterministic id with the given prefix, e.g. "evt_V1StGXR8". */
  id(prefix: string): string;
  /** True with probability `p` (clamped to [0,1]). */
  chance(p: number): boolean;
  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number;
  /** Uniform float in [min, max). */
  float(min: number, max: number): number;
  /** Uniform element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** Weighted element by relative weights. */
  weighted<T>(entries: ReadonlyArray<{ weight: number; value: T }>): T;
}

/** Build a `Forge` over a seeded Faker instance. Constructed once per generator. */
export function createForge(faker: Faker): Forge {
  return {
    faker,
    id: (prefix) => `${prefix}_${faker.string.nanoid(16)}`,
    chance: (p) => faker.number.float({ min: 0, max: 1 }) < (p <= 0 ? 0 : p >= 1 ? 1 : p),
    int: (min, max) => faker.number.int({ min, max }),
    float: (min, max) => faker.number.float({ min, max }),
    pick: (items) => faker.helpers.arrayElement(items),
    weighted: (entries) => faker.helpers.weightedArrayElement(entries),
  };
}

/** Whether a given chaos injector kind is active for this generation call. */
export function chaosActive(gctx: GenerationContext, kind: ChaosInjectorKind): boolean {
  return gctx.activeChaos.includes(kind);
}

/** Build the compact identity reference embedded in events from a full identity. */
export function toIdentityRef(employee: Employee): IdentityRef {
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

/** Build the ActorRef for an identity, discriminating human vs machine (NHI). */
export function actorOf(employee: Employee): ActorRef {
  const ref = toIdentityRef(employee);
  return employee.isNonHuman ? { kind: 'service', ...ref } : { kind: 'employee', ...ref };
}

/** Build a platform (system) actor for detectors, schedulers, feeds and campaigns. */
export function systemActor(component: string): ActorRef {
  return { kind: 'system', id: `sys:${component}`, component };
}

/** Build the compact entitlement reference embedded in access and SoD events. */
export function toEntitlementRef(entitlement: Entitlement): EntitlementRef {
  return {
    id: entitlement.id,
    system: entitlement.system,
    name: entitlement.name,
    type: entitlement.type,
    risk: entitlement.risk,
  };
}

/** Extract the identity reference from an actor, or undefined for a system actor. */
export function refFromActor(actor: ActorRef): IdentityRef | undefined {
  if (actor.kind === 'system') {
    return undefined;
  }
  return {
    id: actor.id,
    employeeId: actor.employeeId,
    displayName: actor.displayName,
    email: actor.email,
    division: actor.division,
    location: actor.location,
    grade: actor.grade,
    type: actor.type,
  };
}

/**
 * Pick a random ACTIVE human weighted by where the simulated clock says people are at
 * work. Throws `NoEligibleActorError` when the pool has no active human, which the
 * runtime treats as a skipped arrival.
 *
 * @param gctx The generation context (clock + pool).
 * @param kind The kind being generated, for the error message.
 * @returns An active human identity.
 */
export function requireActiveHuman(gctx: GenerationContext, kind: EventKind): Employee {
  const employee = gctx.pool.pickActive(gctx.clock.now());
  if (!employee) {
    throw new NoEligibleActorError(kind, 'no active human identity in pool');
  }
  return employee;
}

/**
 * Pick any identity matching a predicate, or throw if none match. Used for NHI events
 * (service accounts), approvers (senior humans), and leaver/mover targets.
 *
 * @param gctx The generation context.
 * @param kind The kind being generated, for the error message.
 * @param predicate The selection predicate.
 * @param detail Human-readable description of what was sought, for the error.
 * @returns A matching identity.
 */
export function requireMatch(
  gctx: GenerationContext,
  kind: EventKind,
  predicate: (employee: Employee) => boolean,
  detail: string,
): Employee {
  const employee = gctx.pool.pick(predicate);
  if (!employee) {
    throw new NoEligibleActorError(kind, detail);
  }
  return employee;
}

/**
 * Everything the envelope assembler needs beyond the payload. Correlation and
 * causation are ALWAYS explicit because the runtime supplies neither on the context:
 * a primary event mints its own correlation, and a saga follow-on inherits the
 * primary's correlation and chains its causation to the event that triggered it.
 */
export interface AssembleInput<K extends EventKind> {
  kind: K;
  actor: ActorRef;
  /** Set only when the affected identity differs from the actor. */
  subject?: IdentityRef;
  /** Site the event occurred at; always sourced from the context identity so it is defined even for system actors. */
  location: LocationCode;
  /** Division the event belongs to; sourced from the context identity. */
  division: Division;
  payload: EventPayloadMap[K];
  correlationId: string;
  causationId?: string;
  /** Override the default severity for this instance (e.g. an anomalous NHI action). */
  severity?: Severity;
  /** Entitlement id for grant/revoke idempotency keys. */
  entitlementId?: string;
}

/**
 * Assemble a fully-formed, internally-consistent `WorkdayEvent` from a payload and its
 * envelope inputs. This is the single place the base envelope is constructed, so every
 * event agrees on how id, category, timestamps, correlation, delivery metadata and the
 * sequence number are derived.
 *
 * @param gctx The generation context (clock, pool, sequence source).
 * @param forge The seeded RNG facade (for the event id).
 * @param input Envelope inputs plus the typed payload.
 * @returns The assembled event, narrowed to the requested kind.
 */
export function assembleEvent<K extends EventKind>(
  gctx: GenerationContext,
  forge: Forge,
  input: AssembleInput<K>,
): EventOfKind<K> {
  const id = forge.id('evt');
  const subjectId = input.subject?.id ?? input.actor.id;
  const base: WorkdayEventBase = {
    id,
    category: EVENT_CATEGORY[input.kind],
    timestamp: gctx.clock.nowISO(),
    emittedAtWall: new Date(gctx.clock.wallNow()).toISOString(),
    correlationId: input.correlationId,
    causationId: input.causationId,
    severity: input.severity ?? SEVERITY_BY_KIND[input.kind],
    actor: input.actor,
    subject: input.subject,
    location: input.location,
    division: input.division,
    delivery: deliveryMetaFor(input.kind, {
      eventId: id,
      correlationId: input.correlationId,
      subjectId,
      entitlementId: input.entitlementId,
    }),
    seq: gctx.nextSeq(),
  };
  // The kind determines the payload type by construction (AssembleInput<K>), so this
  // single cast at the one assembly site is sound and keeps the builders generic-free.
  return { ...base, kind: input.kind, payload: input.payload } as EventOfKind<K>;
}

/** Resolve a fresh correlation id for a primary event, honouring any supplied one. */
export function primaryCorrelationId(gctx: GenerationContext, forge: Forge): string {
  return gctx.correlationId ?? forge.id('cor');
}

/** Exhaustiveness guard for switch statements over the kind unions. */
export function assertNever(value: never): never {
  throw new Error(`unexpected event kind: ${String(value)}`);
}
