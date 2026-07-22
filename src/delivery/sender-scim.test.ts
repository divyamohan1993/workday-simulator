import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type {
  EventDeliveryMeta,
  EventOfKind,
  IdentityRef,
  ProvisioningOperation,
  ProvisioningResource,
  WorkdayEvent,
} from '../types/index.js';
import { SCIM_SCHEMA } from '../domain/scim.js';
import { createAuthenticator } from './auth.js';
import { createScimSender } from './sender-scim.js';
import { normalizeScimBase, planScimRequest, type ScimPlan } from './sender-scim.js';
import type { HttpRequestSpec, HttpResponse, HttpTransport, SingleSender } from './types.js';

const BASE = 'http://receiver.local/scim/v2';
const noopLogger = { warn: vi.fn(), child: vi.fn(() => noopLogger) } as unknown as Logger;

function ref(overrides: Partial<IdentityRef> = {}): IdentityRef {
  return {
    id: 'emp_1',
    employeeId: 'DB00100000',
    displayName: 'Grace Hopper',
    email: 'grace.hopper@db.com',
    division: 'Technology, Data & Innovation',
    location: 'FFT',
    grade: 'VP',
    type: 'FTE',
    ...overrides,
  };
}

function meta(operation: ProvisioningOperation, resource: ProvisioningResource): EventDeliveryMeta {
  return { operation, resource, idempotencyKey: 'idem_1', priority: 'normal', requiresApproval: false };
}

/** A joiner event whose delivery metadata we vary to drive the planner. */
function userEvent(operation: ProvisioningOperation, subject: IdentityRef | undefined): WorkdayEvent {
  const event: EventOfKind<'joiner.hire'> = {
    id: 'evt_1',
    kind: 'joiner.hire',
    category: 'JML',
    timestamp: '2026-07-22T08:00:00.000Z',
    emittedAtWall: '2026-07-22T08:00:00.100Z',
    correlationId: 'corr_1',
    severity: 'info',
    actor: { kind: 'system', id: 'sys', component: 'hr-feed' },
    location: 'FFT',
    division: 'Technology, Data & Innovation',
    delivery: meta(operation, 'identity'),
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
  return subject ? { ...event, subject } : event;
}

function provisionEvent(operation: 'grant' | 'revoke', subject: IdentityRef): WorkdayEvent {
  const event: EventOfKind<'access.provision'> = {
    id: 'evt_2',
    kind: 'access.provision',
    category: 'ACCESS',
    timestamp: '2026-07-22T08:00:00.000Z',
    emittedAtWall: '2026-07-22T08:00:00.100Z',
    correlationId: 'corr_2',
    severity: 'notice',
    actor: { kind: 'system', id: 'sys', component: 'provisioning' },
    subject,
    location: subject.location,
    division: subject.division,
    delivery: meta(operation, 'entitlement'),
    seq: 2,
    payload: {
      entitlement: { id: 'ent-murex-42', system: 'Murex', name: 'Murex Trader', type: 'privileged', risk: 'high' },
      targetSystem: 'Murex',
      connector: 'murex-connector',
      provisioningMode: 'automated',
      latencyMs: 40,
    },
  };
  return event;
}

function wire(plan: ScimPlan): Extract<ScimPlan, { kind: 'wire' }> {
  if (plan.kind !== 'wire') throw new Error(`expected a wire plan, got noop: ${plan.reason}`);
  return plan;
}

describe('planScimRequest', () => {
  it('normalizes a trailing slash on the base', () => {
    expect(normalizeScimBase('http://x/scim/v2/')).toBe('http://x/scim/v2');
    expect(normalizeScimBase('http://x/scim/v2')).toBe('http://x/scim/v2');
  });

  it('maps create identity to POST /Users with an RFC 7643 user body', () => {
    const plan = wire(planScimRequest(userEvent('create', ref()), BASE));
    expect(plan.method).toBe('POST');
    expect(plan.path).toBe('/Users');
    const body = plan.body as Record<string, unknown>;
    expect(body.schemas).toContain(SCIM_SCHEMA.USER);
    expect(body.schemas).toContain(SCIM_SCHEMA.ENTERPRISE_USER);
    expect(body.externalId).toBe('DB00100000');
    expect(body.userName).toBe('grace.hopper');
    expect(body.active).toBe(true);
    expect(body.userType).toBe('FTE');
    const emails = body.emails as Array<{ value: string; primary: boolean }>;
    expect(emails[0]).toMatchObject({ value: 'grace.hopper@db.com', primary: true });
    const name = body.name as { givenName: string; familyName: string };
    expect(name).toMatchObject({ givenName: 'Grace', familyName: 'Hopper' });
  });

  it('maps deactivate to a PATCH replacing active=false', () => {
    const plan = wire(planScimRequest(userEvent('deactivate', ref()), BASE));
    expect(plan.method).toBe('PATCH');
    expect(plan.path).toBe('/Users/emp_1');
    const body = plan.body as { schemas: string[]; Operations: Array<Record<string, unknown>> };
    expect(body.schemas).toContain(SCIM_SCHEMA.PATCH_OP);
    expect(body.Operations[0]).toEqual({ op: 'replace', path: 'active', value: false });
  });

  it('maps reactivate to a PATCH replacing active=true', () => {
    const plan = wire(planScimRequest(userEvent('reactivate', ref()), BASE));
    const body = plan.body as { Operations: Array<Record<string, unknown>> };
    expect(body.Operations[0]).toEqual({ op: 'replace', path: 'active', value: true });
  });

  it('maps delete to DELETE /Users/{id}', () => {
    const plan = wire(planScimRequest(userEvent('delete', ref()), BASE));
    expect(plan.method).toBe('DELETE');
    expect(plan.path).toBe('/Users/emp_1');
    expect(plan.body).toBeUndefined();
  });

  it('maps grant to a Group members add for the entitlement', () => {
    const plan = wire(planScimRequest(provisionEvent('grant', ref()), BASE));
    expect(plan.method).toBe('PATCH');
    expect(plan.path).toBe('/Groups/ent-murex-42');
    const body = plan.body as { Operations: Array<{ op: string; path: string; value: Array<{ value: string }> }> };
    expect(body.Operations[0]?.op).toBe('add');
    expect(body.Operations[0]?.path).toBe('members');
    expect(body.Operations[0]?.value[0]?.value).toBe('emp_1');
  });

  it('maps revoke to a Group members remove by id', () => {
    const plan = wire(planScimRequest(provisionEvent('revoke', ref()), BASE));
    expect(plan.method).toBe('PATCH');
    expect(plan.path).toBe('/Groups/ent-murex-42');
    const body = plan.body as { Operations: Array<{ op: string; path: string }> };
    expect(body.Operations[0]?.op).toBe('remove');
    expect(body.Operations[0]?.path).toBe('members[value eq "emp_1"]');
  });

  it('returns a no-op for non-provisioning operations', () => {
    expect(planScimRequest(userEvent('noop', ref()), BASE).kind).toBe('noop');
    expect(planScimRequest(userEvent('notify', ref()), BASE).kind).toBe('noop');
  });

  it('returns a no-op when a user operation has no subject', () => {
    expect(planScimRequest(userEvent('create', undefined), BASE).kind).toBe('noop');
    expect(planScimRequest(userEvent('deactivate', undefined), BASE).kind).toBe('noop');
  });
});

/** A transport returning queued responses and recording each request. */
function fakeTransport(responses: HttpResponse[]): HttpTransport & { calls: HttpRequestSpec[] } {
  const calls: HttpRequestSpec[] = [];
  let index = 0;
  return {
    calls,
    async send(request: HttpRequestSpec): Promise<HttpResponse> {
      calls.push(structuredClone(request));
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (!response) throw new Error('no response');
      return response;
    },
    async close(): Promise<void> {},
  };
}

describe('createScimSender', () => {
  it('sends the idempotency key and threads an ETag into a later If-Match', async () => {
    const transport = fakeTransport([
      { status: 201, headers: { etag: 'W/"1"', location: '/scim/v2/Users/emp_1' }, body: JSON.stringify({ id: 'emp_1' }) },
      { status: 200, headers: { etag: 'W/"2"' }, body: '{}' },
    ]);
    const auth = createAuthenticator({ kind: 'none' }, { transport, logger: noopLogger });
    const sender = createScimSender({ target: { url: BASE, headers: {} }, transport, auth }) as SingleSender;

    const createResult = await sender.sendOne(userEvent('create', ref()));
    expect(createResult.httpStatus).toBe(201);
    expect(transport.calls[0]?.method).toBe('POST');
    expect(transport.calls[0]?.headers['idempotency-key']).toBe('idem_1');
    expect(transport.calls[0]?.headers['if-match']).toBeUndefined();

    await sender.sendOne(userEvent('update', ref()));
    expect(transport.calls[1]?.method).toBe('PUT');
    expect(transport.calls[1]?.url).toBe(`${BASE}/Users/emp_1`); // path is embedded in the URL for single sends
    // The ETag captured from the create response is replayed as If-Match.
    expect(transport.calls[1]?.headers['if-match']).toBe('W/"1"');
  });

  it('acknowledges a no-op event without touching the transport', async () => {
    const transport = fakeTransport([]);
    const auth = createAuthenticator({ kind: 'none' }, { transport, logger: noopLogger });
    const sender = createScimSender({ target: { url: BASE, headers: {} }, transport, auth }) as SingleSender;
    const result = await sender.sendOne(userEvent('noop', ref()));
    expect(result.noop).toBe(true);
    expect(transport.calls).toHaveLength(0);
  });
});
