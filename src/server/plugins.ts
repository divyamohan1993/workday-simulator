/**
 * Cross-cutting Fastify plugin registration: security headers, CORS, global rate
 * limiting, the WebSocket engine, and the static dashboard with its SPA/JSON
 * not-found fallback. Kept out of the composition root so build-server.ts stays a
 * readable wiring diagram.
 *
 * Two decisions worth calling out:
 * - The global rate limiter allow-lists the loopback interface. The built-in delivery
 *   path POSTs from THIS process to 127.0.0.1, so a per-ip cap that counted it would
 *   throttle the very traffic the demo generates. Genuine external abuse is still
 *   capped; the loopback exemption only spares the server talking to itself.
 * - The CSP keeps `script-src 'self'` (the XSS-relevant directive) strict while
 *   allowing inline styles, which chart and animation libraries inject at runtime,
 *   and `connect-src 'self'` so the same-origin telemetry WebSocket connects. No
 *   `upgrade-insecure-requests`, so a plain-http localhost or preview still loads.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/schema.js';
import type { ServerContext } from './context.js';
import { sendError } from './errors.js';

/** Requests per source ip per window before the global limiter sheds with 429. */
const GLOBAL_RATE_MAX = 1_000;

/** The global rate-limit window. */
const GLOBAL_RATE_WINDOW = '1 minute';

/** Loopback addresses exempt from the global limit (the built-in delivery source). */
const LOOPBACK_ALLOWLIST: readonly string[] = ['127.0.0.1', '::1'];

/** Register helmet, CORS, the global rate limiter and the WebSocket engine. */
export async function registerSecurityPlugins(app: FastifyInstance, config: AppConfig): Promise<void> {
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  const origins = config.CORS_ORIGINS;
  await app.register(fastifyCors, {
    origin: origins.length > 0 ? origins : false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Correlation-Id'],
    credentials: origins.length > 0,
  });

  await app.register(fastifyRateLimit, {
    global: true,
    max: GLOBAL_RATE_MAX,
    timeWindow: GLOBAL_RATE_WINDOW,
    allowList: [...LOOPBACK_ALLOWLIST],
    errorResponseBuilder: (request: FastifyRequest) => ({
      error: 'Rate limit exceeded',
      code: 'rate_limited',
      requestId: request.id,
    }),
  });

  await app.register(fastifyWebsocket);
}

/**
 * Register the static dashboard when a build exists, then install the not-found
 * handler: an SPA fallback (serve index.html) for browser GETs when static is served,
 * and the uniform JSON 404 for programmatic surfaces or when no build is present.
 */
export async function registerStaticAndNotFound(
  app: FastifyInstance,
  ctx: ServerContext,
  serveStatic: boolean,
): Promise<void> {
  let staticEnabled = false;
  const distPath = resolve(ctx.config.WEB_DIST_PATH);

  if (serveStatic && existsSync(distPath)) {
    await app.register(fastifyStatic, {
      root: distPath,
      prefix: '/',
      // wildcard:false globs the built files at registration and registers exact
      // routes, so it never shadows /api, /scim, /ingest or /ws with a greedy /*.
      wildcard: false,
      index: ['index.html'],
      cacheControl: true,
      maxAge: '1h',
    });
    staticEnabled = true;
    ctx.logger.info({ distPath }, 'serving web dashboard from static build');
  } else if (serveStatic) {
    ctx.logger.warn({ distPath }, 'web build not found; dashboard will not be served (API only)');
  }

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url.split('?')[0] ?? request.url;
    const isApiSurface =
      path.startsWith('/api') ||
      path.startsWith('/scim') ||
      path.startsWith('/ingest') ||
      path.startsWith('/ws');
    if (staticEnabled && request.method === 'GET' && !isApiSurface) {
      // SPA client-side routing: hand unmatched browser navigations to the app shell.
      return reply.type('text/html').sendFile('index.html');
    }
    return sendError(reply, request, 404, 'not_found', `Route ${request.method} ${path} not found`);
  });
}
