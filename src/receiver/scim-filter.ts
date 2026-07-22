/**
 * A deliberately small SCIM 2.0 filter parser (RFC 7644 s.3.4.2.2).
 *
 * WHY only a subset: the simulator's SCIM traffic filters users by a single
 * attribute equality (`userName eq "..."`, `externalId eq "..."`, `id eq "..."`)
 * or presence (`attr pr`), and admin/dashboard listing needs the same plus
 * `active eq true`. Implementing the full filter grammar (logical and/or/not,
 * complex value paths) would be dead code today; a full parser is the wrong tool
 * for the one shape that is actually sent. Anything outside the supported subset
 * is rejected with the spec's `invalidFilter`, never silently mis-evaluated.
 */

import type { ScimUser } from '../domain/scim.js';
import { ScimError } from './scim-resources.js';

/** A predicate deciding whether a user matches a parsed filter. */
export type UserFilter = (user: ScimUser) => boolean;

/** Attribute names the filter subset understands, lowercased for lookup. */
const FILTERABLE = new Set(['username', 'externalid', 'id', 'active', 'displayname', 'usertype']);

/** Read the comparable string value of a supported attribute from a user. */
function attrValue(user: ScimUser, attrLower: string): string | boolean | undefined {
  switch (attrLower) {
    case 'username':
      return user.userName;
    case 'externalid':
      return user.externalId;
    case 'id':
      return user.id;
    case 'active':
      return user.active;
    case 'displayname':
      return user.displayName;
    case 'usertype':
      return user.userType;
    default:
      return undefined;
  }
}

/** Parse a filter literal into a string or boolean comparison operand. */
function parseOperand(raw: string): string | boolean {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    // Unescape the SCIM-permitted escapes inside a quoted string.
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  // Bareword (e.g. a number or unquoted token): compare as a string.
  return trimmed;
}

/**
 * Compile a SCIM filter string into a predicate. Returns a predicate that always
 * matches when `filter` is empty/undefined (an unfiltered list).
 *
 * @param filter The raw `filter` query parameter, if any.
 * @returns A predicate over SCIM users.
 * @throws ScimError 400 (`invalidFilter`) when the filter is outside the subset.
 */
export function compileUserFilter(filter: string | undefined): UserFilter {
  if (!filter || filter.trim().length === 0) return () => true;
  const expr = filter.trim();

  const presence = /^([\w$.-]+)\s+pr$/i.exec(expr);
  if (presence) {
    const attrLower = (presence[1] ?? '').toLowerCase();
    if (!FILTERABLE.has(attrLower)) {
      throw new ScimError(400, `Unsupported filter attribute: ${presence[1]}`, 'invalidFilter');
    }
    return (user) => {
      const value = attrValue(user, attrLower);
      return value !== undefined && value !== '';
    };
  }

  const equality = /^([\w$.-]+)\s+(eq)\s+(.+)$/i.exec(expr);
  if (equality) {
    const attrLower = (equality[1] ?? '').toLowerCase();
    if (!FILTERABLE.has(attrLower)) {
      throw new ScimError(400, `Unsupported filter attribute: ${equality[1]}`, 'invalidFilter');
    }
    const operand = parseOperand(equality[3] ?? '');
    return (user) => {
      const value = attrValue(user, attrLower);
      if (typeof value === 'boolean' || typeof operand === 'boolean') {
        return value === operand;
      }
      // Attribute equality on strings is case-insensitive unless caseExact; the
      // filterable attributes here (userName, ids) are treated case-insensitively.
      return typeof value === 'string' && value.toLowerCase() === String(operand).toLowerCase();
    };
  }

  throw new ScimError(400, `Unsupported filter expression: ${expr}`, 'invalidFilter');
}
