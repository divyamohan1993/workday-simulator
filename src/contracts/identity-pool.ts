import type {
  Employee,
  Entitlement,
  Grade,
  IdentityPoolStats,
  IdentityRef,
  IdentityStatus,
} from '../types/index.js';

/**
 * The seeded workforce. Holds the full Deutsche Bank identity population and
 * applies Joiner/Mover/Leaver lifecycle mutations as the event generator produces
 * JML events. Seeding is deterministic from a seed string so runs are reproducible.
 *
 * The pool is the single owner of identity state. The event generator reads and
 * mutates it through this interface; nothing else writes identities.
 */
export interface IdentityPool {
  /**
   * Populate the pool with `size` identities deterministically from `seed`,
   * including realistic manager chains, cost centers, birthright entitlements, a
   * fraction of non-human (service) identities, and deliberate edge cases (unicode
   * names, email/username collisions). Idempotent for a given (size, seed).
   */
  seed(size: number, seed: string): void;

  /** Number of identities currently in the pool. */
  size(): number;

  /** Look up a full identity by internal id. */
  get(id: string): Employee | undefined;

  /**
   * Pick a random ACTIVE human identity weighted by the location activity implied
   * by the simulated instant (so logins cluster in whichever regions are at work).
   * Returns undefined only when no active identity exists.
   */
  pickActive(simEpochMs: number): Employee | undefined;

  /** Pick any identity optionally matching a predicate (e.g. service accounts). */
  pick(predicate?: (employee: Employee) => boolean): Employee | undefined;

  /** Compact reference for embedding in events. */
  ref(id: string): IdentityRef | undefined;

  /* --- Lifecycle mutations (Joiner/Mover/Leaver) --------------------------- */

  /** Create and insert a new identity, filling unspecified fields realistically. */
  hire(partial: Partial<Employee>): Employee;

  /** Move an identity to a new division/location/cost center. */
  transfer(
    id: string,
    changes: Partial<Pick<Employee, 'division' | 'location' | 'costCenter' | 'legalEntity'>>,
  ): Employee | undefined;

  /** Promote to a more senior grade. */
  promote(id: string, toGrade: Grade): Employee | undefined;

  /** Reassign the reporting manager. */
  changeManager(id: string, managerId: string): Employee | undefined;

  /** Set lifecycle status (suspend, terminate, disable, mark dormant, etc.). */
  setStatus(id: string, status: IdentityStatus): Employee | undefined;

  /** Grant an entitlement. */
  grant(id: string, entitlement: Entitlement): Employee | undefined;

  /** Revoke an entitlement by id. */
  revoke(id: string, entitlementId: string): Employee | undefined;

  /* --- Aggregates ---------------------------------------------------------- */

  /** Snapshot copy of all identities, for list and export endpoints. */
  all(): Employee[];

  /** Distribution statistics for the dashboard. */
  stats(): IdentityPoolStats;

  /**
   * Segregation-of-duties conflicts for an identity: pairs of held entitlements
   * whose `sodTags` form a toxic combination under the rule set.
   */
  sodConflicts(id: string): Array<[Entitlement, Entitlement]>;
}
