import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hasSignatureHeader, verifyWebhookSignature } from './hmac.js';

const SECRET = 'receiver-token-abcdef123456'; // pragma: allowlist secret (deterministic test fixture, not a real credential)
const BODY = '{"specversion":"1.0","id":"evt_1","data":{"kind":"joiner.hire"}}';

describe('webhook HMAC verification', () => {
  it('verifies a valid SHA-256 signature over the raw body', () => {
    const sig = createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(verifyWebhookSignature(BODY, { 'x-signature': sig }, SECRET)).toBe(true);
  });

  it('accepts an explicit algorithm prefix', () => {
    const sig256 = createHmac('sha256', SECRET).update(BODY).digest('hex');
    const sig512 = createHmac('sha512', SECRET).update(BODY).digest('hex');
    expect(verifyWebhookSignature(BODY, { 'x-signature': `sha256=${sig256}` }, SECRET)).toBe(true);
    expect(verifyWebhookSignature(BODY, { 'x-signature': `sha512=${sig512}` }, SECRET)).toBe(true);
  });

  it('rejects a wrong signature, a wrong secret, and a tampered body', () => {
    const sig = createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(verifyWebhookSignature(BODY, { 'x-signature': 'deadbeef' }, SECRET)).toBe(false);
    expect(verifyWebhookSignature(BODY, { 'x-signature': sig }, 'wrong-secret')).toBe(false);
    expect(verifyWebhookSignature(`${BODY} `, { 'x-signature': sig }, SECRET)).toBe(false);
  });

  it('rejects when no signature header is present', () => {
    expect(verifyWebhookSignature(BODY, {}, SECRET)).toBe(false);
    expect(hasSignatureHeader({})).toBe(false);
    expect(hasSignatureHeader({ 'x-signature': 'x' })).toBe(true);
  });

  it('accepts alternate signature header names', () => {
    const sig = createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(verifyWebhookSignature(BODY, { 'x-hub-signature-256': `sha256=${sig}` }, SECRET)).toBe(true);
  });
});
