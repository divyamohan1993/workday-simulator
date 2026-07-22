/**
 * SCIM 2.0 sender: maps a WorkdayEvent onto an RFC 7643/7644 User or Group
 * operation and emits it to a SCIM service.
 *
 * WHY it imports the SCIM types from `../domain/scim.js` rather than defining its
 * own: that module is the ONE agreed representation of a Deutsche Bank identity
 * as a SCIM resource, shared by this sender and the built-in receiver. Reusing
 * `SCIM_SCHEMA` and the `Scim*` shapes here guarantees the bytes this sender
 * writes are exactly what the receiver parses, so the two cannot drift.
 *
 * Mapping is driven by `event.delivery` (operation + resource), per the frozen
 * cross-cutting protocol, NOT by sniffing each event kind. The one narrow peek
 * into a payload is to recover an entitlement/group id for grant/revoke, the
 * only place that id lives. Events whose operation is not a provisioning change
 * (auth, most transactions: notify/noop) are acknowledged locally with no wire
 * call, exactly as a real SCIM connector would ignore them.
 *
 * Because an event carries the compact `IdentityRef`, not a full `Employee`, the
 * SCIM user built here is a faithful subset (id, externalId, userName, name,
 * displayName, userType, active, work email, enterprise employeeNumber and
 * division). Attributes absent from the ref (cost center, manager) are omitted
 * rather than fabricated.
 */

import type { IdentityRef, WorkdayEvent } from '../types/index.js';
import {
  SCIM_SCHEMA,
  type ScimEnterpriseUser,
  type ScimGroup,
  type ScimName,
  type ScimUser,
} from '../domain/scim.js';
import { DIVISION_CODE } from '../domain/org.js';
import { CONTENT_TYPE, DEFAULT_REQUEST_TIMEOUT_MS, IDEMPOTENCY_HEADER } from './constants.js';
import type {
  Authenticator,
  HttpMethod,
  HttpRequestSpec,
  HttpTransport,
  SendResult,
  SingleSender,
  BatchSender,
} from './types.js';
import { authenticateAndSend, extractEtag, extractReceiverRef } from './wire.js';

/** A planned SCIM request (relative path + structured body) or a local no-op. */
export type ScimPlan =
  | { kind: 'noop'; reason: string }
  | {
      kind: 'wire';
      method: HttpMethod;
      /** Path relative to the SCIM base, e.g. "/Users" or "/Users/abc". */
      path: string;
      /** Structured body; serialized for single sends, embedded for Bulk. */
      body?: unknown;
      /** The affected user id, when the operation targets a user. */
      userId?: string;
      /** Whether to remember an ETag from the response for later If-Match. */
      storeEtag: boolean;
    };

/** The affected identity: the subject when set, else the acting identity. */
function affectedIdentity(event: WorkdayEvent): IdentityRef | undefined {
  if (event.subject) return event.subject;
  return event.actor.kind === 'system' ? undefined : event.actor;
}

/** Split a display name into SCIM given/family parts, tolerating mononyms. */
function splitName(displayName: string): ScimName {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) {
    const only = parts[0] ?? displayName;
    return { formatted: displayName, givenName: only, familyName: only };
  }
  const familyName = parts[parts.length - 1] ?? displayName;
  const givenName = parts.slice(0, -1).join(' ');
  return { formatted: displayName, givenName, familyName };
}

/** Derive a userName from the email local-part, falling back to the HR id. */
function userNameFor(ref: IdentityRef): string {
  const at = ref.email.indexOf('@');
  const local = at > 0 ? ref.email.slice(0, at) : '';
  return local.length > 0 ? local : ref.employeeId;
}

/** Build a SCIM User (enterprise extension) from a compact identity ref. */
function scimUserFromRef(ref: IdentityRef, active: boolean, baseUrl: string): ScimUser {
  const enterprise: ScimEnterpriseUser = {
    employeeNumber: ref.employeeId,
    costCenter: '',
    organization: '',
    division: `${ref.division} (${DIVISION_CODE[ref.division]})`,
    department: '',
  };
  return {
    schemas: [SCIM_SCHEMA.USER, SCIM_SCHEMA.ENTERPRISE_USER],
    id: ref.id,
    externalId: ref.employeeId,
    userName: userNameFor(ref),
    name: splitName(ref.displayName),
    displayName: ref.displayName,
    userType: ref.type,
    active,
    emails: [{ value: ref.email, type: 'work', primary: true }],
    groups: [],
    [SCIM_SCHEMA.ENTERPRISE_USER]: enterprise,
    meta: {
      resourceType: 'User',
      created: ref.id,
      lastModified: ref.id,
      location: `${baseUrl}/Users/${ref.id}`,
    },
  };
}

/** A SCIM PatchOp that replaces the `active` flag. */
function patchActive(active: boolean): unknown {
  return {
    schemas: [SCIM_SCHEMA.PATCH_OP],
    Operations: [{ op: 'replace', path: 'active', value: active }],
  };
}

/** A SCIM PatchOp replacing the core mutable attributes we can derive. */
function patchAttributes(ref: IdentityRef): unknown {
  return {
    schemas: [SCIM_SCHEMA.PATCH_OP],
    Operations: [
      { op: 'replace', path: 'displayName', value: ref.displayName },
      { op: 'replace', path: 'name.formatted', value: ref.displayName },
      { op: 'replace', path: 'emails[type eq "work"].value', value: ref.email },
    ],
  };
}

/** A SCIM PatchOp adding one member to a group. */
function patchAddMember(userId: string, display: string): unknown {
  return {
    schemas: [SCIM_SCHEMA.PATCH_OP],
    Operations: [{ op: 'add', path: 'members', value: [{ value: userId, display }] }],
  };
}

/** A SCIM PatchOp removing one member from a group by id. */
function patchRemoveMember(userId: string): unknown {
  return {
    schemas: [SCIM_SCHEMA.PATCH_OP],
    Operations: [{ op: 'remove', path: `members[value eq "${userId}"]` }],
  };
}

/** A minimal SCIM Group create body (the receiver assigns the id). */
function createGroupBody(entId: string, name: string): Partial<ScimGroup> & { externalId: string } {
  return { schemas: [SCIM_SCHEMA.GROUP], externalId: entId, displayName: name, members: [] };
}

/**
 * Recover the entitlement/group reference for grant/revoke operations. This is
 * the only place a group id lives, so a narrow, typed peek into the payload is
 * warranted; every other mapping decision uses `event.delivery` alone.
 */
function entitlementRefOf(event: WorkdayEvent): { id: string; name: string } | undefined {
  switch (event.kind) {
    case 'access.request':
    case 'access.provision':
    case 'access.revoke':
      return { id: event.payload.entitlement.id, name: event.payload.entitlement.name };
    case 'recertification':
      return event.payload.entitlement
        ? { id: event.payload.entitlement.id, name: event.payload.entitlement.name }
        : undefined;
    case 'firefighter.grant':
    case 'firefighter.revoke':
      // Firefighter roles have no catalog id; synthesize a stable group id so the
      // grant/revoke still exercises a SCIM Group membership change.
      return {
        id: `FF-${event.payload.system}-${event.payload.role}`,
        name: `${event.payload.role} (${event.payload.system})`,
      };
    default:
      return undefined;
  }
}

/** Normalize a SCIM base URL (drop a trailing slash). */
export function normalizeScimBase(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Map an event to a SCIM request plan using its delivery metadata. Pure and
 * side-effect free, so the payload shape is unit-testable without a transport.
 *
 * @param event The event to map.
 * @param baseUrl The SCIM service base URL (for `meta.location`).
 * @returns A wire plan or a no-op with a reason.
 */
export function planScimRequest(event: WorkdayEvent, baseUrl: string): ScimPlan {
  const base = normalizeScimBase(baseUrl);
  const affected = affectedIdentity(event);
  const userId = affected?.id;
  const { operation, resource } = event.delivery;

  switch (operation) {
    case 'create':
      if (resource === 'group') {
        const ent = entitlementRefOf(event);
        if (!ent) return { kind: 'noop', reason: 'group create without an entitlement ref' };
        return { kind: 'wire', method: 'POST', path: '/Groups', body: createGroupBody(ent.id, ent.name), storeEtag: false };
      }
      if (!affected) return { kind: 'noop', reason: 'identity create without a subject' };
      return { kind: 'wire', method: 'POST', path: '/Users', body: scimUserFromRef(affected, true, base), userId, storeEtag: true };

    case 'update':
      if (!affected || !userId) return { kind: 'noop', reason: 'update without a subject' };
      return {
        kind: 'wire',
        method: 'PUT',
        path: `/Users/${userId}`,
        body: scimUserFromRef(affected, true, base),
        userId,
        storeEtag: true,
      };

    case 'patch':
      if (!affected || !userId) return { kind: 'noop', reason: 'patch without a subject' };
      return { kind: 'wire', method: 'PATCH', path: `/Users/${userId}`, body: patchAttributes(affected), userId, storeEtag: true };

    case 'deactivate':
      if (!userId) return { kind: 'noop', reason: 'deactivate without a subject' };
      return { kind: 'wire', method: 'PATCH', path: `/Users/${userId}`, body: patchActive(false), userId, storeEtag: true };

    case 'reactivate':
      if (!userId) return { kind: 'noop', reason: 'reactivate without a subject' };
      return { kind: 'wire', method: 'PATCH', path: `/Users/${userId}`, body: patchActive(true), userId, storeEtag: true };

    case 'delete':
      if (!userId) return { kind: 'noop', reason: 'delete without a subject' };
      return { kind: 'wire', method: 'DELETE', path: `/Users/${userId}`, userId, storeEtag: false };

    case 'grant': {
      const ent = entitlementRefOf(event);
      if (!ent || !userId) return { kind: 'noop', reason: 'grant without entitlement or subject' };
      return {
        kind: 'wire',
        method: 'PATCH',
        path: `/Groups/${encodeURIComponent(ent.id)}`,
        body: patchAddMember(userId, affected?.displayName ?? userId),
        storeEtag: false,
      };
    }

    case 'revoke': {
      const ent = entitlementRefOf(event);
      if (!ent || !userId) return { kind: 'noop', reason: 'revoke without entitlement or subject' };
      return {
        kind: 'wire',
        method: 'PATCH',
        path: `/Groups/${encodeURIComponent(ent.id)}`,
        body: patchRemoveMember(userId),
        storeEtag: false,
      };
    }

    case 'notify':
    case 'noop':
      return { kind: 'noop', reason: 'non-provisioning operation' };

    default: {
      const _exhaustive: never = operation;
      void _exhaustive;
      return { kind: 'noop', reason: 'unmapped operation' };
    }
  }
}

/** Options for {@link createScimSender}. */
export interface ScimSenderOptions {
  target: { url: string; headers: Record<string, string>; batchSize?: number };
  transport: HttpTransport;
  auth: Authenticator;
  now?: () => number;
  timeoutMs?: number;
  /** Max cached ETags before the oldest are evicted (bounded memory). */
  etagCacheLimit?: number;
}

/** Max SCIM Bulk operations we will assemble into one request. */
const MAX_BULK_OPERATIONS = 1000;

/**
 * A SCIM sender. Single-mode by default; when the target sets `batchSize > 1`
 * it becomes a batch sender that coalesces operations into a SCIM BulkRequest.
 */
export function createScimSender(options: ScimSenderOptions): SingleSender | BatchSender {
  const base = normalizeScimBase(options.target.url);
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const etagLimit = options.etagCacheLimit ?? 10_000;
  /** Insertion-ordered ETag cache for optimistic-concurrency If-Match headers. */
  const etags = new Map<string, string>();

  const rememberEtag = (userId: string | undefined, etag: string | undefined): void => {
    if (!userId || !etag) return;
    if (etags.size >= etagLimit) {
      const oldest = etags.keys().next().value;
      if (oldest !== undefined) etags.delete(oldest);
    }
    etags.set(userId, etag);
  };

  const buildHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
    ...options.target.headers,
    'content-type': CONTENT_TYPE.scim,
    accept: CONTENT_TYPE.scim,
    ...extra,
  });

  const sendPlan = async (event: WorkdayEvent, plan: Extract<ScimPlan, { kind: 'wire' }>): Promise<SendResult> => {
    const headers = buildHeaders({ [IDEMPOTENCY_HEADER]: event.delivery.idempotencyKey });
    // Optimistic concurrency: attach If-Match when we hold an ETag for this user.
    if (plan.userId && (plan.method === 'PUT' || plan.method === 'PATCH' || plan.method === 'DELETE')) {
      const etag = etags.get(plan.userId);
      if (etag) headers['if-match'] = etag;
    }
    const spec: HttpRequestSpec = {
      method: plan.method,
      url: `${base}${plan.path}`,
      headers,
      ...(plan.body !== undefined ? { body: JSON.stringify(plan.body) } : {}),
    };
    const response = await authenticateAndSend({ transport: options.transport, auth: options.auth, timeoutMs, now }, spec);
    if (plan.storeEtag) rememberEtag(plan.userId, extractEtag(response));
    const receiverRef = extractReceiverRef(response) ?? plan.userId;
    return { httpStatus: response.status, ...(receiverRef ? { receiverRef } : {}) };
  };

  const start = async (): Promise<void> => {
    /* Auth is warmed lazily on first send; nothing to open eagerly. */
  };
  const stop = async (): Promise<void> => {
    options.auth.stop();
    await options.transport.close();
  };

  // Batch (SCIM Bulk) mode.
  if (options.target.batchSize && options.target.batchSize > 1) {
    const batchSize = Math.min(options.target.batchSize, MAX_BULK_OPERATIONS);
    return {
      mode: 'batch',
      batchSize,
      start,
      stop,
      async sendBatch(events: WorkdayEvent[]): Promise<SendResult> {
        const operations: Array<{ method: HttpMethod; bulkId: string; path: string; data?: unknown }> = [];
        for (const event of events) {
          const plan = planScimRequest(event, base);
          if (plan.kind === 'noop') continue;
          operations.push({
            method: plan.method,
            bulkId: event.id,
            path: plan.path,
            ...(plan.body !== undefined ? { data: plan.body } : {}),
          });
        }
        if (operations.length === 0) return { noop: true };
        const spec: HttpRequestSpec = {
          method: 'POST',
          url: `${base}/Bulk`,
          headers: buildHeaders(),
          body: JSON.stringify({ schemas: [SCIM_SCHEMA.BULK_REQUEST], Operations: operations }),
        };
        const response = await authenticateAndSend(
          { transport: options.transport, auth: options.auth, timeoutMs, now },
          spec,
        );
        return { httpStatus: response.status };
      },
    };
  }

  // Single mode.
  return {
    mode: 'single',
    start,
    stop,
    async sendOne(event: WorkdayEvent): Promise<SendResult> {
      const plan = planScimRequest(event, base);
      if (plan.kind === 'noop') return { noop: true };
      return sendPlan(event, plan);
    },
  };
}
