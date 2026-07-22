/**
 * Admin authentication for the control plane.
 *
 * WHY here and not a generic middleware: BUILD-CONTRACT section 5 binds a specific
 * policy to `/api/*`, a bearer token equal to `ADMIN_TOKEN`, with the two health
 * routes public, and an escalation to 429 after three failed authentications from
 * one source in a short window. That escalation is a cheap, memory-bounded brute
 * force damper in front of the token check; it is not a substitute for the edge WAF,
 * it is defense in depth so a single host hammering the panel is shed before the
 * (constant-time) comparison runs on every attempt.
 *
 * The token comparison is constant-time (`crypto.timingSafeEqual` over equal-length
 * buffers) so the endpoint leaks no timing signal about how many leading bytes of a
 * guess were correct. A length mismatch returns false without comparing, which is
 * safe: the length of a rejected guess is not secret, only the token's bytes are.
 */

import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sendError } from './errors.js';

/** Failed attempts from one source within the window before requests are shed. */
export const FAILED_AUTH_THRESHOLD = 3;

/** Sliding window, in ms, over which failed attempts accumulate toward the block. */
export const FAILED_AUTH_WINDOW_MS = 60_000;

/** Max distinct sources tracked before the least-recent are evicted (bounded memory). */
export const FAILED_AUTH_MAX_KEYS = 50_000;

/** Public routes that never require a token (health probes must stay reachable). */
const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/api/health', '/api/health/ready']);

/** Per-source failed-attempt state within the current window. */
interface AttemptWindow {
  count: number;
  windowStartMs: number;
}

/**
 * A bounded, insertion-ordered tracker of failed authentications per source ip. It
 * evicts the oldest source when it grows past the cap so a spoofed-source flood
 * cannot exhaust memory. All timing is injectable for deterministic tests.
 */
export class FailedAuthTracker {
  private readonly windows = new Map<string, AttemptWindow>();
  private readonly now: () => number;
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;

  constructor(options: { now?: () => number; threshold?: number; windowMs?: number; maxKeys?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.threshold = options.threshold ?? FAILED_AUTH_THRESHOLD;
    this.windowMs = options.windowMs ?? FAILED_AUTH_WINDOW_MS;
    this.maxKeys = options.maxKeys ?? FAILED_AUTH_MAX_KEYS;
  }

  /** True when this source has already reached the failure threshold this window. */
  isBlocked(ip: string): boolean {
    const entry = this.windows.get(ip);
    if (!entry) return false;
    if (this.now() - entry.windowStartMs > this.windowMs) {
      this.windows.delete(ip);
      return false;
    }
    return entry.count >= this.threshold;
  }

  /** Record one failed attempt for a source and return whether it is now blocked. */
  recordFailure(ip: string): boolean {
    const nowMs = this.now();
    let entry = this.windows.get(ip);
    if (!entry || nowMs - entry.windowStartMs > this.windowMs) {
      entry = { count: 0, windowStartMs: nowMs };
    } else {
      // Refresh recency: re-insertion moves the key to the end of the Map.
      this.windows.delete(ip);
    }
    entry.count += 1;
    this.windows.set(ip, entry);
    this.evictIfNeeded();
    return entry.count >= this.threshold;
  }

  /** Clear a source's failure state after a successful authentication. */
  clear(ip: string): void {
    this.windows.delete(ip);
  }

  private evictIfNeeded(): void {
    while (this.windows.size > this.maxKeys) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
  }
}

/** Constant-time equality for two secrets; false on any length mismatch. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Extract a bearer token from the Authorization header, if well-formed. */
export function extractBearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * Build the `onRequest` hook that guards every `/api/*` route except the public
 * health probes. Order of checks: skip public routes, shed already-blocked sources
 * with 429, then constant-time compare the bearer token, recording a failure (and
 * possibly tripping the block) on mismatch and clearing the source on success.
 *
 * @param adminToken The configured `ADMIN_TOKEN`.
 * @param tracker The shared failed-auth tracker (one per server instance).
 * @returns A Fastify `onRequest` hook.
 */
export function createAdminAuthHook(
  adminToken: string,
  tracker: FailedAuthTracker,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply): Promise<void> => {
    // CORS preflight carries no credentials and mutates nothing; @fastify/cors answers
    // it. Skipping OPTIONS here prevents a spurious 401 on a legitimate preflight.
    if (request.method === 'OPTIONS') return;

    // `routeOptions.url` is the matched route pattern; fall back to the raw url so a
    // request that never matched a route is still evaluated against the public set.
    const routeUrl = request.routeOptions?.url ?? request.url.split('?')[0] ?? request.url;
    if (PUBLIC_PATHS.has(routeUrl)) return;

    const ip = request.ip;
    if (tracker.isBlocked(ip)) {
      reply.header('retry-after', String(Math.ceil(FAILED_AUTH_WINDOW_MS / 1000)));
      await sendError(reply, request, 429, 'too_many_failed_auth', 'Too many failed authentication attempts');
      return;
    }

    const provided = extractBearer(request);
    if (provided !== undefined && timingSafeEqualStr(provided, adminToken)) {
      tracker.clear(ip);
      return;
    }

    const nowBlocked = tracker.recordFailure(ip);
    reply.header('www-authenticate', 'Bearer');
    if (nowBlocked) reply.header('retry-after', String(Math.ceil(FAILED_AUTH_WINDOW_MS / 1000)));
    await sendError(reply, request, 401, 'unauthorized', 'Invalid or missing admin token');
  };
}
