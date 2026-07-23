/**
 * The reference One Identity Manager provisioning engine.
 *
 * WHY it is the orchestrator: the SCIM store, connector pool, SoD detector,
 * approval queue, orphan/dormant detectors, idempotency dedup and inbound rate
 * limiter are each single-responsibility pieces; the engine is where an inbound
 * request or event becomes provisioning work, governance findings and statistics.
 * Keeping the composition here (and the HTTP concerns in the plugin, and the pure
 * logic in the pieces) is what makes every part testable on its own.
 *
 * Determinism and testability: all timing flows through an injected `now()` and a
 * `pump(now)` method, so a test can advance the clock and observe async
 * provisioning complete, queues deepen, latency rise, and approvals settle, with
 * no real timers. Randomness is a seeded PRNG. In production `createReceiver`
 * drives `pump` from one unref'd interval.
 */

import type { Logger } from 'pino';
import { createPrng, type Prng } from '../engine/prng.js';
import { ALL_ENTITLEMENT_TEMPLATES } from '../domain/entitlements.js';
import { SCIM_SCHEMA, type ScimGroup, type ScimUser } from '../domain/scim.js';
import { SOD_RULES, type SodRule } from '../domain/sod.js';
import { nanoid } from 'nanoid';
import type {
  ConnectorStat,
  IdentityRef,
  ProvisioningOperation,
  ProvisioningResource,
  ReceiverStats,
  WorkdayEvent,
} from '../types/index.js';
import {
  DEFAULT_APPROVAL_APPROVE_RATE,
  DEFAULT_APPROVAL_DELAY_MS,
  DEFAULT_BACKPRESSURE_HIGH_WATER,
  DEFAULT_CONNECTOR,
  DEFAULT_CONNECTOR_PROFILES,
  DEFAULT_DETECTION_INTERVAL_MS,
  DEFAULT_DORMANT_THRESHOLD_MS,
  DEFAULT_FINDINGS_RING,
  DEFAULT_RATE_LIMIT_BURST,
  DEFAULT_RATE_LIMIT_MAX_KEYS,
  DEFAULT_RATE_LIMIT_RPS,
  DEFAULT_SEEN_KEY_CAPACITY,
  DEFAULT_SHED_RETRY_AFTER_SEC,
  IDENTITY_MAILBOX_CONNECTOR,
  IDENTITY_PRIMARY_CONNECTOR,
  SYSTEM_TO_CONNECTOR,
} from './constants.js';
import { createConnectorPool, type ConnectorPool } from './connectors.js';
import { detectDormant, detectOrphans } from './detectors.js';
import { eventToProvisionPlan, type EventProvisionPlan, type HrRowPlan } from './ingest.js';
import { createRateLimiter, type RateDecision, type RateLimiter } from './rate-limiter.js';
import { ScimStore, type CreateResult } from './scim-store.js';
import { classifyDuties, detectConflicts } from './sod-detector.js';
import type {
  AccountFinding,
  AdmissionDecision,
  ConnectorProfile,
  HeldEntitlement,
  ProvisionRequest,
  SodFinding,
} from './types.js';

/** Options for {@link createReceiverEngine}. All are defaulted for production use. */
export interface ReceiverEngineOptions {
  logger: Logger;
  /** Seed for deterministic connector jitter and approval decisions. */
  seed?: string;
  /** When false, provisioning completes immediately with no simulated latency. */
  simulateLatency?: boolean;
  /** Injectable wall clock (ms). Defaults to Date.now. */
  now?: () => number;
  /** Connector profiles; defaults to the realistic AD/Exchange/SAP/mainframe set. */
  connectors?: readonly ConnectorProfile[];
  /** SoD rule set; defaults to the frozen bank rules. */
  sodRules?: readonly SodRule[];
  /** Per-source inbound rate limit. */
  rateLimit?: { ratePerSec?: number; burst?: number; maxKeys?: number };
  /** Total queued work at which inbound requests are shed with 429. */
  backpressureHighWater?: number;
  /** Retry-After seconds advised on a backpressure shed. */
  shedRetryAfterSec?: number;
  /** Wall ms an approval waits before it is auto-decided. */
  approvalDelayMs?: number;
  /** Fraction of approvals approved rather than denied. */
  approvalApproveRate?: number;
  /** Simulated-time dormancy window (ms). */
  dormantThresholdMs?: number;
  /** How often detection runs off the pump (wall ms). */
  detectionIntervalMs?: number;
  /** Max remembered idempotency keys (bounded memory). */
  seenKeyCapacity?: number;
}

/** A pending approval: the provisioning it gates and when it is auto-decided. */
interface ApprovalItem {
  req: ProvisionRequest;
  dueAtMs: number;
}

/** Catalog label -> target system, for routing SCIM-path grants to a connector. */
const LABEL_TO_SYSTEM: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const t of ALL_ENTITLEMENT_TEMPLATES) map.set(t.label, t.system);
  return map;
})();

/** A bounded, insertion-ordered set for at-least-once idempotency dedup. */
class BoundedKeySet {
  private readonly keys = new Set<string>();
  constructor(private readonly capacity: number) {}
  /** Add a key; returns true when it was not seen before (first delivery). */
  add(key: string): boolean {
    if (key.length === 0) return true; // no key: never dedup
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    if (this.keys.size > this.capacity) {
      const oldest = this.keys.values().next().value;
      if (oldest !== undefined) this.keys.delete(oldest);
    }
    return true;
  }
  clear(): void {
    this.keys.clear();
  }
}

/** Push to a bounded newest-last ring, evicting the oldest past `cap`. */
function pushRing<T>(ring: T[], item: T, cap: number): void {
  ring.push(item);
  if (ring.length > cap) ring.shift();
}

/** Derive a SCIM userName from an email local-part, falling back to the HR id. */
function userNameFromEmail(email: string, employeeId: string): string {
  const at = email.indexOf('@');
  const local = at > 0 ? email.slice(0, at) : '';
  return local.length > 0 ? local : employeeId || `user-${nanoid(8)}`;
}

/** A SCIM PatchOp replacing the `active` flag. */
function patchActive(active: boolean): unknown {
  return { schemas: [SCIM_SCHEMA.PATCH_OP], Operations: [{ op: 'replace', path: 'active', value: active }] };
}

/**
 * The reference identity-manager engine. Consumed by the Fastify plugin (HTTP) and
 * by the NATS bridge; exposed with enough surface for unit tests to drive it
 * directly without HTTP.
 */
export class ReceiverEngine {
  readonly store = new ScimStore();
  private readonly pool: ConnectorPool;
  private readonly limiter: RateLimiter;
  private readonly prng: Prng;
  private readonly approvalPrng: Prng;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly sodRules: readonly SodRule[];
  private readonly backpressureHighWater: number;
  private readonly shedRetryAfterSec: number;
  private readonly approvalDelayMs: number;
  private readonly approvalApproveRate: number;
  private readonly dormantThresholdMs: number;
  private readonly detectionIntervalMs: number;

  private readonly seen: BoundedKeySet;
  private readonly held = new Map<string, Map<string, HeldEntitlement>>();
  private readonly seenConflicts = new Set<string>();
  private approvals: ApprovalItem[] = [];

  private totalIngested = 0;
  private lastIngestAtIso: string | undefined;
  private lastSimMs = 0;
  private sodViolations = 0;
  private approvalsApproved = 0;
  private approvalsDenied = 0;
  private orphanGauge = 0;
  private dormantGauge = 0;
  private lastDetectionMs = 0;

  private readonly sodFindings: SodFinding[] = [];
  private readonly accountFindings: AccountFinding[] = [];

  constructor(options: ReceiverEngineOptions) {
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.sodRules = options.sodRules ?? SOD_RULES;
    this.backpressureHighWater = options.backpressureHighWater ?? DEFAULT_BACKPRESSURE_HIGH_WATER;
    this.shedRetryAfterSec = options.shedRetryAfterSec ?? DEFAULT_SHED_RETRY_AFTER_SEC;
    this.approvalDelayMs = options.approvalDelayMs ?? DEFAULT_APPROVAL_DELAY_MS;
    this.approvalApproveRate = options.approvalApproveRate ?? DEFAULT_APPROVAL_APPROVE_RATE;
    this.dormantThresholdMs = options.dormantThresholdMs ?? DEFAULT_DORMANT_THRESHOLD_MS;
    this.detectionIntervalMs = options.detectionIntervalMs ?? DEFAULT_DETECTION_INTERVAL_MS;
    this.seen = new BoundedKeySet(options.seenKeyCapacity ?? DEFAULT_SEEN_KEY_CAPACITY);

    const seed = options.seed ?? 'receiver';
    this.prng = createPrng(`${seed}:receiver`);
    this.approvalPrng = this.prng.fork('approvals');
    this.pool = createConnectorPool({
      profiles: options.connectors ?? DEFAULT_CONNECTOR_PROFILES,
      prng: this.prng.fork('connectors'),
      simulateLatency: options.simulateLatency ?? true,
    });
    this.limiter = createRateLimiter({
      ratePerSec: options.rateLimit?.ratePerSec ?? DEFAULT_RATE_LIMIT_RPS,
      burst: options.rateLimit?.burst ?? DEFAULT_RATE_LIMIT_BURST,
      maxKeys: options.rateLimit?.maxKeys ?? DEFAULT_RATE_LIMIT_MAX_KEYS,
    });
  }

  /* --- Admission (inbound rate limit + backpressure shedding) -------------- */

  /**
   * Decide whether to admit an inbound request from `source`. Refuses with a
   * Retry-After when the per-source token bucket is empty or when total queued
   * work has reached the backpressure high-water (an overwhelmed identity manager).
   */
  admit(source: string): AdmissionDecision {
    const depth = this.backpressureDepth();
    if (depth >= this.backpressureHighWater) {
      return { admitted: false, retryAfterSec: this.shedRetryAfterSec, reason: 'backpressure' };
    }
    const decision: RateDecision = this.limiter.tryAdmit(source, this.now());
    if (!decision.allowed) {
      return { admitted: false, retryAfterSec: decision.retryAfterSec, reason: 'rate_limited' };
    }
    return { admitted: true, retryAfterSec: 0 };
  }

  /** Total queued + in-flight connector work plus pending approvals. */
  backpressureDepth(): number {
    return this.pool.queueDepth() + this.approvals.length;
  }

  /* --- SCIM Users ---------------------------------------------------------- */

  /** Create (upsert) a SCIM user and enqueue account+mailbox provisioning. */
  scimCreateUser(body: unknown, key: string): CreateResult<ScimUser> & { etag: string | undefined } {
    const now = this.now();
    const result = this.store.createUser(body, now, this.lastSimMs);
    if (this.seen.add(key)) {
      this.countIngest(now);
      this.submitProvision({ userId: result.resource.id, operation: 'create', resource: 'identity' }, false);
    }
    return { ...result, etag: this.store.userEtag(result.resource.id) };
  }

  /** Fetch a user (throws ScimError 404 if absent). */
  scimGetUser(id: string): ScimUser {
    return this.store.getUser(id);
  }

  /** List users with a compiled filter predicate and pagination. */
  scimListUsers(
    predicate: (user: ScimUser) => boolean,
    startIndex: number,
    count: number,
  ): { resources: ScimUser[]; total: number } {
    return this.store.listUsers(predicate, startIndex, count);
  }

  /** Replace a user (PUT); upsert an unknown id, then enqueue an update. */
  scimReplaceUser(id: string, body: unknown, key: string): { user: ScimUser; etag: string | undefined } {
    const now = this.now();
    let user: ScimUser;
    if (this.store.hasLiveUser(id)) {
      user = this.store.replaceUser(id, body, now, this.lastSimMs);
    } else {
      // Tolerant upsert: a PUT for a pre-existing employee the receiver was never sent a
      // create for (the identity pool is seeded independently of this run, so leaver/mover
      // subjects are almost always ids the receiver has not seen) materializes the account
      // instead of 404-ing an at-least-once stream. This is ingest-path parity (ensureUser);
      // createUser honors the client-supplied id so the round-trip id is preserved.
      const withId =
        typeof body === 'object' && body !== null ? { ...(body as Record<string, unknown>), id } : body;
      user = this.store.createUser(withId, now, this.lastSimMs).resource;
    }
    if (this.seen.add(key)) {
      this.countIngest(now);
      this.submitProvision({ userId: id, operation: 'update', resource: 'identity' }, false);
    }
    return { user, etag: this.store.userEtag(id) };
  }

  /** PATCH a user; enqueue deactivate/reactivate/update by what changed. */
  scimPatchUser(id: string, patchOp: unknown, key: string): { user: ScimUser; etag: string | undefined } {
    const now = this.now();
    if (!this.store.hasLiveUser(id)) {
      // Tolerant: materialize a minimal account so a PATCH for a pre-existing employee
      // (e.g. a leaver deactivation or a manager-change) lands and is recorded for
      // orphan/dormancy accounting instead of 404-ing. Ingest-path parity (ensureUser);
      // userName=id keeps the shell unique until a fuller record arrives.
      this.store.createUser(
        { schemas: [SCIM_SCHEMA.USER], id, userName: id, active: true },
        now,
        this.lastSimMs,
      );
    }
    const { user, activeChanged, active } = this.store.patchUser(id, patchOp, now, this.lastSimMs);
    if (this.seen.add(key)) {
      this.countIngest(now);
      const operation: ProvisioningOperation = activeChanged ? (active ? 'reactivate' : 'deactivate') : 'patch';
      this.submitProvision({ userId: id, operation, resource: 'identity' }, false);
    }
    return { user, etag: this.store.userEtag(id) };
  }

  /**
   * Soft-delete (deprovision) a user and enqueue the downstream removal. Idempotent: a
   * delete for an id the receiver never materialized succeeds as a no-op (the account
   * simply does not exist on this target) rather than 404-ing an at-least-once stream.
   */
  scimDeleteUser(id: string, key: string): void {
    const now = this.now();
    if (this.store.hasLiveUser(id)) {
      this.store.deleteUser(id, now);
    }
    if (this.seen.add(key)) {
      this.countIngest(now);
      this.submitProvision({ userId: id, operation: 'delete', resource: 'identity' }, false);
    }
  }

  /* --- SCIM Groups --------------------------------------------------------- */

  /** Create (upsert) a group. A bare group create does no downstream provisioning. */
  scimCreateGroup(body: unknown, key: string): CreateResult<ScimGroup> {
    const now = this.now();
    const result = this.store.createGroup(body, now);
    if (this.seen.add(key)) this.countIngest(now);
    return result;
  }

  /** Fetch a group (throws ScimError 404 if absent). */
  scimGetGroup(id: string): ScimGroup {
    return this.store.getGroup(id);
  }

  /** PATCH group membership; each add/remove records SoD state and provisions. */
  scimPatchGroup(id: string, patchOp: unknown, key: string): { group: ScimGroup } {
    const now = this.now();
    const { group, addedUserIds, removedUserIds } = this.store.patchGroup(id, patchOp, now);
    if (this.seen.add(key)) {
      this.countIngest(now);
      const system = LABEL_TO_SYSTEM.get(group.displayName);
      for (const userId of addedUserIds) {
        this.recordGrant(userId, { id: group.id, name: group.displayName, system });
        this.submitProvision({ userId, operation: 'grant', resource: 'entitlement', system }, false);
      }
      for (const userId of removedUserIds) {
        this.recordRevoke(userId, group.id);
        this.submitProvision({ userId, operation: 'revoke', resource: 'entitlement', system }, false);
      }
    }
    return { group };
  }

  /* --- Ingest (webhook / REST / NATS events, and HR rows) ------------------ */

  /** Ingest one WorkdayEvent from the webhook/REST/NATS surface. */
  ingestEvent(event: WorkdayEvent): void {
    this.applyEventPlan(eventToProvisionPlan(event));
  }

  /** Ingest one parsed HR-feed row (identity-level create/update/leave). */
  ingestHrRow(row: HrRowPlan): void {
    const now = this.now();
    if (row.simTimeMs > 0) this.lastSimMs = Math.max(this.lastSimMs, row.simTimeMs);
    if (!this.seen.add(row.idempotencyKey)) return;
    this.countIngest(now);
    switch (row.operation) {
      case 'create':
      case 'update':
      case 'reactivate':
        if (row.identity) this.ensureUser(row.identity, now);
        this.submitProvision({ userId: row.userId, operation: row.operation, resource: 'identity' }, false);
        break;
      case 'patch':
        this.store.touchUser(row.userId, now, this.lastSimMs);
        this.submitProvision({ userId: row.userId, operation: 'patch', resource: 'identity' }, false);
        break;
      case 'deactivate':
        this.tryPatchActive(row.userId, false, now);
        this.submitProvision({ userId: row.userId, operation: 'deactivate', resource: 'identity' }, false);
        break;
      case 'delete':
        this.tryDelete(row.userId, now);
        this.submitProvision({ userId: row.userId, operation: 'delete', resource: 'identity' }, false);
        break;
      default:
        break;
    }
  }

  /* --- Lifecycle ----------------------------------------------------------- */

  /**
   * Advance the engine to `nowMs`: settle due approvals (which enqueue their
   * provisioning), then drain the connectors, then run orphan/dormant detection on
   * its cadence. Approvals settle before the drain so a just-approved task can
   * complete within the same pump when latency simulation is off.
   */
  pump(nowMs: number): void {
    this.processApprovals(nowMs);
    this.pool.pump(nowMs);
    if (nowMs - this.lastDetectionMs >= this.detectionIntervalMs) {
      this.runDetection(nowMs);
      this.lastDetectionMs = nowMs;
    }
  }

  /** Run orphan/dormant detection immediately (also called on the pump cadence). */
  runDetection(nowMs: number): void {
    const orphans = detectOrphans(this.store, nowMs);
    const dormant = detectDormant(this.store, this.lastSimMs, this.dormantThresholdMs, nowMs);
    this.orphanGauge = orphans.length;
    this.dormantGauge = dormant.length;
    for (const finding of orphans) pushRing(this.accountFindings, finding, DEFAULT_FINDINGS_RING);
    for (const finding of dormant) pushRing(this.accountFindings, finding, DEFAULT_FINDINGS_RING);
  }

  /** Assemble the aggregate statistics exposed to the metrics registry. */
  stats(): ReceiverStats {
    const totals = this.pool.totals();
    const byConnector: Record<string, ConnectorStat> = this.pool.stats();
    return {
      queueDepth: totals.queueDepth + this.approvals.length,
      provisioned: totals.provisioned,
      failed: totals.failed,
      sodViolations: this.sodViolations,
      orphans: this.orphanGauge,
      dormant: this.dormantGauge,
      avgProvisionMs: totals.avgProvisionMs,
      byConnector,
      totalIngested: this.totalIngested,
      ...(this.lastIngestAtIso ? { lastIngestAt: this.lastIngestAtIso } : {}),
    };
  }

  /** Clear all provisioned state, findings, dedup memory and counters. */
  reset(): void {
    this.store.reset();
    this.pool.reset();
    this.limiter.reset();
    this.seen.clear();
    this.held.clear();
    this.seenConflicts.clear();
    this.approvals = [];
    this.totalIngested = 0;
    this.lastIngestAtIso = undefined;
    this.lastSimMs = 0;
    this.sodViolations = 0;
    this.approvalsApproved = 0;
    this.approvalsDenied = 0;
    this.orphanGauge = 0;
    this.dormantGauge = 0;
    this.lastDetectionMs = 0;
    this.sodFindings.length = 0;
    this.accountFindings.length = 0;
  }

  /* --- Inspection (for the plugin's diagnostic surface and tests) ---------- */

  /** A bounded snapshot of recent SoD findings. */
  sodFindingsSnapshot(): readonly SodFinding[] {
    return this.sodFindings;
  }

  /** A bounded snapshot of recent orphan/dormant findings. */
  accountFindingsSnapshot(): readonly AccountFinding[] {
    return this.accountFindings;
  }

  /** Approval tallies (not part of ReceiverStats; useful for diagnostics/tests). */
  approvalTally(): { pending: number; approved: number; denied: number } {
    return { pending: this.approvals.length, approved: this.approvalsApproved, denied: this.approvalsDenied };
  }

  /* --- Internals ----------------------------------------------------------- */

  /** Apply a provisioning plan derived from one ingested event. */
  private applyEventPlan(plan: EventProvisionPlan): void {
    const now = this.now();
    if (plan.simTimeMs > 0) this.lastSimMs = Math.max(this.lastSimMs, plan.simTimeMs);
    if (!this.seen.add(plan.idempotencyKey)) return;
    this.countIngest(now);

    switch (plan.operation) {
      case 'create':
      case 'update':
      case 'reactivate':
        if (plan.identity) this.ensureUser(plan.identity, now);
        if (plan.userId) {
          this.submitProvision(
            { userId: plan.userId, operation: plan.operation, resource: 'identity' },
            plan.requiresApproval,
          );
        }
        break;
      case 'patch':
        if (plan.userId) {
          this.store.touchUser(plan.userId, now, this.lastSimMs);
          this.submitProvision({ userId: plan.userId, operation: 'patch', resource: 'identity' }, plan.requiresApproval);
        }
        break;
      case 'deactivate':
        if (plan.userId) {
          this.tryPatchActive(plan.userId, false, now);
          this.submitProvision({ userId: plan.userId, operation: 'deactivate', resource: 'identity' }, false);
        }
        break;
      case 'delete':
        if (plan.userId) {
          this.tryDelete(plan.userId, now);
          this.submitProvision({ userId: plan.userId, operation: 'delete', resource: 'identity' }, false);
        }
        break;
      case 'grant':
        if (plan.userId && plan.entitlement) {
          if (plan.identity) this.ensureUser(plan.identity, now);
          this.recordGrant(plan.userId, plan.entitlement);
          this.submitProvision(
            { userId: plan.userId, operation: 'grant', resource: 'entitlement', system: plan.entitlement.system },
            plan.requiresApproval,
          );
        }
        break;
      case 'revoke':
        if (plan.userId && plan.entitlement) {
          this.recordRevoke(plan.userId, plan.entitlement.id);
          this.submitProvision(
            { userId: plan.userId, operation: 'revoke', resource: 'entitlement', system: plan.entitlement.system },
            false,
          );
        }
        break;
      default:
        // notify / noop: counted as ingested, no downstream provisioning.
        break;
    }
  }

  /** Materialize a minimal SCIM user from an identity reference if not present. */
  private ensureUser(identity: IdentityRef, nowMs: number): void {
    if (this.store.hasLiveUser(identity.id)) {
      this.store.touchUser(identity.id, nowMs, this.lastSimMs);
      return;
    }
    const body = {
      schemas: [SCIM_SCHEMA.USER],
      id: identity.id,
      externalId: identity.employeeId,
      userName: userNameFromEmail(identity.email, identity.employeeId),
      displayName: identity.displayName,
      userType: identity.type,
      active: true,
      emails: identity.email ? [{ value: identity.email, type: 'work', primary: true }] : [],
    };
    this.store.createUser(body, nowMs, this.lastSimMs);
  }

  /** Best-effort deactivate; a missing user is ignored (the event still counts). */
  private tryPatchActive(userId: string, active: boolean, nowMs: number): void {
    try {
      this.store.patchUser(userId, patchActive(active), nowMs, this.lastSimMs);
    } catch {
      /* unknown account: nothing to deactivate locally */
    }
  }

  /** Best-effort delete; a missing user is ignored. */
  private tryDelete(userId: string, nowMs: number): void {
    try {
      this.store.deleteUser(userId, nowMs);
    } catch {
      /* unknown account: nothing to delete locally */
    }
  }

  /** Record a held entitlement (classifying its duties) and evaluate SoD. */
  private recordGrant(userId: string, ent: { id: string; system?: string; name?: string; type?: HeldEntitlement['type'] }): void {
    let map = this.held.get(userId);
    if (!map) {
      map = new Map<string, HeldEntitlement>();
      this.held.set(userId, map);
    }
    const existing = map.get(ent.id);
    const name = ent.name ?? existing?.name;
    const system = ent.system ?? existing?.system;
    const type = ent.type ?? existing?.type;
    const held: HeldEntitlement = { id: ent.id, sodTags: classifyDuties(name, system, type) };
    if (system !== undefined) held.system = system;
    if (name !== undefined) held.name = name;
    if (type !== undefined) held.type = type;
    map.set(ent.id, held);
    this.evaluateSod(userId, map);
  }

  /** Drop a held entitlement on revoke (does not clear prior violations). */
  private recordRevoke(userId: string, entId: string): void {
    this.held.get(userId)?.delete(entId);
  }

  /** Detect and count any newly-appearing toxic combination for a user. */
  private evaluateSod(userId: string, held: Map<string, HeldEntitlement>): void {
    const conflicts = detectConflicts([...held.values()], this.sodRules);
    for (const conflict of conflicts) {
      const [a, b] = conflict.pair;
      const lo = a.id < b.id ? a.id : b.id;
      const hi = a.id < b.id ? b.id : a.id;
      const key = `${userId}:${conflict.rule.id}:${lo}:${hi}`;
      if (this.seenConflicts.has(key)) continue;
      this.seenConflicts.add(key);
      this.sodViolations += 1;
      pushRing(
        this.sodFindings,
        {
          userId,
          ruleId: conflict.rule.id,
          ruleName: conflict.rule.name,
          entitlementIds: [lo, hi],
          at: new Date(this.now()).toISOString(),
        },
        DEFAULT_FINDINGS_RING,
      );
      this.logger.warn(
        { userId, ruleId: conflict.rule.id, entitlements: [lo, hi] },
        'receiver detected SoD violation',
      );
    }
  }

  /** Enqueue provisioning now, or gate it behind an approval when required. */
  private submitProvision(req: ProvisionRequest, requiresApproval: boolean): void {
    if (requiresApproval) {
      this.approvals.push({ req, dueAtMs: this.now() + this.approvalDelayMs });
      return;
    }
    this.enqueue(req, this.now());
  }

  /** Expand a provisioning request into connector tasks and submit them. */
  private enqueue(req: ProvisionRequest, nowMs: number): void {
    for (const connector of this.routeConnectors(req)) {
      this.pool.submit({
        id: `task_${nanoid(10)}`,
        connector,
        userId: req.userId,
        operation: req.operation,
        resource: req.resource,
        enqueuedAtMs: nowMs,
      });
    }
  }

  /** Choose the connector(s) for a provisioning request. */
  private routeConnectors(req: ProvisionRequest): string[] {
    if (req.resource === 'identity' || req.resource === 'account') {
      return [
        this.pool.resolveConnector(IDENTITY_PRIMARY_CONNECTOR),
        this.pool.resolveConnector(IDENTITY_MAILBOX_CONNECTOR),
      ];
    }
    const system = (req.system ?? '').toLowerCase();
    const connector = SYSTEM_TO_CONNECTOR[system] ?? DEFAULT_CONNECTOR;
    return [this.pool.resolveConnector(connector)];
  }

  /** Settle approvals whose delay has elapsed, approving or denying each. */
  private processApprovals(nowMs: number): void {
    if (this.approvals.length === 0) return;
    const remaining: ApprovalItem[] = [];
    for (const item of this.approvals) {
      if (item.dueAtMs > nowMs) {
        remaining.push(item);
        continue;
      }
      if (this.approvalPrng.bool(this.approvalApproveRate)) {
        this.approvalsApproved += 1;
        this.enqueue(item.req, nowMs);
      } else {
        this.approvalsDenied += 1;
      }
    }
    this.approvals = remaining;
  }

  /** Increment the ingest counter and stamp the last-ingest time. */
  private countIngest(nowMs: number): void {
    this.totalIngested += 1;
    this.lastIngestAtIso = new Date(nowMs).toISOString();
  }
}

/**
 * Build a reference receiver engine.
 *
 * @param options Logger plus optional deterministic/tuning overrides.
 * @returns The engine.
 */
export function createReceiverEngine(options: ReceiverEngineOptions): ReceiverEngine {
  return new ReceiverEngine(options);
}
