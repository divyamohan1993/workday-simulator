import type {
  ChaosInjectorKind,
  EventKind,
  EventOfKind,
  WorkdayEvent,
} from '../types/index.js';
import type { Clock } from './clock.js';
import type { IdentityPool } from './identity-pool.js';

/**
 * Everything the generator needs to build a realistic, correlated event. Supplied
 * by the runtime on each generation call.
 */
export interface GenerationContext {
  /** Accelerated clock; source of event timestamps. */
  clock: Clock;
  /** The workforce; read for actors/subjects, mutated for JML kinds. */
  pool: IdentityPool;
  /** The run this event belongs to. */
  runId: string;
  /** Monotonic sequence source for `event.seq`. */
  nextSeq(): number;
  /** Correlation id to continue an existing saga; omit to start a fresh one. */
  correlationId?: string;
  /** Id of the event that caused this one, when continuing a saga. */
  causationId?: string;
  /** Chaos kinds currently active; bias payload realism (e.g. attacker IPs). */
  activeChaos: ChaosInjectorKind[];
}

/**
 * Produces fully-formed, valid WorkdayEvents. Payloads are realistic and internally
 * consistent (a leaver's last working day is after their start date, a SWIFT amount
 * looks like a real wire, etc.). Generation is deterministic under a fixed seed and
 * context.
 */
export interface EventGenerator {
  /**
   * Build one event of the requested kind. MAY mutate the identity pool for JML
   * kinds: `joiner.hire` inserts an identity, `leaver.termination` flips status,
   * `mover.*` updates attributes. The returned event's `actor`/`subject` reflect
   * the mutation. Throws only on an impossible request (e.g. empty pool for a kind
   * that requires an actor); callers treat that as a skip.
   */
  generate<K extends EventKind>(kind: K, ctx: GenerationContext): EventOfKind<K>;

  /**
   * Given a just-generated primary event, return the ordered follow-on events that
   * naturally accompany it as a saga, sharing its correlationId. For example an
   * `access.request` may yield `access.approve` then `access.provision`; a
   * `login.failure` streak may yield `account.lockout`. Returns an empty array when
   * the primary is standalone. The caller publishes these after the primary.
   */
  saga(primary: WorkdayEvent, ctx: GenerationContext): WorkdayEvent[];
}
