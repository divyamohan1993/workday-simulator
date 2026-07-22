/**
 * Shared HTTP send plumbing for the SCIM, webhook, REST and batch senders.
 *
 * It authenticates a request, sends it through the transport, and turns the
 * response into either a success (2xx) or a {@link DeliveryHttpError} carrying
 * the status and a parsed Retry-After. Keeping this in one place means every
 * sender treats statuses, Retry-After and receiver references identically, so
 * the base adapter's retry/breaker logic sees a uniform error surface.
 */

import { MAX_RESPONSE_BYTES } from './constants.js';
import { DeliveryHttpError } from './errors.js';
import type { Authenticator, HttpRequestSpec, HttpResponse, HttpTransport } from './types.js';

/** True for a 2xx status. */
export function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Parse an HTTP `Retry-After` header into milliseconds. Supports both the
 * delta-seconds form (`"120"`) and the HTTP-date form. Returns undefined when
 * absent or unparseable.
 *
 * @param headerValue The raw header value.
 * @param nowMs Current wall time, for the date form.
 * @returns Milliseconds to wait, or undefined.
 */
export function parseRetryAfterMs(headerValue: string | undefined, nowMs: number): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10) * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - nowMs);
  }
  return undefined;
}

/** A short, secret-free snippet of a response body for diagnostics. */
function bodySnippet(body: string): string | undefined {
  if (!body) return undefined;
  const trimmed = body.slice(0, 200).replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Extract a receiver-assigned reference (SCIM id, or a Location tail). */
export function extractReceiverRef(response: HttpResponse): string | undefined {
  const location = response.headers['location'];
  if (location) {
    const tail = location.split('/').filter(Boolean).pop();
    if (tail) return tail;
  }
  if (response.body && response.body.length <= MAX_RESPONSE_BYTES) {
    try {
      const parsed = JSON.parse(response.body) as { id?: unknown };
      if (typeof parsed.id === 'string') return parsed.id;
    } catch {
      /* body is not JSON; no ref to extract */
    }
  }
  return undefined;
}

/** Extract an ETag for optimistic concurrency, stripping weak/quote markers. */
export function extractEtag(response: HttpResponse): string | undefined {
  return response.headers['etag'];
}

/**
 * Authenticate and send one request, returning the response on 2xx or throwing a
 * {@link DeliveryHttpError} (with parsed Retry-After) on any non-2xx.
 *
 * @param deps Transport, authenticator, timeout and clock.
 * @param spec The request to send. Auth is applied in place before sending.
 * @returns The successful response.
 */
export async function authenticateAndSend(
  deps: { transport: HttpTransport; auth: Authenticator; timeoutMs: number; now: () => number },
  spec: HttpRequestSpec,
): Promise<HttpResponse> {
  await deps.auth.apply(spec);
  const response = await deps.transport.send(spec, { timeoutMs: deps.timeoutMs });
  if (isSuccess(response.status)) return response;

  // On 401 drop any cached credential so the next attempt re-authenticates.
  if (response.status === 401) deps.auth.invalidate();

  const retryAfterMs = parseRetryAfterMs(response.headers['retry-after'], deps.now());
  throw new DeliveryHttpError(response.status, {
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(bodySnippet(response.body) !== undefined ? { bodySnippet: bodySnippet(response.body) } : {}),
  });
}
