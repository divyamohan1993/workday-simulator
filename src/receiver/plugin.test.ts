import { createHmac } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from 'pino';
import type { EventOfKind, WorkdayEvent } from '../types/index.js';
import { SCIM_SCHEMA } from '../domain/scim.js';
import { buildEnvelope, serializeEnvelope } from '../delivery/envelope.js';
import { createReceiverEngine, type ReceiverEngine, type ReceiverEngineOptions } from './engine.js';
import { createReceiverPlugin } from './plugin.js';

const TOKEN = 'receiver-token-abcdef123456'; // pragma: allowlist secret (deterministic test fixture, not a real credential)
const logger = {
  info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {},
  child() { return logger; },
  level: 'info',
} as unknown as Logger;

const SCIM_HEADERS = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/scim+json' };

let apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps = [];
});

async function build(options: Partial<ReceiverEngineOptions> = {}): Promise<{ app: FastifyInstance; engine: ReceiverEngine }> {
  const engine = createReceiverEngine({ logger, seed: 't', now: () => 1_000, ...options });
  const app = Fastify();
  await app.register(createReceiverPlugin({ engine, token: TOKEN, logger }));
  await app.ready();
  apps.push(app);
  return { app, engine };
}

function userBody(id: string, userName: string): string {
  return JSON.stringify({
    schemas: [SCIM_SCHEMA.USER],
    id,
    externalId: 'DB00100000',
    userName,
    displayName: 'Grace Hopper',
    name: { formatted: 'Grace Hopper', givenName: 'Grace', familyName: 'Hopper' },
    userType: 'FTE',
    active: true,
    emails: [{ value: `${userName}@db.com`, type: 'work', primary: true }],
  });
}

const patchActiveFalse = JSON.stringify({
  schemas: [SCIM_SCHEMA.PATCH_OP],
  Operations: [{ op: 'replace', path: 'active', value: false }],
});

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
    subject: {
      id: 'usr_hook', employeeId: 'DB1', displayName: 'Hooked User', email: 'hook@db.com',
      division: 'Operations', location: 'FFT', grade: 'Analyst', type: 'FTE',
    },
    location: 'FFT',
    division: 'Operations',
    delivery: { operation: 'create', resource: 'identity', idempotencyKey: 'idem-hook', priority: 'normal', requiresApproval: false },
    seq: 1,
    payload: {
      effectiveDate: '2026-07-22', employeeType: 'FTE', division: 'Operations', grade: 'Analyst',
      managerId: null, location: 'FFT', contractType: 'permanent', positionId: 'POS-1', birthrightEntitlements: [],
    },
  };
  return event;
}

describe('receiver plugin - auth', () => {
  it('rejects an unauthenticated request with 401 and a SCIM error body', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'POST', url: '/scim/v2/Users', headers: { 'content-type': 'application/scim+json' }, payload: userBody('usr_1', 'a.b') });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.json().schemas).toContain(SCIM_SCHEMA.ERROR);
  });

  it('rejects a wrong token', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'GET', url: '/scim/v2/Users/usr_1', headers: { authorization: 'Bearer wrong' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('receiver plugin - SCIM CRUD', () => {
  it('round-trips a create then get and increments totalIngested', async () => {
    const { app, engine } = await build();
    const create = await app.inject({
      method: 'POST', url: '/scim/v2/Users',
      headers: { ...SCIM_HEADERS, 'idempotency-key': 'k1' }, payload: userBody('usr_1', 'grace.hopper'),
    });
    expect(create.statusCode).toBe(201);
    expect(create.headers.location).toBe('/scim/v2/Users/usr_1');
    expect(create.headers.etag).toBeDefined();
    expect(create.json().id).toBe('usr_1');
    expect(engine.stats().totalIngested).toBe(1);

    const get = await app.inject({ method: 'GET', url: '/scim/v2/Users/usr_1', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(get.statusCode).toBe(200);
    expect(get.json().userName).toBe('grace.hopper');
  });

  it('deactivates via PATCH and flips active', async () => {
    const { app } = await build();
    await app.inject({ method: 'POST', url: '/scim/v2/Users', headers: { ...SCIM_HEADERS, 'idempotency-key': 'k1' }, payload: userBody('usr_1', 'a.b') });
    const patch = await app.inject({
      method: 'PATCH', url: '/scim/v2/Users/usr_1',
      headers: { ...SCIM_HEADERS, 'idempotency-key': 'k2' }, payload: patchActiveFalse,
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().active).toBe(false);
  });

  it('deprovisions via DELETE with 204', async () => {
    const { app } = await build();
    await app.inject({ method: 'POST', url: '/scim/v2/Users', headers: { ...SCIM_HEADERS, 'idempotency-key': 'k1' }, payload: userBody('usr_1', 'a.b') });
    const del = await app.inject({ method: 'DELETE', url: '/scim/v2/Users/usr_1', headers: { authorization: `Bearer ${TOKEN}`, 'idempotency-key': 'k2' } });
    expect(del.statusCode).toBe(204);
    const get = await app.inject({ method: 'GET', url: '/scim/v2/Users/usr_1', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(get.statusCode).toBe(404);
  });

  it('lists users with a userName filter', async () => {
    const { app } = await build();
    await app.inject({ method: 'POST', url: '/scim/v2/Users', headers: { ...SCIM_HEADERS, 'idempotency-key': 'k1' }, payload: userBody('usr_1', 'grace.hopper') });
    const list = await app.inject({ method: 'GET', url: '/scim/v2/Users?filter=userName eq "grace.hopper"', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.schemas).toContain(SCIM_SCHEMA.LIST_RESPONSE);
    expect(body.totalResults).toBe(1);
  });

  it('applies every operation in a Bulk request', async () => {
    const { app } = await build();
    const bulk = await app.inject({
      method: 'POST', url: '/scim/v2/Bulk', headers: SCIM_HEADERS,
      payload: JSON.stringify({
        schemas: [SCIM_SCHEMA.BULK_REQUEST],
        Operations: [
          { method: 'POST', path: '/Users', bulkId: 'b1', data: JSON.parse(userBody('usr_2', 'bulk.user')) },
          { method: 'PATCH', path: '/Users/usr_2', bulkId: 'b2', data: JSON.parse(patchActiveFalse) },
        ],
      }),
    });
    expect(bulk.statusCode).toBe(200);
    const body = bulk.json();
    expect(body.schemas).toContain(SCIM_SCHEMA.BULK_RESPONSE);
    expect(body.Operations[0].status).toBe('201');
    expect(body.Operations[1].status).toBe('200');
  });
});

describe('receiver plugin - SCIM discovery', () => {
  it('serves ServiceProviderConfig, ResourceTypes and Schemas', async () => {
    const { app } = await build();
    const auth = { authorization: `Bearer ${TOKEN}` };
    const spc = await app.inject({ method: 'GET', url: '/scim/v2/ServiceProviderConfig', headers: auth });
    expect(spc.statusCode).toBe(200);
    expect(spc.json().patch.supported).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/scim/v2/ResourceTypes', headers: auth })).json().totalResults).toBe(2);
    expect((await app.inject({ method: 'GET', url: '/scim/v2/Schemas', headers: auth })).statusCode).toBe(200);
  });
});

describe('receiver plugin - backpressure', () => {
  it('returns 429 with Retry-After once saturated', async () => {
    const { app } = await build({ backpressureHighWater: 2, rateLimit: { ratePerSec: 0 } });
    const first = await app.inject({ method: 'POST', url: '/scim/v2/Users', headers: { ...SCIM_HEADERS, 'idempotency-key': 'k1' }, payload: userBody('usr_1', 'a') });
    expect(first.statusCode).toBe(201); // enqueues AD + Exchange, depth now 2
    const second = await app.inject({ method: 'POST', url: '/scim/v2/Users', headers: { ...SCIM_HEADERS, 'idempotency-key': 'k2' }, payload: userBody('usr_2', 'b') });
    expect(second.statusCode).toBe(429);
    expect(second.headers['retry-after']).toBeDefined();
  });
});

describe('receiver plugin - default rate calibration', () => {
  it('admits a single-source burst well beyond the old per-IP cap at default config', async () => {
    // 450 requests from one loopback source exceeds the previous default burst of
    // 400; at the corrected default it must not 429 (backpressure, at 10k queued,
    // is what sheds, not the per-source cap). now() is fixed so tokens never refill,
    // proving the burst capacity alone is sufficient.
    const { app } = await build();
    const statuses = new Set<number>();
    for (let i = 0; i < 450; i += 1) {
      const res = await app.inject({
        method: 'POST', url: '/scim/v2/Users',
        headers: { ...SCIM_HEADERS, 'idempotency-key': `k${i}` }, payload: userBody(`usr_${i}`, `u${i}`),
      });
      statuses.add(res.statusCode);
    }
    expect(statuses.has(429)).toBe(false);
    expect(statuses.has(201)).toBe(true);
  });
});

describe('receiver plugin - webhook ingest', () => {
  it('accepts a valid HMAC-signed webhook without a bearer token', async () => {
    const { app, engine } = await build();
    const raw = serializeEnvelope(buildEnvelope(hireEvent()));
    const signature = createHmac('sha256', TOKEN).update(raw).digest('hex');
    const res = await app.inject({
      method: 'POST', url: '/ingest/webhook',
      headers: { 'content-type': 'application/json', 'x-signature': signature }, payload: raw,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toBe(1);
    expect(engine.stats().totalIngested).toBe(1);
  });

  it('rejects a webhook with a bad signature and no bearer', async () => {
    const { app } = await build();
    const raw = serializeEnvelope(buildEnvelope(hireEvent()));
    const res = await app.inject({
      method: 'POST', url: '/ingest/webhook',
      headers: { 'content-type': 'application/json', 'x-signature': 'deadbeef' }, payload: raw,
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a bearer-authenticated webhook', async () => {
    const { app } = await build();
    const raw = serializeEnvelope(buildEnvelope(hireEvent()));
    const res = await app.inject({
      method: 'POST', url: '/ingest/webhook',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, payload: raw,
    });
    expect(res.statusCode).toBe(202);
  });

  it('accepts a REST batch of events', async () => {
    const { app } = await build();
    const res = await app.inject({
      method: 'POST', url: '/ingest/events',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      payload: JSON.stringify({ source: 'urn:workday-simulator', count: 1, events: [hireEvent()] }),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toBe(1);
  });
});
