/**
 * In-memory SCIM 2.0 resource store for the built-in receiver.
 *
 * WHY it exists and stays dumb: the store owns User and Group state and the SCIM
 * CRUD/PATCH semantics (uniqueness, soft-delete, versioning) and NOTHING else. It
 * never provisions, scores SoD or touches timers; the engine orchestrates those on
 * top. That separation keeps the SCIM correctness testable in isolation from the
 * asynchronous connector simulation.
 *
 * Two deliberate, documented deviations from strict RFC 7644 make the store a
 * tolerant reference target for an at-least-once event stream:
 * - Create is an UPSERT keyed on the client-supplied `id` (the delivery adapter
 *   sends the identity's stable id and then PATCHes the same id, so honoring it is
 *   required for round-trips). A repeat create returns the existing resource (200)
 *   instead of 409, which keeps retried deliveries from failing.
 * - Groups are keyed by `externalId` (the entitlement id the grant PATCH path
 *   references), so a grant that arrives before an explicit group create simply
 *   auto-creates the group rather than 404-ing.
 */

import { nanoid } from 'nanoid';
import {
  SCIM_SCHEMA,
  type ScimEmail,
  type ScimEnterpriseUser,
  type ScimGroup,
  type ScimMemberRef,
  type ScimName,
  type ScimUser,
} from '../domain/scim.js';
import { SCIM_BASE_PATH } from './constants.js';
import { ScimError } from './scim-resources.js';
import { applyGroupPatch, applyUserPatch, type GroupPatchResult } from './scim-patch.js';

/** A stored user plus receiver-internal bookkeeping (version, soft-delete, activity). */
interface StoredUser {
  user: ScimUser;
  version: number;
  deleted: boolean;
  /** Wall-clock ms of the last operation touching this account. */
  lastActivityMs: number;
  /** Simulated-time ms of the last activity; drives dormancy detection. */
  lastActivitySimMs: number;
}

/** A stored group plus its version counter. */
interface StoredGroup {
  group: ScimGroup;
  version: number;
}

/** The outcome of a create: the resource and whether it was newly created. */
export interface CreateResult<T> {
  resource: T;
  created: boolean;
}

/** ISO 8601 for an epoch ms value. */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A weak ETag from a monotonic version counter. */
function etagFor(version: number): string {
  return `W/"${version}"`;
}

/** Read a string field from a loose object, or undefined. */
function str(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

/** Coerce an incoming emails array into SCIM email refs. */
function coerceEmails(value: unknown): ScimEmail[] {
  if (!Array.isArray(value)) return [];
  const out: ScimEmail[] = [];
  for (const item of value) {
    if (typeof item === 'object' && item !== null) {
      const v = (item as { value?: unknown }).value;
      if (typeof v === 'string' && v.length > 0) {
        const type = (item as { type?: unknown }).type;
        const primary = (item as { primary?: unknown }).primary;
        out.push({
          value: v,
          type: type === 'home' || type === 'other' ? type : 'work',
          primary: primary === true,
        });
      }
    }
  }
  return out;
}

/** Coerce an incoming name object into a SCIM name, tolerating a mononym. */
function coerceName(value: unknown, displayFallback: string): ScimName {
  if (typeof value === 'object' && value !== null) {
    const n = value as Record<string, unknown>;
    return {
      formatted: str(n, 'formatted') ?? displayFallback,
      givenName: str(n, 'givenName') ?? displayFallback,
      familyName: str(n, 'familyName') ?? displayFallback,
    };
  }
  return { formatted: displayFallback, givenName: displayFallback, familyName: displayFallback };
}

/** Copy the enterprise extension through if present and well-formed. */
function coerceEnterprise(body: Record<string, unknown>): ScimEnterpriseUser | undefined {
  const ext = body[SCIM_SCHEMA.ENTERPRISE_USER];
  if (typeof ext !== 'object' || ext === null) return undefined;
  const e = ext as Record<string, unknown>;
  return {
    employeeNumber: str(e, 'employeeNumber') ?? '',
    costCenter: str(e, 'costCenter') ?? '',
    organization: str(e, 'organization') ?? '',
    division: str(e, 'division') ?? '',
    department: str(e, 'department') ?? '',
    ...(typeof e['manager'] === 'object' && e['manager'] !== null
      ? { manager: { value: str(e['manager'] as Record<string, unknown>, 'value') ?? '' } }
      : {}),
  };
}

/** Coerce incoming group member refs. */
function coerceMembers(value: unknown): ScimMemberRef[] {
  if (!Array.isArray(value)) return [];
  const out: ScimMemberRef[] = [];
  for (const item of value) {
    if (typeof item === 'object' && item !== null) {
      const v = (item as { value?: unknown }).value;
      if (typeof v === 'string' && v.length > 0) {
        const display = (item as { display?: unknown }).display;
        out.push({ value: v, display: typeof display === 'string' ? display : v, type: 'User' });
      }
    }
  }
  return out;
}

/**
 * The SCIM resource store. All methods are synchronous and side-effect-free beyond
 * the in-memory maps; the engine layers provisioning and detection on top.
 */
export class ScimStore {
  private readonly users = new Map<string, StoredUser>();
  private readonly groups = new Map<string, StoredGroup>();

  /* --- Users --------------------------------------------------------------- */

  /**
   * Create or idempotently return a user. `body` is the parsed SCIM User; the
   * client-supplied `id` is honored (see module note). Regenerates server meta.
   *
   * @throws ScimError 400 (`invalidValue`) when `userName` is absent.
   */
  createUser(body: unknown, nowMs: number, nowSimMs: number): CreateResult<ScimUser> {
    if (typeof body !== 'object' || body === null) {
      throw new ScimError(400, 'User body must be an object', 'invalidSyntax');
    }
    const obj = body as Record<string, unknown>;
    const userName = str(obj, 'userName');
    if (!userName) {
      throw new ScimError(400, 'userName is required', 'invalidValue');
    }
    const id = str(obj, 'id') && str(obj, 'id')!.length > 0 ? (str(obj, 'id') as string) : `usr_${nanoid()}`;

    const existing = this.users.get(id);
    if (existing && !existing.deleted) {
      existing.lastActivityMs = nowMs;
      existing.lastActivitySimMs = nowSimMs;
      return { resource: existing.user, created: false };
    }

    const displayName = str(obj, 'displayName') ?? userName;
    const active = obj['active'] === undefined ? true : obj['active'] === true;
    const enterprise = coerceEnterprise(obj);
    const user: ScimUser = {
      schemas: enterprise ? [SCIM_SCHEMA.USER, SCIM_SCHEMA.ENTERPRISE_USER] : [SCIM_SCHEMA.USER],
      id,
      externalId: str(obj, 'externalId') ?? '',
      userName,
      name: coerceName(obj['name'], displayName),
      displayName,
      userType: str(obj, 'userType') ?? 'FTE',
      active,
      emails: coerceEmails(obj['emails']),
      groups: [],
      ...(enterprise ? { [SCIM_SCHEMA.ENTERPRISE_USER]: enterprise } : {}),
      meta: {
        resourceType: 'User',
        created: iso(nowMs),
        lastModified: iso(nowMs),
        location: `${SCIM_BASE_PATH}/Users/${id}`,
        version: etagFor(1),
      },
    };
    const title = str(obj, 'title');
    if (title) user.title = title;

    this.users.set(id, {
      user,
      version: 1,
      deleted: false,
      lastActivityMs: nowMs,
      lastActivitySimMs: nowSimMs,
    });
    return { resource: user, created: true };
  }

  /** Fetch a live user or throw 404. */
  getUser(id: string): ScimUser {
    const stored = this.users.get(id);
    if (!stored || stored.deleted) {
      throw new ScimError(404, `User ${id} not found`, undefined);
    }
    return stored.user;
  }

  /** Whether a live (non-deleted) user with this id exists. */
  hasLiveUser(id: string): boolean {
    const stored = this.users.get(id);
    return stored !== undefined && !stored.deleted;
  }

  /**
   * List live users matching a predicate, paginated with a 1-based `startIndex`.
   *
   * @returns The page of resources and the total match count before pagination.
   */
  listUsers(
    predicate: (user: ScimUser) => boolean,
    startIndex: number,
    count: number,
  ): { resources: ScimUser[]; total: number } {
    const matches: ScimUser[] = [];
    for (const stored of this.users.values()) {
      if (!stored.deleted && predicate(stored.user)) matches.push(stored.user);
    }
    const from = Math.max(0, startIndex - 1);
    return { resources: matches.slice(from, from + count), total: matches.length };
  }

  /** Replace a user's mutable attributes (PUT). Throws 404 if absent. */
  replaceUser(id: string, body: unknown, nowMs: number, nowSimMs: number): ScimUser {
    const stored = this.users.get(id);
    if (!stored || stored.deleted) throw new ScimError(404, `User ${id} not found`, undefined);
    if (typeof body !== 'object' || body === null) {
      throw new ScimError(400, 'User body must be an object', 'invalidSyntax');
    }
    const obj = body as Record<string, unknown>;
    const userName = str(obj, 'userName');
    if (!userName) throw new ScimError(400, 'userName is required', 'invalidValue');

    const displayName = str(obj, 'displayName') ?? userName;
    const enterprise = coerceEnterprise(obj);
    stored.user.userName = userName;
    stored.user.displayName = displayName;
    stored.user.name = coerceName(obj['name'], displayName);
    stored.user.userType = str(obj, 'userType') ?? stored.user.userType;
    stored.user.active = obj['active'] === undefined ? stored.user.active : obj['active'] === true;
    stored.user.emails = coerceEmails(obj['emails']);
    stored.user.externalId = str(obj, 'externalId') ?? stored.user.externalId;
    if (enterprise) stored.user[SCIM_SCHEMA.ENTERPRISE_USER] = enterprise;
    this.bumpUser(stored, nowMs, nowSimMs);
    return stored.user;
  }

  /** Apply a PATCH to a user. Throws 404 if absent. Returns whether active flipped. */
  patchUser(
    id: string,
    patchOp: unknown,
    nowMs: number,
    nowSimMs: number,
  ): { user: ScimUser; activeChanged: boolean; active: boolean } {
    const stored = this.users.get(id);
    if (!stored || stored.deleted) throw new ScimError(404, `User ${id} not found`, undefined);
    const result = applyUserPatch(stored.user, patchOp);
    this.bumpUser(stored, nowMs, nowSimMs);
    return { user: stored.user, activeChanged: result.activeChanged, active: result.active };
  }

  /** Soft-delete a user (deprovision). Idempotent; throws 404 only if never seen. */
  deleteUser(id: string, nowMs: number): void {
    const stored = this.users.get(id);
    if (!stored) throw new ScimError(404, `User ${id} not found`, undefined);
    if (stored.deleted) return;
    stored.deleted = true;
    stored.user.active = false;
    stored.lastActivityMs = nowMs;
    this.bumpUser(stored, nowMs, stored.lastActivitySimMs);
  }

  /** Record activity against a user without otherwise changing it. */
  touchUser(id: string, nowMs: number, nowSimMs: number): void {
    const stored = this.users.get(id);
    if (stored && !stored.deleted) {
      stored.lastActivityMs = nowMs;
      stored.lastActivitySimMs = nowSimMs;
    }
  }

  /** Current ETag for a user (for the response header), or undefined if absent. */
  userEtag(id: string): string | undefined {
    const stored = this.users.get(id);
    return stored ? etagFor(stored.version) : undefined;
  }

  /* --- Groups -------------------------------------------------------------- */

  /**
   * Create or idempotently return a group, keyed by `externalId` (falling back to
   * `id`, then a generated id). A repeat returns the existing group.
   */
  createGroup(body: unknown, nowMs: number): CreateResult<ScimGroup> {
    if (typeof body !== 'object' || body === null) {
      throw new ScimError(400, 'Group body must be an object', 'invalidSyntax');
    }
    const obj = body as Record<string, unknown>;
    const id = str(obj, 'externalId') ?? str(obj, 'id') ?? `grp_${nanoid()}`;
    const displayName = str(obj, 'displayName') ?? id;

    const existing = this.groups.get(id);
    if (existing) {
      // Backfill a better display name if the group was auto-created without one.
      if ((existing.group.displayName === existing.group.id || !existing.group.displayName) && displayName) {
        existing.group.displayName = displayName;
      }
      return { resource: existing.group, created: false };
    }

    const group: ScimGroup = {
      schemas: [SCIM_SCHEMA.GROUP],
      id,
      displayName,
      members: coerceMembers(obj['members']),
      meta: {
        resourceType: 'Group',
        created: iso(nowMs),
        lastModified: iso(nowMs),
        location: `${SCIM_BASE_PATH}/Groups/${id}`,
        version: etagFor(1),
      },
    };
    this.groups.set(id, { group, version: 1 });
    return { resource: group, created: true };
  }

  /** Fetch a group or throw 404. */
  getGroup(id: string): ScimGroup {
    const stored = this.groups.get(id);
    if (!stored) throw new ScimError(404, `Group ${id} not found`, undefined);
    return stored.group;
  }

  /** Fetch or auto-create a group by id, optionally seeding a display name. */
  getOrCreateGroup(id: string, nowMs: number, displayName?: string): ScimGroup {
    const existing = this.groups.get(id);
    if (existing) {
      if (displayName && (existing.group.displayName === existing.group.id || !existing.group.displayName)) {
        existing.group.displayName = displayName;
      }
      return existing.group;
    }
    return this.createGroup({ id, displayName: displayName ?? id }, nowMs).resource;
  }

  /** Apply a PATCH to a group, auto-creating it if the grant arrives first. */
  patchGroup(id: string, patchOp: unknown, nowMs: number): { group: ScimGroup } & GroupPatchResult {
    const group = this.getOrCreateGroup(id, nowMs);
    const result = applyGroupPatch(group, patchOp);
    const stored = this.groups.get(id);
    if (stored) {
      stored.version += 1;
      stored.group.meta.version = etagFor(stored.version);
      stored.group.meta.lastModified = iso(nowMs);
    }
    return { group, ...result };
  }

  /** Iterate live users (for detectors). */
  liveUsers(): IterableIterator<ScimUser> {
    const store = this.users;
    function* gen(): Generator<ScimUser> {
      for (const stored of store.values()) {
        if (!stored.deleted) yield stored.user;
      }
    }
    return gen();
  }

  /** Snapshot of a user's activity timestamps, or undefined if absent/deleted. */
  userActivity(id: string): { lastActivitySimMs: number } | undefined {
    const stored = this.users.get(id);
    if (!stored || stored.deleted) return undefined;
    return { lastActivitySimMs: stored.lastActivitySimMs };
  }

  /** Iterate all groups (for orphan detection over memberships). */
  allGroups(): IterableIterator<ScimGroup> {
    const store = this.groups;
    function* gen(): Generator<ScimGroup> {
      for (const stored of store.values()) yield stored.group;
    }
    return gen();
  }

  /** Counts of live users and groups, for diagnostics. */
  counts(): { users: number; groups: number } {
    let users = 0;
    for (const stored of this.users.values()) if (!stored.deleted) users += 1;
    return { users, groups: this.groups.size };
  }

  /** Clear all state. */
  reset(): void {
    this.users.clear();
    this.groups.clear();
  }

  /** Bump a user's version and modified metadata after a change. */
  private bumpUser(stored: StoredUser, nowMs: number, nowSimMs: number): void {
    stored.version += 1;
    stored.user.meta.version = etagFor(stored.version);
    stored.user.meta.lastModified = iso(nowMs);
    stored.lastActivityMs = nowMs;
    stored.lastActivitySimMs = nowSimMs;
  }
}
