/**
 * RFC 4180 CSV serialization for the batch HR feed.
 *
 * WHY strict escaping matters here: the simulated workforce deliberately carries
 * unicode, apostrophes, commas, embedded quotes and very long names to exercise
 * downstream normalization. A naive `fields.join(',')` would corrupt the feed
 * and silently shift columns. This module quotes any field containing a comma,
 * quote or line break, doubles embedded quotes, and separates records with CRLF,
 * exactly as RFC 4180 requires.
 */

import type { WorkdayEvent } from '../types/index.js';

/** RFC 4180 record separator. */
const CRLF = '\r\n';

/** Fields that must be quoted: contain comma, double-quote, CR or LF. */
const NEEDS_QUOTING = /[",\r\n]/;

/**
 * Escape one field per RFC 4180: wrap in double quotes and double any embedded
 * quote when the value contains a delimiter, quote or newline.
 *
 * @param field The raw field value.
 * @returns The CSV-safe field.
 */
export function csvEscapeField(field: string): string {
  if (!NEEDS_QUOTING.test(field)) return field;
  return `"${field.replace(/"/g, '""')}"`;
}

/**
 * Join a record's cells into one RFC 4180 line. Nullish cells become empty
 * strings; everything else is stringified then escaped.
 *
 * @param cells The ordered cell values.
 * @returns The escaped, comma-joined record (no trailing newline).
 */
export function csvRecord(cells: ReadonlyArray<string | number | boolean | null | undefined>): string {
  return cells.map((cell) => csvEscapeField(cell === null || cell === undefined ? '' : String(cell))).join(',');
}

/** Column order of the HR feed. Stable so the receiver can parse positionally. */
export const HR_FEED_COLUMNS = [
  'eventId',
  'seq',
  'timestamp',
  'emittedAtWall',
  'kind',
  'category',
  'operation',
  'resource',
  'idempotencyKey',
  'severity',
  'identityId',
  'employeeId',
  'displayName',
  'email',
  'division',
  'location',
  'grade',
  'employeeType',
  'actorKind',
  'correlationId',
  'causationId',
] as const;

/** The affected identity is the subject when set, else the acting identity. */
function affectedFields(event: WorkdayEvent): {
  identityId: string;
  employeeId: string;
  displayName: string;
  email: string;
  division: string;
  location: string;
  grade: string;
  employeeType: string;
} {
  const identity = event.subject ?? (event.actor.kind === 'system' ? undefined : event.actor);
  return {
    identityId: identity?.id ?? '',
    employeeId: identity?.employeeId ?? '',
    displayName: identity?.displayName ?? '',
    email: identity?.email ?? '',
    division: identity?.division ?? event.division,
    location: identity?.location ?? event.location,
    grade: identity?.grade ?? '',
    employeeType: identity?.type ?? '',
  };
}

/** The CSV header line for the HR feed. */
export function hrFeedHeader(): string {
  return csvRecord(HR_FEED_COLUMNS as ReadonlyArray<string>);
}

/**
 * Map one event to an HR-feed CSV record, in {@link HR_FEED_COLUMNS} order.
 *
 * @param event The event to serialize.
 * @returns One escaped CSV record.
 */
export function hrFeedRow(event: WorkdayEvent): string {
  const who = affectedFields(event);
  return csvRecord([
    event.id,
    event.seq,
    event.timestamp,
    event.emittedAtWall,
    event.kind,
    event.category,
    event.delivery.operation,
    event.delivery.resource,
    event.delivery.idempotencyKey,
    event.severity,
    who.identityId,
    who.employeeId,
    who.displayName,
    who.email,
    who.division,
    who.location,
    who.grade,
    who.employeeType,
    event.actor.kind,
    event.correlationId,
    event.causationId,
  ]);
}

/**
 * Build a complete HR-feed CSV document (header + one row per event), CRLF
 * separated with a trailing CRLF per RFC 4180.
 *
 * @param events The batch of events to encode.
 * @returns The CSV payload.
 */
export function hrFeedBatch(events: readonly WorkdayEvent[]): string {
  const lines = [hrFeedHeader(), ...events.map(hrFeedRow)];
  return `${lines.join(CRLF)}${CRLF}`;
}
