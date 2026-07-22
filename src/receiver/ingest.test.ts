import { describe, expect, it } from 'vitest';
import type { EventOfKind, IdentityRef, WorkdayEvent } from '../types/index.js';
import { buildEnvelope, serializeEnvelope } from '../delivery/envelope.js';
import { hrFeedBatch } from '../delivery/csv.js';
import {
  eventToProvisionPlan,
  parseCsv,
  parseHrCsv,
  parseRestBatch,
  parseWebhookEnvelope,
} from './ingest.js';

const subject: IdentityRef = {
  id: 'usr_1',
  employeeId: 'DB00100000',
  displayName: 'Grace Hopper',
  email: 'grace.hopper@db.com',
  division: 'Technology, Data & Innovation',
  location: 'FFT',
  grade: 'VP',
  type: 'FTE',
};

function hireEvent(): WorkdayEvent {
  const event: EventOfKind<'joiner.hire'> = {
    id: 'evt_hire',
    kind: 'joiner.hire',
    category: 'JML',
    timestamp: '2026-07-22T08:00:00.000Z',
    emittedAtWall: '2026-07-22T08:00:00.100Z',
    correlationId: 'corr_1',
    severity: 'info',
    actor: { kind: 'system', id: 'sys', component: 'hr-feed' },
    subject,
    location: 'FFT',
    division: 'Technology, Data & Innovation',
    delivery: { operation: 'create', resource: 'identity', idempotencyKey: 'idem-hire', priority: 'normal', requiresApproval: false },
    seq: 1,
    payload: {
      effectiveDate: '2026-07-22',
      employeeType: 'FTE',
      division: 'Technology, Data & Innovation',
      grade: 'VP',
      managerId: null,
      location: 'FFT',
      contractType: 'permanent',
      positionId: 'POS-1',
      birthrightEntitlements: [],
    },
  };
  return event;
}

function grantEvent(): WorkdayEvent {
  const event: EventOfKind<'access.provision'> = {
    id: 'evt_grant',
    kind: 'access.provision',
    category: 'ACCESS',
    timestamp: '2026-07-22T09:00:00.000Z',
    emittedAtWall: '2026-07-22T09:00:00.050Z',
    correlationId: 'corr_2',
    severity: 'notice',
    actor: { kind: 'system', id: 'sys', component: 'provisioning' },
    subject,
    location: 'FFT',
    division: 'Technology, Data & Innovation',
    delivery: { operation: 'grant', resource: 'entitlement', idempotencyKey: 'idem-grant', priority: 'high', requiresApproval: true },
    seq: 2,
    payload: {
      entitlement: { id: 'ent-sap-1', system: 'SAP', name: 'SAP Payment Release', type: 'role', risk: 'high' },
      targetSystem: 'SAP',
      connector: 'sap-connector',
      provisioningMode: 'automated',
      latencyMs: 800,
    },
  };
  return event;
}

describe('webhook and REST parsing', () => {
  it('round-trips a webhook envelope back to its event', () => {
    const serialized = serializeEnvelope(buildEnvelope(hireEvent()));
    const parsed: unknown = JSON.parse(serialized);
    const event = parseWebhookEnvelope(parsed);
    expect(event?.id).toBe('evt_hire');
    expect(event?.kind).toBe('joiner.hire');
  });

  it('tolerates a bare event posted without the envelope', () => {
    expect(parseWebhookEnvelope(hireEvent())?.id).toBe('evt_hire');
  });

  it('extracts the events array from a REST batch', () => {
    const body = { source: 'urn:workday-simulator', count: 2, events: [hireEvent(), grantEvent()] };
    const events = parseRestBatch(body);
    expect(events.map((e) => e.id)).toEqual(['evt_hire', 'evt_grant']);
  });

  it('returns nothing for malformed ingest bodies', () => {
    expect(parseWebhookEnvelope({ data: { not: 'an event' } })).toBeUndefined();
    expect(parseRestBatch({ events: 'nope' })).toEqual([]);
  });
});

describe('HR CSV parsing', () => {
  it('parses quoted fields with embedded commas and quotes', () => {
    const rows = parseCsv('a,b,c\r\n"x,y","z""q",plain\r\n');
    expect(rows[0]).toEqual(['a', 'b', 'c']);
    expect(rows[1]).toEqual(['x,y', 'z"q', 'plain']);
  });

  it('round-trips a real HR-feed batch into row plans', () => {
    const csv = hrFeedBatch([hireEvent()]);
    const plans = parseHrCsv(csv);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.userId).toBe('usr_1');
    expect(plans[0]?.operation).toBe('create');
    expect(plans[0]?.identity?.displayName).toBe('Grace Hopper');
  });
});

describe('eventToProvisionPlan', () => {
  it('maps a grant event to an entitlement provisioning plan', () => {
    const plan = eventToProvisionPlan(grantEvent());
    expect(plan.operation).toBe('grant');
    expect(plan.userId).toBe('usr_1');
    expect(plan.requiresApproval).toBe(true);
    expect(plan.entitlement).toMatchObject({ id: 'ent-sap-1', system: 'SAP', name: 'SAP Payment Release' });
  });

  it('maps an identity create to an identity plan carrying the ref', () => {
    const plan = eventToProvisionPlan(hireEvent());
    expect(plan.operation).toBe('create');
    expect(plan.resource).toBe('identity');
    expect(plan.identity?.id).toBe('usr_1');
  });
});
