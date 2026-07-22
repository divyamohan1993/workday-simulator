import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { EventOfKind, WorkdayEvent } from '../types/index.js';
import { createAuthenticator } from './auth.js';
import { buildEnvelope, serializeEnvelope } from './envelope.js';
import { createWebhookSender } from './sender-webhook.js';
import type { HttpRequestSpec, HttpResponse, HttpTransport } from './types.js';

const noopLogger = { warn: vi.fn(), child: vi.fn() } as unknown as Logger;

function event(): WorkdayEvent {
  const e: EventOfKind<'joiner.hire'> = {
    id: 'evt_hook',
    kind: 'joiner.hire',
    category: 'JML',
    timestamp: '2026-07-22T08:00:00.000Z',
    emittedAtWall: '2026-07-22T08:00:00.100Z',
    correlationId: 'corr_1',
    severity: 'notice',
    actor: { kind: 'system', id: 'sys', component: 'hr-feed' },
    subject: {
      id: 'emp_9',
      employeeId: 'DB00999999',
      displayName: 'Ada Lovelace',
      email: 'ada.lovelace@db.com',
      division: 'Risk',
      location: 'LDN',
      grade: 'Director',
      type: 'FTE',
    },
    location: 'LDN',
    division: 'Risk',
    delivery: { operation: 'create', resource: 'identity', idempotencyKey: 'idem_hook', priority: 'high', requiresApproval: false },
    seq: 1,
    payload: {
      effectiveDate: '2026-07-22',
      employeeType: 'FTE',
      division: 'Risk',
      grade: 'Director',
      managerId: null,
      location: 'LDN',
      contractType: 'permanent',
      positionId: 'POS-9',
      birthrightEntitlements: [],
    },
  };
  return e;
}

function fakeTransport(response: HttpResponse): HttpTransport & { calls: HttpRequestSpec[] } {
  const calls: HttpRequestSpec[] = [];
  return {
    calls,
    async send(request: HttpRequestSpec): Promise<HttpResponse> {
      calls.push(request);
      return response;
    },
    async close(): Promise<void> {},
  };
}

describe('createWebhookSender', () => {
  it('posts the envelope and signs the exact transmitted bytes with HMAC', async () => {
    const secret = 'webhook-shared-secret'; // pragma: allowlist secret
    const transport = fakeTransport({ status: 200, headers: {}, body: '{"ok":true}' });
    const auth = createAuthenticator(
      { kind: 'hmac', algorithm: 'sha256', secret, header: 'X-Signature', signaturePrefix: 'sha256=' },
      { transport, logger: noopLogger },
    );
    const sender = createWebhookSender({ target: { url: 'http://receiver.local/ingest/webhook', headers: {} }, transport, auth });

    const e = event();
    const result = await sender.sendOne(e);
    expect(result.httpStatus).toBe(200);

    const sent = transport.calls[0];
    expect(sent?.method).toBe('POST');
    expect(sent?.url).toBe('http://receiver.local/ingest/webhook');
    expect(sent?.headers['idempotency-key']).toBe('idem_hook');

    // The body is exactly the serialized envelope, and the signature is HMAC over
    // those very bytes (what the receiver must verify against the raw body).
    const expectedBody = serializeEnvelope(buildEnvelope(e));
    expect(sent?.body).toBe(expectedBody);
    const expectedSig = `sha256=${createHmac('sha256', secret).update(expectedBody).digest('hex')}`;
    expect(sent?.headers['x-signature']).toBe(expectedSig);
  });
});
