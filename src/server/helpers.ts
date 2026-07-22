/**
 * Small, pure request/response helpers shared by the route modules: pagination
 * parsing bounded to the API contract, and delivery-target secret redaction applied
 * at the response boundary.
 *
 * WHY redaction lives at the boundary (not in storage): the delivery adapter must
 * read a target's auth secret back in plaintext to authenticate to the sink, so the
 * store keeps it as-is (see target-store.ts). Every path that echoes a target to a
 * caller MUST pass it through `redactTarget` first, so a secret is masked exactly
 * once, at the edge, and can never leak through a list, get, create or update body.
 */

import type { DeliveryTarget, Paginated } from '../types/index.js';

/** Default page size (BUILD-CONTRACT section 7: limit default 50). */
export const DEFAULT_LIMIT = 50;

/** Hard ceiling on a page (BUILD-CONTRACT section 7: limit max 500). */
export const MAX_LIMIT = 500;

/** The value substituted for any redacted secret; matches the log censor string. */
export const REDACTED = '***REDACTED***';

/** A generic query record as Fastify parses it (all values are strings or arrays). */
type Query = Record<string, unknown>;

/** Coerce a query value that may be a string or a repeated-string array to a number. */
function firstNumber(value: unknown): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse and clamp `limit`/`offset` from a query object to the contract's bounds.
 * Non-numeric or out-of-range values fall back to safe defaults rather than error,
 * because pagination inputs are hostile but not worth rejecting a whole request over.
 */
export function parsePagination(query: Query): { limit: number; offset: number } {
  const rawLimit = firstNumber(query['limit']);
  const rawOffset = firstNumber(query['offset']);
  const limit =
    rawLimit === undefined ? DEFAULT_LIMIT : Math.min(Math.max(Math.trunc(rawLimit), 0), MAX_LIMIT);
  const offset = rawOffset === undefined || rawOffset < 0 ? 0 : Math.trunc(rawOffset);
  return { limit, offset };
}

/** Read a single string query param, tolerating a repeated-string array. */
export function firstString(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * Return a copy of a delivery target with every auth secret masked. The four secret
 * fields across the `DeliveryAuthConfig` union (`token`, `password`, `clientSecret`,
 * `secret`) are replaced; non-secret fields (kind, urls, usernames, header names)
 * are preserved so the caller can still see and edit the target's shape.
 */
export function redactTarget(target: DeliveryTarget): DeliveryTarget {
  const auth = target.auth;
  let redactedAuth: DeliveryTarget['auth'];
  switch (auth.kind) {
    case 'bearer':
      redactedAuth = { ...auth, token: REDACTED };
      break;
    case 'basic':
      redactedAuth = { ...auth, password: REDACTED };
      break;
    case 'oauth2_client_credentials':
      redactedAuth = { ...auth, clientSecret: REDACTED };
      break;
    case 'hmac':
      redactedAuth = { ...auth, secret: REDACTED };
      break;
    case 'none':
    default:
      redactedAuth = auth;
      break;
  }
  return { ...target, auth: redactedAuth };
}

/** Redact every target in a paginated page (list endpoints). */
export function redactTargetPage(page: Paginated<DeliveryTarget>): Paginated<DeliveryTarget> {
  return { ...page, items: page.items.map(redactTarget) };
}

/** Slice an in-memory array into the standard paginated envelope. */
export function paginateArray<T>(items: readonly T[], limit: number, offset: number): Paginated<T> {
  const total = items.length;
  const slice = items.slice(offset, offset + limit);
  return { items: slice, total, limit, offset };
}
