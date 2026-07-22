/**
 * Applies SCIM 2.0 PATCH operations (RFC 7644 s.3.5.2) to stored User and Group
 * resources.
 *
 * WHY a focused applier rather than a general JSON-path engine: the delivery
 * adapter emits a small, known set of PATCH shapes (toggle `active`, replace core
 * user attributes, add/remove a group member). Those exact paths are handled
 * precisely and correctly; the applier is still tolerant of a no-path value object
 * (the other legal PATCH form) so a hand-driven or dashboard PATCH also works.
 * Malformed operations are rejected with `invalidSyntax` rather than silently
 * corrupting a resource.
 */

import type { ScimEmail, ScimGroup, ScimMemberRef, ScimUser } from '../domain/scim.js';
import { ScimError } from './scim-resources.js';

/** A single SCIM PATCH operation, as received on the wire (loosely typed). */
interface RawPatchOperation {
  op?: unknown;
  path?: unknown;
  value?: unknown;
}

/** The result of applying a user PATCH: whether the enabled state flipped. */
export interface UserPatchResult {
  activeChanged: boolean;
  active: boolean;
}

/** The result of applying a group PATCH: which members were added/removed. */
export interface GroupPatchResult {
  addedUserIds: string[];
  removedUserIds: string[];
}

/** Validate the envelope and return the operations array, or throw invalidSyntax. */
function operationsOf(patchOp: unknown): RawPatchOperation[] {
  if (typeof patchOp !== 'object' || patchOp === null) {
    throw new ScimError(400, 'PATCH body must be an object', 'invalidSyntax');
  }
  const ops = (patchOp as { Operations?: unknown }).Operations;
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new ScimError(400, 'PATCH requires a non-empty Operations array', 'invalidSyntax');
  }
  return ops as RawPatchOperation[];
}

/** Normalize an op verb to lowercase, rejecting anything but add/replace/remove. */
function normalizeOp(op: unknown): 'add' | 'replace' | 'remove' {
  const verb = typeof op === 'string' ? op.toLowerCase() : '';
  if (verb === 'add' || verb === 'replace' || verb === 'remove') return verb;
  throw new ScimError(400, `Unsupported PATCH op: ${String(op)}`, 'invalidSyntax');
}

/** Coerce a SCIM boolean-ish value ("true"/"false"/true/false) to a boolean. */
function toBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return Boolean(value);
}

/** Set (or create) the primary work email's value on a user. */
function setWorkEmail(user: ScimUser, value: string): void {
  const existing = user.emails.find((e) => e.type === 'work') ?? user.emails[0];
  if (existing) {
    existing.value = value;
    return;
  }
  const email: ScimEmail = { value, type: 'work', primary: true };
  user.emails.push(email);
}

/** Apply a single value-object (no-path form) onto a user's known attributes. */
function applyUserValueObject(user: ScimUser, value: Record<string, unknown>): boolean {
  let activeChanged = false;
  for (const [key, raw] of Object.entries(value)) {
    switch (key.toLowerCase()) {
      case 'active': {
        const next = toBool(raw);
        activeChanged = activeChanged || next !== user.active;
        user.active = next;
        break;
      }
      case 'displayname':
        if (typeof raw === 'string') user.displayName = raw;
        break;
      case 'username':
        if (typeof raw === 'string') user.userName = raw;
        break;
      case 'usertype':
        if (typeof raw === 'string') user.userType = raw;
        break;
      case 'name':
        if (typeof raw === 'object' && raw !== null) {
          const n = raw as { formatted?: unknown; givenName?: unknown; familyName?: unknown };
          if (typeof n.formatted === 'string') user.name.formatted = n.formatted;
          if (typeof n.givenName === 'string') user.name.givenName = n.givenName;
          if (typeof n.familyName === 'string') user.name.familyName = n.familyName;
        }
        break;
      default:
        // Unknown attributes are ignored: a reference receiver tolerates extra
        // fields rather than 400-ing a whole otherwise-valid PATCH.
        break;
    }
  }
  return activeChanged;
}

/**
 * Apply a PATCH to a user resource in place.
 *
 * @param user The stored SCIM user (mutated in place).
 * @param patchOp The PATCH request body.
 * @returns Whether the `active` flag changed, and its resulting value.
 * @throws ScimError 400 on a malformed operation.
 */
export function applyUserPatch(user: ScimUser, patchOp: unknown): UserPatchResult {
  const ops = operationsOf(patchOp);
  let activeChanged = false;

  for (const raw of ops) {
    const op = normalizeOp(raw.op);
    const path = typeof raw.path === 'string' ? raw.path.trim() : '';

    if (path === '') {
      // No-path add/replace carries a value object of attributes.
      if (op === 'remove') {
        throw new ScimError(400, 'PATCH remove requires a path', 'noTarget');
      }
      if (typeof raw.value !== 'object' || raw.value === null) {
        throw new ScimError(400, 'PATCH without a path requires a value object', 'invalidValue');
      }
      activeChanged = applyUserValueObject(user, raw.value as Record<string, unknown>) || activeChanged;
      continue;
    }

    const pathLower = path.toLowerCase();
    switch (pathLower) {
      case 'active': {
        const next = op === 'remove' ? false : toBool(raw.value);
        activeChanged = activeChanged || next !== user.active;
        user.active = next;
        break;
      }
      case 'displayname':
        user.displayName = op === 'remove' ? '' : String(raw.value ?? '');
        break;
      case 'username':
        if (op !== 'remove' && typeof raw.value === 'string') user.userName = raw.value;
        break;
      case 'usertype':
        if (op !== 'remove' && typeof raw.value === 'string') user.userType = raw.value;
        break;
      case 'name.formatted':
        user.name.formatted = op === 'remove' ? '' : String(raw.value ?? '');
        break;
      default:
        if (pathLower.startsWith('emails[') && pathLower.endsWith('.value')) {
          if (op !== 'remove') setWorkEmail(user, String(raw.value ?? ''));
        }
        // Any other path is tolerated as a no-op: the receiver never rejects an
        // otherwise-valid PATCH over an attribute it does not model.
        break;
    }
  }

  return { activeChanged, active: user.active };
}

/** Parse a member id out of a `members[value eq "X"]` path, if that is the shape. */
function memberIdFromPath(path: string): string | undefined {
  const match = /members\[\s*value\s+eq\s+"([^"]*)"\s*\]/i.exec(path);
  return match ? match[1] : undefined;
}

/** Coerce a PATCH member value (array or single ref) into member references. */
function toMemberRefs(value: unknown): ScimMemberRef[] {
  const items = Array.isArray(value) ? value : value !== undefined ? [value] : [];
  const refs: ScimMemberRef[] = [];
  for (const item of items) {
    if (typeof item === 'object' && item !== null) {
      const v = (item as { value?: unknown }).value;
      if (typeof v === 'string' && v.length > 0) {
        const display = (item as { display?: unknown }).display;
        refs.push({ value: v, display: typeof display === 'string' ? display : v, type: 'User' });
      }
    } else if (typeof item === 'string' && item.length > 0) {
      refs.push({ value: item, display: item, type: 'User' });
    }
  }
  return refs;
}

/**
 * Apply a PATCH to a group resource in place, handling membership add/remove.
 *
 * @param group The stored SCIM group (mutated in place).
 * @param patchOp The PATCH request body.
 * @returns The user ids added and removed by this PATCH.
 * @throws ScimError 400 on a malformed operation.
 */
export function applyGroupPatch(group: ScimGroup, patchOp: unknown): GroupPatchResult {
  const ops = operationsOf(patchOp);
  const addedUserIds: string[] = [];
  const removedUserIds: string[] = [];

  for (const raw of ops) {
    const op = normalizeOp(raw.op);
    const path = typeof raw.path === 'string' ? raw.path.trim() : '';
    const pathLower = path.toLowerCase();

    // Targeted member removal: members[value eq "X"].
    const targetedId = memberIdFromPath(path);
    if (op === 'remove' && targetedId !== undefined) {
      const before = group.members.length;
      group.members = group.members.filter((m) => m.value !== targetedId);
      if (group.members.length !== before) removedUserIds.push(targetedId);
      continue;
    }

    if (pathLower === 'members' || pathLower === '') {
      if (op === 'remove') {
        for (const m of group.members) removedUserIds.push(m.value);
        group.members = [];
        continue;
      }
      const refs = toMemberRefs(raw.value);
      if (op === 'replace') {
        for (const m of group.members) removedUserIds.push(m.value);
        group.members = [];
      }
      for (const ref of refs) {
        if (!group.members.some((m) => m.value === ref.value)) {
          group.members.push(ref);
          addedUserIds.push(ref.value);
        }
      }
      continue;
    }

    // Any other path is tolerated as a no-op.
  }

  return { addedUserIds, removedUserIds };
}
