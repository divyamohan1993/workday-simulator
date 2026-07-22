/**
 * Parsers for the non-SCIM ingest wire formats and the mapping from a WorkdayEvent
 * to a provisioning plan.
 *
 * The receiver accepts the same three shapes the delivery adapter emits:
 * - webhook: a CloudEvents-style envelope wrapping one event under `data`;
 * - REST: `{ source, count, events: [...] }`;
 * - HR batch: an RFC 4180 CSV whose header names the columns.
 *
 * WHY map from `event.delivery` rather than sniffing each kind: the frozen protocol
 * puts the provisioning intent (operation + resource) on every event's delivery
 * metadata precisely so consumers agree on it. The one narrow peek into a payload
 * is to recover the entitlement reference for grant/revoke, the only place that id,
 * name and system live, exactly as the delivery SCIM planner does.
 */

import type {
  EntitlementType,
  IdentityRef,
  ProvisioningOperation,
  ProvisioningResource,
  WorkdayEvent,
} from '../types/index.js';
import { HR_FEED_COLUMNS } from '../delivery/csv.js';

/** A provisioning plan derived from one ingested event or HR row. */
export interface EventProvisionPlan {
  operation: ProvisioningOperation;
  resource: ProvisioningResource;
  idempotencyKey: string;
  requiresApproval: boolean;
  /** Simulated-time ms of the event, for dormancy accounting (0 when unknown). */
  simTimeMs: number;
  /** The affected identity id, when the operation targets a user. */
  userId?: string;
  /** The affected identity reference, used to materialize a user if unknown. */
  identity?: IdentityRef;
  /** The entitlement for grant/revoke, carrying name+system for SoD classification. */
  entitlement?: { id: string; system: string; name: string; type: EntitlementType };
}

const OPERATIONS = new Set<ProvisioningOperation>([
  'create', 'update', 'patch', 'deactivate', 'reactivate', 'delete', 'grant', 'revoke', 'notify', 'noop',
]);
const RESOURCES = new Set<ProvisioningResource>([
  'identity', 'entitlement', 'group', 'account', 'session', 'event',
]);

/** Narrow a loose string to a known provisioning operation, defaulting to noop. */
function toOperation(value: unknown): ProvisioningOperation {
  return typeof value === 'string' && OPERATIONS.has(value as ProvisioningOperation)
    ? (value as ProvisioningOperation)
    : 'noop';
}

/** Narrow a loose string to a known provisioning resource, defaulting to event. */
function toResource(value: unknown): ProvisioningResource {
  return typeof value === 'string' && RESOURCES.has(value as ProvisioningResource)
    ? (value as ProvisioningResource)
    : 'event';
}

/** The affected identity ref of an event: subject when set, else a non-system actor. */
export function affectedIdentity(event: WorkdayEvent): IdentityRef | undefined {
  if (event.subject) return event.subject;
  if (event.actor.kind === 'employee' || event.actor.kind === 'service') {
    const { id, employeeId, displayName, email, division, location, grade, type } = event.actor;
    return { id, employeeId, displayName, email, division, location, grade, type };
  }
  return undefined;
}

/** Recover the entitlement reference for grant/revoke-style events. */
function entitlementOf(
  event: WorkdayEvent,
): { id: string; system: string; name: string; type: EntitlementType } | undefined {
  switch (event.kind) {
    case 'access.request':
    case 'access.provision':
    case 'access.revoke': {
      const e = event.payload.entitlement;
      return { id: e.id, system: e.system, name: e.name, type: e.type };
    }
    case 'recertification': {
      const e = event.payload.entitlement;
      return e ? { id: e.id, system: e.system, name: e.name, type: e.type } : undefined;
    }
    case 'firefighter.grant':
    case 'firefighter.revoke':
      return {
        id: `FF-${event.payload.system}-${event.payload.role}`,
        system: event.payload.system,
        name: `${event.payload.role} (${event.payload.system})`,
        type: 'firefighter',
      };
    default:
      return undefined;
  }
}

/** Parse an ISO timestamp to epoch ms, or 0 when absent/invalid. */
function simMsOf(event: WorkdayEvent): number {
  const ms = Date.parse(event.timestamp);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Build the provisioning plan for one event from its delivery metadata.
 *
 * @param event The ingested event.
 * @returns A plan the engine applies (create/patch a user, grant/revoke, or a
 *   non-provisioning notify/noop that still counts as ingested).
 */
export function eventToProvisionPlan(event: WorkdayEvent): EventProvisionPlan {
  const identity = affectedIdentity(event);
  const entitlement = entitlementOf(event);
  const plan: EventProvisionPlan = {
    operation: event.delivery.operation,
    resource: event.delivery.resource,
    idempotencyKey: event.delivery.idempotencyKey,
    requiresApproval: event.delivery.requiresApproval,
    simTimeMs: simMsOf(event),
  };
  if (identity) {
    plan.userId = identity.id;
    plan.identity = identity;
  }
  if (entitlement) plan.entitlement = entitlement;
  return plan;
}

/** Extract the single event from a parsed webhook envelope, if present. */
export function parseWebhookEnvelope(body: unknown): WorkdayEvent | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const data = (body as { data?: unknown }).data;
  if (isWorkdayEvent(data)) return data;
  // Tolerate a bare event posted without the envelope.
  if (isWorkdayEvent(body)) return body as WorkdayEvent;
  return undefined;
}

/** Extract the events array from a parsed REST batch body. */
export function parseRestBatch(body: unknown): WorkdayEvent[] {
  if (typeof body !== 'object' || body === null) return [];
  const events = (body as { events?: unknown }).events;
  if (!Array.isArray(events)) return [];
  return events.filter(isWorkdayEvent);
}

/** Structural check that a value carries the fields the plan mapping needs. */
function isWorkdayEvent(value: unknown): value is WorkdayEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    typeof v['kind'] === 'string' &&
    typeof v['delivery'] === 'object' &&
    v['delivery'] !== null &&
    typeof v['actor'] === 'object' &&
    v['actor'] !== null
  );
}

/* --- HR batch CSV ---------------------------------------------------------- */

/** One parsed HR-feed row as a provisioning plan over an identity. */
export interface HrRowPlan {
  operation: ProvisioningOperation;
  resource: ProvisioningResource;
  idempotencyKey: string;
  simTimeMs: number;
  userId: string;
  identity: IdentityRef | undefined;
}

/**
 * Parse an RFC 4180 record stream into rows of fields. Handles quoted fields,
 * doubled quotes, and CRLF or LF record separators.
 *
 * @param text The CSV document.
 * @returns Rows of string fields (including the header row).
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      // Swallow CRLF as a single separator; a lone CR also ends the row.
      if (text[i + 1] === '\n') i += 1;
      endRow();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // Flush a trailing partial row (no final newline, or leftover field content).
  if (field.length > 0 || row.length > 0) endRow();
  return rows;
}

/** Division/location/grade/type values are validated downstream; kept as strings here. */
function cell(record: Record<string, string>, name: string): string {
  return record[name] ?? '';
}

/**
 * Parse an HR-feed CSV document into per-row provisioning plans. Rows whose
 * operation is not a recognized provisioning operation are skipped.
 *
 * @param text The CSV document (header + rows).
 * @returns One plan per provisioning-relevant row.
 */
export function parseHrCsv(text: string): HrRowPlan[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0] ?? [];
  const index = new Map<string, number>();
  header.forEach((name, i) => index.set(name, i));
  // Only proceed if the header looks like the HR feed we expect.
  if (!index.has('identityId') || !index.has('operation')) return [];

  const plans: HrRowPlan[] = [];
  for (let r = 1; r < rows.length; r += 1) {
    const cols = rows[r];
    if (!cols || cols.length === 0 || (cols.length === 1 && cols[0] === '')) continue;
    const record: Record<string, string> = {};
    for (const name of HR_FEED_COLUMNS) {
      const i = index.get(name);
      record[name] = i !== undefined ? cols[i] ?? '' : '';
    }

    const operation = toOperation(cell(record, 'operation'));
    if (operation === 'noop' || operation === 'notify') continue;
    const userId = cell(record, 'identityId');
    if (!userId) continue;

    const identity: IdentityRef = {
      id: userId,
      employeeId: cell(record, 'employeeId'),
      displayName: cell(record, 'displayName') || userId,
      email: cell(record, 'email'),
      division: cell(record, 'division') as IdentityRef['division'],
      location: cell(record, 'location') as IdentityRef['location'],
      grade: cell(record, 'grade') as IdentityRef['grade'],
      type: cell(record, 'employeeType') as IdentityRef['type'],
    };
    const simTimeMs = Date.parse(cell(record, 'timestamp'));
    plans.push({
      operation,
      resource: toResource(cell(record, 'resource')),
      idempotencyKey: cell(record, 'idempotencyKey'),
      simTimeMs: Number.isFinite(simTimeMs) ? simTimeMs : 0,
      userId,
      identity,
    });
  }
  return plans;
}
