/**
 * The recommended production-like event mix.
 *
 * WHY the events module owns this: the engine's `resolveMix`/`pickKind` sample a kind
 * by weight, but they need weights that reflect how a real bank day is shaped. The
 * frozen `eventMixSchema` only defaults the five CATEGORY weights; without per-kind
 * weights every kind in a category is equally likely, which would emit as many
 * account lockouts as successful logins and as many break-glass events as SEPA
 * payments. Those per-kind proportions are a property of the event taxonomy, so they
 * live here next to the generators. Scenarios should adopt this mix (or start from it)
 * rather than the bare category defaults.
 *
 * The weights are relative, not absolute. The engine multiplies a kind's category
 * weight by its per-kind weight, so within a category the numbers below are the
 * realistic frequency ratios (a successful login is ~20x a failed one; nhi chatter
 * dominates the compliance stream; SEPA and card volume dominate transactions).
 */

import type { EventKind, EventMixWeights } from '../types/index.js';

/**
 * Per-category baseline volumes. AUTH dominates (everyone authenticates all day),
 * transactions are close behind, access governance is steady, and the lifecycle and
 * compliance streams are comparatively thin.
 */
const BY_CATEGORY = {
  AUTH: 1,
  TXN: 0.7,
  ACCESS: 0.35,
  JML: 0.08,
  COMPLIANCE: 0.1,
} as const;

/**
 * Per-kind frequency ratios within each category. Chosen so the realized stream
 * matches published IAM/banking baselines: successful logins vastly outnumber
 * failures (keeping the login-failure share near 5%), sessions bracket logins,
 * privileged and emergency events are rare, and service-account activity is the bulk
 * of compliance traffic.
 */
const BY_KIND: Partial<Record<EventKind, number>> = {
  // AUTH
  'login.success': 10,
  'login.failure': 0.5,
  'mfa.challenge': 3,
  'mfa.success': 2.6,
  'mfa.failure': 0.15,
  'password.reset': 0.4,
  'account.lockout': 0.1,
  'session.start': 6,
  'session.end': 5,
  'sso.federation': 2,
  stepup: 0.8,
  'impossible.travel': 0.05,
  // JML
  'joiner.hire': 2,
  'mover.transfer': 1.2,
  'mover.promotion': 0.5,
  'mover.manager_change': 1,
  'leaver.termination': 0.8,
  'leaver.resignation': 1,
  'leaver.loa': 0.6,
  rehire: 0.2,
  'contractor.convert': 0.2,
  'contract.expiry': 0.5,
  // ACCESS
  'access.request': 3,
  'access.approve': 2.4,
  'access.deny': 0.5,
  'access.provision': 2.5,
  'access.revoke': 1.2,
  recertification: 0.8,
  'firefighter.grant': 0.15,
  'firefighter.revoke': 0.15,
  'sod.violation': 0.2,
  'orphan.detected': 0.15,
  'dormant.detected': 0.15,
  // TXN
  'payment.sepa': 6,
  'payment.swift': 2,
  'trade.book': 3,
  'card.txn': 5,
  'wire.approval': 0.6,
  'limit.breach': 0.2,
  'highvalue.alert': 0.4,
  // COMPLIANCE
  'gdpr.request': 0.3,
  'audit.pull': 0.6,
  'nhi.activity': 4,
  breakglass: 0.05,
  'duplicate.identity': 0.2,
  namecollision: 0.2,
};

/**
 * The recommended default event mix. Frozen at module scope; use `defaultEventMix()`
 * when a mutable copy is needed (e.g. a scenario editor that tweaks weights).
 */
export const DEFAULT_EVENT_MIX: EventMixWeights = Object.freeze({
  byCategory: { ...BY_CATEGORY },
  byKind: { ...BY_KIND },
});

/**
 * Return a fresh, deep-cloned copy of the default event mix, safe for a caller to
 * mutate. Use this when persisting a scenario derived from the default.
 *
 * @returns A mutable copy of the recommended mix.
 */
export function defaultEventMix(): EventMixWeights {
  return {
    byCategory: { ...BY_CATEGORY },
    byKind: { ...BY_KIND },
  };
}
