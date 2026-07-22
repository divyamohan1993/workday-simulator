/**
 * Webhook HMAC signature verification over the raw request body.
 *
 * WHY verify the RAW bytes: the delivery adapter signs the exact serialized
 * envelope, and any re-serialization on this side could differ (key order,
 * whitespace) and fail a valid signature. The plugin captures the untouched body
 * for the webhook route and hands it here. The shared secret is the receiver's own
 * token, the only secret the frozen `ReceiverOptions` carries, so the built-in
 * webhook target signs with that token and this side verifies with it. Comparison
 * is constant-time to avoid leaking the expected signature through timing.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { HMAC_SIGNATURE_HEADERS } from './constants.js';

/** A minimal read-only view of inbound headers (Fastify lowercases keys). */
export type HeaderBag = Record<string, string | string[] | undefined>;

/** Read a single header value, taking the first when duplicated. */
function headerValue(headers: HeaderBag, name: string): string | undefined {
  const raw = headers[name];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/** Whether any recognized signature header is present on the request. */
export function hasSignatureHeader(headers: HeaderBag): boolean {
  return HMAC_SIGNATURE_HEADERS.some((name) => headerValue(headers, name) !== undefined);
}

/** Constant-time hex-string equality; false on any length or format mismatch. */
function hexEqual(a: string, b: string): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  let bufA: Buffer;
  let bufB: Buffer;
  try {
    bufA = Buffer.from(a, 'hex');
    bufB = Buffer.from(b, 'hex');
  } catch {
    return false;
  }
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Split an optional `algo=` prefix off a signature value. */
function parseSignature(raw: string): { algorithm: 'sha256' | 'sha512' | undefined; hex: string } {
  const eq = raw.indexOf('=');
  if (eq > 0) {
    const prefix = raw.slice(0, eq).toLowerCase();
    const hex = raw.slice(eq + 1);
    if (prefix === 'sha256') return { algorithm: 'sha256', hex };
    if (prefix === 'sha512') return { algorithm: 'sha512', hex };
  }
  return { algorithm: undefined, hex: raw };
}

/**
 * Verify a webhook HMAC signature over `rawBody` using `secret`.
 *
 * Returns true only when a signature header is present and matches. When the
 * signature carries an explicit `sha256=`/`sha512=` prefix that algorithm is used;
 * otherwise both SHA-256 and SHA-512 are tried so a prefix-less signer still
 * verifies.
 *
 * @param rawBody The exact received body bytes as a string.
 * @param headers The inbound headers.
 * @param secret The shared HMAC secret (the receiver token).
 * @returns Whether the signature is valid.
 */
export function verifyWebhookSignature(rawBody: string, headers: HeaderBag, secret: string): boolean {
  for (const name of HMAC_SIGNATURE_HEADERS) {
    const value = headerValue(headers, name);
    if (value === undefined) continue;
    const { algorithm, hex } = parseSignature(value.trim());
    const candidates: Array<'sha256' | 'sha512'> = algorithm ? [algorithm] : ['sha256', 'sha512'];
    for (const alg of candidates) {
      const expected = createHmac(alg, secret).update(rawBody).digest('hex');
      if (hexEqual(expected, hex)) return true;
    }
  }
  return false;
}
