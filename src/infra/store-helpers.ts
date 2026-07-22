/**
 * Small shared helpers for the SQLite-backed stores: safe pagination clamping and
 * ISO-to-epoch conversion. Kept in one place so every store applies identical,
 * defensive bounds (the stores are called from HTTP handlers, so their inputs are
 * treated as hostile even after the API layer's own validation).
 */

import type { Paginated } from '../types/index.js';

/** Maximum page size the API contract allows (`limit` max 500). */
export const MAX_PAGE_LIMIT = 500;

/** Default page size when a caller passes a non-finite `limit`. */
export const DEFAULT_PAGE_LIMIT = 50;

/**
 * Clamp a requested page size into `[0, MAX_PAGE_LIMIT]`. A `limit` of 0 is a valid
 * "count only" page (returns an empty item list with the correct total). Non-finite
 * input falls back to the default rather than throwing.
 */
export function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 0), MAX_PAGE_LIMIT);
}

/** Clamp a requested offset to a non-negative integer. */
export function clampOffset(offset: number): number {
  if (!Number.isFinite(offset) || offset < 0) return 0;
  return Math.trunc(offset);
}

/**
 * Parse an ISO-8601 timestamp to epoch milliseconds, or `null` when absent or
 * unparseable. Used to mirror a domain object's own timestamps into integer columns
 * for ordering and range scans without trusting the string blindly.
 */
export function isoToMs(iso: string | undefined | null): number | null {
  if (iso === undefined || iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Assemble the standard paginated envelope with the effective (clamped) bounds. */
export function toPaginated<T>(
  items: T[],
  total: number,
  limit: number,
  offset: number,
): Paginated<T> {
  return { items, total, limit, offset };
}
