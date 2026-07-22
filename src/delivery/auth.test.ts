import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { createAuthenticator } from './auth.js';
import type { HttpRequestSpec, HttpResponse, HttpTransport } from './types.js';

const noopLogger = {
  warn: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

function spec(body?: string): HttpRequestSpec {
  return { method: 'POST', url: 'https://idm.example.com/scim/v2/Users', headers: {}, ...(body !== undefined ? { body } : {}) };
}

/** A programmable transport that records requests and returns queued responses. */
function fakeTransport(responses: HttpResponse[]): HttpTransport & { calls: HttpRequestSpec[] } {
  const calls: HttpRequestSpec[] = [];
  let index = 0;
  return {
    calls,
    async send(request: HttpRequestSpec): Promise<HttpResponse> {
      calls.push(request);
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (!response) throw new Error('no response queued');
      return response;
    },
    async close(): Promise<void> {
      /* nothing to close */
    },
  };
}

describe('createAuthenticator', () => {
  it('none applies no credential', async () => {
    const auth = createAuthenticator({ kind: 'none' }, { transport: fakeTransport([]), logger: noopLogger });
    const s = spec();
    await auth.apply(s);
    expect(s.headers).toEqual({});
  });

  it('bearer sets the Authorization header', async () => {
    const auth = createAuthenticator({ kind: 'bearer', token: 'secret-token' }, { transport: fakeTransport([]), logger: noopLogger });
    const s = spec();
    await auth.apply(s);
    expect(s.headers.authorization).toBe('Bearer secret-token');
  });

  it('basic base64-encodes user:pass', async () => {
    const auth = createAuthenticator(
      { kind: 'basic', username: 'svc', password: 'p@ss:word' },
      { transport: fakeTransport([]), logger: noopLogger },
    );
    const s = spec();
    await auth.apply(s);
    const expected = `Basic ${Buffer.from('svc:p@ss:word').toString('base64')}`;
    expect(s.headers.authorization).toBe(expected);
  });

  it('hmac signs the exact body into the configured header with a prefix', async () => {
    const secret = 'shared-hmac-secret'; // pragma: allowlist secret
    const auth = createAuthenticator(
      { kind: 'hmac', algorithm: 'sha256', secret, header: 'X-Signature', signaturePrefix: 'sha256=' },
      { transport: fakeTransport([]), logger: noopLogger },
    );
    const body = '{"hello":"world"}';
    const s = spec(body);
    await auth.apply(s);
    const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    expect(s.headers['x-signature']).toBe(expected);
  });

  it('hmac signs an empty string when there is no body', async () => {
    const secret = 'k';
    const auth = createAuthenticator(
      { kind: 'hmac', algorithm: 'sha256', secret, header: 'X-Signature' },
      { transport: fakeTransport([]), logger: noopLogger },
    );
    const s = spec();
    await auth.apply(s);
    expect(s.headers['x-signature']).toBe(createHmac('sha256', secret).update('').digest('hex'));
  });

  it('oauth2 fetches once, caches, and refreshes after expiry with single-flight', async () => {
    let clock = 0;
    const transport = fakeTransport([
      { status: 200, headers: {}, body: JSON.stringify({ access_token: 'tok-1', expires_in: 3_600 }) },
      { status: 200, headers: {}, body: JSON.stringify({ access_token: 'tok-2', expires_in: 3_600 }) },
    ]);
    const auth = createAuthenticator(
      {
        kind: 'oauth2_client_credentials',
        tokenUrl: 'https://idp.example.com/token',
        clientId: 'client',
        clientSecret: 'shh',
        scope: 'scim',
      },
      { transport, logger: noopLogger, now: () => clock },
    );

    // Two concurrent applies share ONE token fetch (single-flight).
    const [a, b] = [spec(), spec()];
    await Promise.all([auth.apply(a), auth.apply(b)]);
    expect(transport.calls).toHaveLength(1);
    expect(a.headers.authorization).toBe('Bearer tok-1');
    expect(b.headers.authorization).toBe('Bearer tok-1');

    // The token endpoint received a client-credentials form with Basic client auth.
    const tokenCall = transport.calls[0];
    expect(tokenCall?.body).toContain('grant_type=client_credentials');
    expect(tokenCall?.body).toContain('scope=scim');
    expect(tokenCall?.headers.authorization).toBe(`Basic ${Buffer.from('client:shh').toString('base64')}`);

    // Still cached: no new fetch.
    const c = spec();
    await auth.apply(c);
    expect(transport.calls).toHaveLength(1);
    expect(c.headers.authorization).toBe('Bearer tok-1');

    // Past expiry (minus skew): a refresh fetches the second token.
    clock = 3_600 * 1_000;
    const d = spec();
    await auth.apply(d);
    expect(transport.calls).toHaveLength(2);
    expect(d.headers.authorization).toBe('Bearer tok-2');
  });

  it('oauth2 surfaces a non-2xx token response as an error without logging the body', async () => {
    const transport = fakeTransport([{ status: 401, headers: {}, body: 'client_secret=leaked' }]);
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    const auth = createAuthenticator(
      { kind: 'oauth2_client_credentials', tokenUrl: 'https://idp/token', clientId: 'c', clientSecret: 's' },
      { transport, logger, now: () => 0 },
    );
    await expect(auth.apply(spec())).rejects.toThrow(/oauth token request failed/);
    // The failure is logged with the status, never the (potentially secret) body.
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls[0]?.[0] ?? {});
    expect(logged).not.toContain('leaked');
  });
});
