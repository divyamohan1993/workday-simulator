/**
 * A real connectivity probe for `POST /api/targets/:id/test`.
 *
 * WHY a lightweight GET rather than a synthetic delivery: the operator wants to know
 * "can this server reach the sink and is it answering", not "does one crafted event
 * provision". So the probe issues a bounded, authenticated GET to the target's url
 * over undici and reports the outcome. Reachability is defined honestly: ANY HTTP
 * response, including a 4xx/5xx, means the origin is up and answering (`ok: true`
 * with the status); only a transport failure (DNS, refused, TLS, timeout) is `ok:
 * false` with the error. NATS targets have no HTTP surface, so their result reflects
 * whether a NATS connection is currently established.
 *
 * The probe never echoes a secret: it may attach the target's bearer/basic
 * credential to the request, but the returned result carries only ok/status/error.
 */

import { request as undiciRequest } from 'undici';
import type { DeliveryTarget } from '../types/index.js';

/** The shape returned by the test endpoint (BUILD-CONTRACT section 7). */
export interface TargetProbeResult {
  ok: boolean;
  latencyMs?: number;
  httpStatus?: number;
  error?: string;
}

/** Default probe timeout; short so a dead sink fails fast without hanging the UI. */
const PROBE_TIMEOUT_MS = 5_000;

/** Build the Authorization header for a reachability GET, when the scheme has one. */
function probeAuthHeader(target: DeliveryTarget): Record<string, string> {
  switch (target.auth.kind) {
    case 'bearer':
      return { authorization: `Bearer ${target.auth.token}` };
    case 'basic': {
      const encoded = Buffer.from(`${target.auth.username}:${target.auth.password}`, 'utf8').toString('base64');
      return { authorization: `Basic ${encoded}` };
    }
    // oauth2 and hmac need a token exchange or a signed body that a bare GET does not
    // carry; the reachability check runs unauthenticated for them, which still proves
    // the origin is up (it answers, typically with 401/404).
    default:
      return {};
  }
}

/**
 * Probe a delivery target for reachability.
 *
 * @param target The target to test.
 * @param opts `natsConnected` reflects whether a NATS connection is live (for nats
 *   targets); `timeoutMs` overrides the default; `now` is injectable for tests.
 */
export async function probeTarget(
  target: DeliveryTarget,
  opts: { natsConnected?: boolean; timeoutMs?: number; now?: () => number } = {},
): Promise<TargetProbeResult> {
  const now = opts.now ?? Date.now;
  const startedAt = now();

  if (target.kind === 'nats') {
    return opts.natsConnected
      ? { ok: true, latencyMs: 0 }
      : { ok: false, error: 'NATS connection is not established' };
  }

  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  try {
    const response = await undiciRequest(target.url, {
      method: 'GET',
      headers: { ...target.headers, ...probeAuthHeader(target) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Discard the body so the connection is released back to the pool promptly.
    await response.body.dump();
    return { ok: true, httpStatus: response.statusCode, latencyMs: Math.max(0, now() - startedAt) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message, latencyMs: Math.max(0, now() - startedAt) };
  }
}
