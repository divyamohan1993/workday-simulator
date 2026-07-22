/**
 * Static per-kind event metadata: default severity and the provisioning intent each
 * kind implies for the Identity Manager.
 *
 * WHY this table exists and is derived once: the delivery adapter and the receiver
 * both act on `event.delivery` (what SCIM/HR operation to perform) and consumers
 * colour the UI by `event.severity`. Encoding those two mappings in one exhaustive,
 * type-checked table (keyed by the frozen `EventKind` union) means a new kind cannot
 * be added without deciding its provisioning semantics, and the two consumers can
 * never disagree about what, say, a `leaver.termination` should do (deactivate the
 * identity) or how loud an `impossible.travel` is.
 *
 * Severity here is the DEFAULT; a builder may raise it for a specific instance (an
 * anomalous NHI action, a critical SoD rule) when it assembles the event.
 */

import type {
  EventDeliveryMeta,
  EventKind,
  ProvisioningOperation,
  ProvisioningResource,
  Severity,
} from '../types/index.js';

/** Default severity for each event kind. */
export const SEVERITY_BY_KIND: Record<EventKind, Severity> = {
  // AUTH
  'login.success': 'info',
  'login.failure': 'notice',
  'mfa.challenge': 'info',
  'mfa.success': 'info',
  'mfa.failure': 'notice',
  'password.reset': 'notice',
  'account.lockout': 'warning',
  'session.start': 'info',
  'session.end': 'info',
  'sso.federation': 'info',
  stepup: 'notice',
  'impossible.travel': 'warning',
  // JML
  'joiner.hire': 'info',
  'mover.transfer': 'info',
  'mover.promotion': 'info',
  'mover.manager_change': 'info',
  'leaver.termination': 'warning',
  'leaver.resignation': 'notice',
  'leaver.loa': 'info',
  rehire: 'info',
  'contractor.convert': 'notice',
  'contract.expiry': 'notice',
  // ACCESS
  'access.request': 'info',
  'access.approve': 'info',
  'access.deny': 'notice',
  'access.provision': 'info',
  'access.revoke': 'notice',
  recertification: 'info',
  'firefighter.grant': 'warning',
  'firefighter.revoke': 'notice',
  'sod.violation': 'warning',
  'orphan.detected': 'warning',
  'dormant.detected': 'notice',
  // TXN
  'payment.sepa': 'info',
  'payment.swift': 'notice',
  'trade.book': 'info',
  'card.txn': 'info',
  'wire.approval': 'notice',
  'limit.breach': 'warning',
  'highvalue.alert': 'warning',
  // COMPLIANCE
  'gdpr.request': 'notice',
  'audit.pull': 'info',
  'nhi.activity': 'info',
  breakglass: 'critical',
  'duplicate.identity': 'warning',
  namecollision: 'notice',
};

/** The static part of an event's delivery metadata (everything but the id key). */
interface DeliveryBase {
  operation: ProvisioningOperation;
  resource: ProvisioningResource;
  priority: EventDeliveryMeta['priority'];
  requiresApproval: boolean;
}

/**
 * The provisioning intent for every kind. Notify/event rows are informational signals
 * the Identity Manager records but does not provision from; create/patch/deactivate/
 * grant/revoke rows drive real SCIM or HR-feed operations.
 */
export const DELIVERY_BASE: Record<EventKind, DeliveryBase> = {
  // AUTH: authentication is mostly telemetry; credential and lock changes touch accounts.
  'login.success': { operation: 'notify', resource: 'session', priority: 'normal', requiresApproval: false },
  'login.failure': { operation: 'notify', resource: 'event', priority: 'normal', requiresApproval: false },
  'mfa.challenge': { operation: 'notify', resource: 'session', priority: 'normal', requiresApproval: false },
  'mfa.success': { operation: 'notify', resource: 'session', priority: 'normal', requiresApproval: false },
  'mfa.failure': { operation: 'notify', resource: 'event', priority: 'normal', requiresApproval: false },
  'password.reset': { operation: 'patch', resource: 'account', priority: 'normal', requiresApproval: false },
  'account.lockout': { operation: 'deactivate', resource: 'account', priority: 'high', requiresApproval: false },
  'session.start': { operation: 'notify', resource: 'session', priority: 'low', requiresApproval: false },
  'session.end': { operation: 'notify', resource: 'session', priority: 'low', requiresApproval: false },
  'sso.federation': { operation: 'notify', resource: 'session', priority: 'low', requiresApproval: false },
  stepup: { operation: 'notify', resource: 'session', priority: 'normal', requiresApproval: false },
  'impossible.travel': { operation: 'notify', resource: 'event', priority: 'high', requiresApproval: false },
  // JML: the canonical joiner/mover/leaver provisioning operations.
  'joiner.hire': { operation: 'create', resource: 'identity', priority: 'high', requiresApproval: false },
  'mover.transfer': { operation: 'update', resource: 'identity', priority: 'normal', requiresApproval: false },
  'mover.promotion': { operation: 'update', resource: 'identity', priority: 'normal', requiresApproval: false },
  'mover.manager_change': { operation: 'patch', resource: 'identity', priority: 'normal', requiresApproval: false },
  'leaver.termination': { operation: 'deactivate', resource: 'identity', priority: 'critical', requiresApproval: false },
  'leaver.resignation': { operation: 'deactivate', resource: 'identity', priority: 'high', requiresApproval: false },
  'leaver.loa': { operation: 'deactivate', resource: 'identity', priority: 'normal', requiresApproval: false },
  rehire: { operation: 'reactivate', resource: 'identity', priority: 'high', requiresApproval: false },
  'contractor.convert': { operation: 'create', resource: 'identity', priority: 'high', requiresApproval: false },
  'contract.expiry': { operation: 'deactivate', resource: 'identity', priority: 'high', requiresApproval: false },
  // ACCESS: request/approval telemetry plus the grant/revoke that fulfils it.
  'access.request': { operation: 'notify', resource: 'entitlement', priority: 'normal', requiresApproval: true },
  'access.approve': { operation: 'notify', resource: 'entitlement', priority: 'normal', requiresApproval: false },
  'access.deny': { operation: 'notify', resource: 'entitlement', priority: 'normal', requiresApproval: false },
  'access.provision': { operation: 'grant', resource: 'entitlement', priority: 'high', requiresApproval: false },
  'access.revoke': { operation: 'revoke', resource: 'entitlement', priority: 'high', requiresApproval: false },
  recertification: { operation: 'notify', resource: 'entitlement', priority: 'normal', requiresApproval: false },
  'firefighter.grant': { operation: 'grant', resource: 'entitlement', priority: 'critical', requiresApproval: true },
  'firefighter.revoke': { operation: 'revoke', resource: 'entitlement', priority: 'high', requiresApproval: false },
  'sod.violation': { operation: 'notify', resource: 'event', priority: 'high', requiresApproval: false },
  'orphan.detected': { operation: 'notify', resource: 'account', priority: 'normal', requiresApproval: false },
  'dormant.detected': { operation: 'notify', resource: 'account', priority: 'normal', requiresApproval: false },
  // TXN: banking activity is informational to the Identity Manager (behaviour signals).
  'payment.sepa': { operation: 'notify', resource: 'event', priority: 'normal', requiresApproval: false },
  'payment.swift': { operation: 'notify', resource: 'event', priority: 'high', requiresApproval: false },
  'trade.book': { operation: 'notify', resource: 'event', priority: 'normal', requiresApproval: false },
  'card.txn': { operation: 'notify', resource: 'event', priority: 'low', requiresApproval: false },
  'wire.approval': { operation: 'notify', resource: 'event', priority: 'high', requiresApproval: true },
  'limit.breach': { operation: 'notify', resource: 'event', priority: 'high', requiresApproval: false },
  'highvalue.alert': { operation: 'notify', resource: 'event', priority: 'high', requiresApproval: false },
  // COMPLIANCE: governance signals; erasure and break-glass gate on approval.
  'gdpr.request': { operation: 'notify', resource: 'identity', priority: 'high', requiresApproval: true },
  'audit.pull': { operation: 'notify', resource: 'event', priority: 'normal', requiresApproval: false },
  'nhi.activity': { operation: 'notify', resource: 'account', priority: 'normal', requiresApproval: false },
  breakglass: { operation: 'grant', resource: 'account', priority: 'critical', requiresApproval: true },
  'duplicate.identity': { operation: 'notify', resource: 'identity', priority: 'high', requiresApproval: false },
  namecollision: { operation: 'patch', resource: 'identity', priority: 'normal', requiresApproval: false },
};

/** Provisioning operations that mutate the Identity Manager and need a stable idempotency key. */
const MUTATING_OPERATIONS: ReadonlySet<ProvisioningOperation> = new Set<ProvisioningOperation>([
  'create',
  'update',
  'patch',
  'deactivate',
  'reactivate',
  'delete',
  'grant',
  'revoke',
]);

/** Inputs needed to derive an event's idempotency key. */
export interface DeliveryKeyContext {
  eventId: string;
  correlationId: string;
  subjectId?: string;
  /** Entitlement id for grant/revoke operations, when known. */
  entitlementId?: string;
}

/**
 * Build the full delivery metadata for an event, deriving a stable idempotency key.
 *
 * For informational (notify) kinds the key is simply the event id: redelivering the
 * same event is naturally deduplicated. For mutating operations the key is semantic,
 * `operation:subject:entitlement-or-correlation`, so that at-least-once delivery of
 * the SAME logical provisioning step is deduplicated while two genuinely different
 * steps (a grant then a later revoke of the same grant) stay distinct via their
 * unique saga correlation.
 *
 * @param kind The event kind.
 * @param keyCtx Identity/correlation context for the key.
 * @returns The complete delivery metadata.
 */
export function deliveryMetaFor(kind: EventKind, keyCtx: DeliveryKeyContext): EventDeliveryMeta {
  const base = DELIVERY_BASE[kind];
  const idempotencyKey = MUTATING_OPERATIONS.has(base.operation)
    ? `${base.operation}:${keyCtx.subjectId ?? 'na'}:${keyCtx.entitlementId ?? keyCtx.correlationId}`
    : keyCtx.eventId;
  return {
    operation: base.operation,
    resource: base.resource,
    idempotencyKey,
    priority: base.priority,
    requiresApproval: base.requiresApproval,
  };
}
