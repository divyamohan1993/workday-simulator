/**
 * The Joiner / Mover / Leaver lifecycle state machine.
 *
 * WHY this is a distinct, pure module: the identity pool owns identity STATE and its
 * `setStatus` is a raw field write with no notion of legality. The rules that govern
 * which status changes make sense (you cannot put a terminated identity straight on
 * parental leave; a rehire is the only way out of terminated) live here, decoupled
 * from storage. The runtime consults this machine when a chaos injector needs to
 * pick eligible targets for a mass-termination or a rehire wave, so it never emits a
 * nonsensical transition. The generator can consult it too, but nothing here mutates
 * anything; it only answers questions about legality and intent.
 *
 * The transition graph is intentionally conservative and auditable: each edge maps to
 * a real HR or IAM action.
 */

import type { EventKind, IdentityStatus } from '../types/index.js';
import { EVENT_KINDS_BY_CATEGORY } from '../types/index.js';

/** The ten Joiner/Mover/Leaver event kinds, derived from the frozen category map. */
export type JmlEventKind = (typeof EVENT_KINDS_BY_CATEGORY.JML)[number];

const JML_KIND_SET: ReadonlySet<EventKind> = new Set(EVENT_KINDS_BY_CATEGORY.JML);

/** Narrow an arbitrary event kind to a JML kind. */
export function isJmlKind(kind: EventKind): kind is JmlEventKind {
  return JML_KIND_SET.has(kind);
}

/**
 * Legal status transitions. A status maps to the set of statuses it may move to.
 * Self-transitions are implicitly legal (a no-op mover) and are not listed. The
 * graph encodes: onboarding completes to active or is abandoned; active identities
 * can go on leave, be suspended, go dormant, or leave; suspended and on-leave and
 * dormant identities can be restored or terminated; disabled identities can be
 * re-enabled or terminated; and terminated is a near-terminal sink escaped only by
 * rehire.
 */
export const JML_TRANSITIONS: Record<IdentityStatus, readonly IdentityStatus[]> = {
  onboarding: ['active', 'suspended', 'terminated', 'disabled'],
  active: ['on_leave', 'suspended', 'dormant', 'terminated', 'disabled'],
  on_leave: ['active', 'suspended', 'terminated', 'disabled'],
  suspended: ['active', 'on_leave', 'terminated', 'disabled'],
  dormant: ['active', 'suspended', 'terminated', 'disabled'],
  disabled: ['active', 'terminated'],
  terminated: ['onboarding', 'active'],
};

/** The intended effect of a JML event kind on an identity's lifecycle status. */
export interface JmlKindEffect {
  /** Target status the kind drives toward, or null when the kind changes no status. */
  to: IdentityStatus | null;
  /**
   * Statuses from which this kind is meaningful. Applying the kind to an identity in
   * any other status is a no-op or an error the caller should skip.
   */
  from: readonly IdentityStatus[];
}

const ACTIVE_LIKE: readonly IdentityStatus[] = ['active', 'onboarding', 'on_leave', 'suspended', 'dormant'];

/**
 * Effect of each JML kind. Movers (transfer, promotion, manager change, contractor
 * conversion) do not change lifecycle status; they change attributes on an already
 * active identity, so `to` is null and `from` is the active-like set.
 */
export const JML_KIND_EFFECT: Record<JmlEventKind, JmlKindEffect> = {
  'joiner.hire': { to: 'active', from: ['onboarding'] },
  rehire: { to: 'onboarding', from: ['terminated'] },
  'mover.transfer': { to: null, from: ACTIVE_LIKE },
  'mover.promotion': { to: null, from: ACTIVE_LIKE },
  'mover.manager_change': { to: null, from: ACTIVE_LIKE },
  'contractor.convert': { to: null, from: ACTIVE_LIKE },
  'leaver.termination': { to: 'terminated', from: ['active', 'onboarding', 'on_leave', 'suspended', 'dormant'] },
  'leaver.resignation': { to: 'terminated', from: ['active', 'on_leave', 'suspended'] },
  'leaver.loa': { to: 'on_leave', from: ['active'] },
  'contract.expiry': { to: 'disabled', from: ['active', 'on_leave', 'suspended', 'dormant'] },
};

/** Whether an identity in `status` is broadly working (active, onboarding or on leave). */
export function isActiveLike(status: IdentityStatus): boolean {
  return status === 'active' || status === 'onboarding' || status === 'on_leave';
}

/** The result of asking whether a JML kind may be applied to a given status. */
export interface TransitionPlan {
  allowed: boolean;
  /** Target status when allowed and the kind changes status; null for pure movers. */
  to: IdentityStatus | null;
  /** Human-readable reason when not allowed, for structured logging. */
  reason?: string;
}

/**
 * The lifecycle state machine. All methods are pure; nothing here mutates identity
 * state. The pool is the only writer and applies the `to` that `plan` returns.
 */
export interface JmlStateMachine {
  /** Whether a direct status transition is legal (self-transition always legal). */
  canTransition(from: IdentityStatus, to: IdentityStatus): boolean;
  /** Whether a JML kind is meaningful for an identity currently in `status`. */
  isEligible(kind: JmlEventKind, status: IdentityStatus): boolean;
  /** Plan a JML kind against a current status: legality, target status, reason. */
  plan(kind: JmlEventKind, status: IdentityStatus): TransitionPlan;
}

/**
 * Create the JML lifecycle state machine. Stateless, so a single shared instance is
 * fine; the factory shape exists for symmetry with the other engine factories and to
 * keep call sites decoupled from the concrete functions.
 */
export function createJmlStateMachine(): JmlStateMachine {
  return {
    canTransition(from: IdentityStatus, to: IdentityStatus): boolean {
      if (from === to) return true;
      return JML_TRANSITIONS[from].includes(to);
    },
    isEligible(kind: JmlEventKind, status: IdentityStatus): boolean {
      return JML_KIND_EFFECT[kind].from.includes(status);
    },
    plan(kind: JmlEventKind, status: IdentityStatus): TransitionPlan {
      const effect = JML_KIND_EFFECT[kind];
      if (!effect.from.includes(status)) {
        return {
          allowed: false,
          to: null,
          reason: `${kind} is not applicable to an identity in status ${status}`,
        };
      }
      if (effect.to === null) {
        return { allowed: true, to: null };
      }
      if (!this.canTransition(status, effect.to)) {
        return {
          allowed: false,
          to: null,
          reason: `transition ${status} -> ${effect.to} is not permitted`,
        };
      }
      return { allowed: true, to: effect.to };
    },
  };
}

/** Shared stateless instance for convenience. */
export const jmlStateMachine: JmlStateMachine = createJmlStateMachine();
