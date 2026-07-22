/**
 * The default {@link HttpTransport}, backed by undici.
 *
 * WHY undici with a pooled `Agent`: deliveries are high-volume and repeat against
 * one origin, so keep-alive connection reuse is essential to avoid a TCP/TLS
 * handshake per event. The pool is bounded so a slow target cannot open an
 * unbounded number of sockets.
 *
 * The transport is deliberately dumb: it sends already-serialized bytes and
 * returns a normalized response. Auth, signing, retries and mapping live
 * elsewhere. It ALWAYS drains the response body (as text, subject to a size cap)
 * so a socket is never leaked back to the pool half-read.
 */

import { Agent, request } from 'undici';
import { DEFAULT_HTTP_CONNECTIONS, MAX_RESPONSE_BYTES } from './constants.js';
import { DeliveryNetworkError } from './errors.js';
import type { HttpRequestSpec, HttpResponse, HttpTransport } from './types.js';

/** Flatten undici's `string | string[]` header values to single strings. */
function normalizeHeaders(raw: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/**
 * Create an undici-backed transport.
 *
 * @param options.connections Max keep-alive connections per origin.
 * @returns A transport whose `close()` drains the connection pool.
 */
export function createUndiciTransport(options: { connections?: number } = {}): HttpTransport {
  const agent = new Agent({
    connections: options.connections ?? DEFAULT_HTTP_CONNECTIONS,
    pipelining: 1,
  });

  return {
    async send(spec: HttpRequestSpec, opts: { timeoutMs: number }): Promise<HttpResponse> {
      let response;
      try {
        response = await request(spec.url, {
          method: spec.method,
          headers: spec.headers,
          ...(spec.body !== undefined ? { body: spec.body } : {}),
          dispatcher: agent,
          headersTimeout: opts.timeoutMs,
          bodyTimeout: opts.timeoutMs,
          // Redirects are not followed (undici's default): a redirect on a
          // provisioning call is a misconfiguration, not something to chase.
        });
      } catch (error) {
        // Connection reset, DNS failure, timeout: transport-level and transient.
        throw new DeliveryNetworkError(
          error instanceof Error ? error.message : 'transport error',
          error,
        );
      }

      const headers = normalizeHeaders(response.headers as Record<string, string | string[] | undefined>);
      const body = await readBodyBounded(response.body, headers['content-length']);
      return { status: response.statusCode, headers, body };
    },

    async close(): Promise<void> {
      await agent.close();
    },
  };
}

/**
 * Read a response body as text, but drain-and-discard when the declared length
 * exceeds the cap, so a hostile or misbehaving target cannot exhaust memory. The
 * body is always fully consumed either way.
 */
async function readBodyBounded(
  body: { text(): Promise<string>; dump(): Promise<void> },
  contentLength: string | undefined,
): Promise<string> {
  const declared = contentLength ? Number.parseInt(contentLength, 10) : Number.NaN;
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await body.dump();
    return '';
  }
  try {
    return await body.text();
  } catch {
    // Ensure the socket is freed even if decoding failed.
    try {
      await body.dump();
    } catch {
      /* already consumed or destroyed */
    }
    return '';
  }
}
