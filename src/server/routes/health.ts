/**
 * Health and config routes. These are the only `/api` routes that do not require the
 * admin token: a probe must be able to answer before any credential is presented, and
 * `/api/config` returns only non-secret operational facts the dashboard needs to
 * render (never a token, url secret, or db path).
 *
 * `/api/health` is shallow (liveness): it answers as long as the process serves.
 * `/api/health/ready` is deep (readiness): it verifies the database answers and the
 * receiver reports stats, and carries the verdict in the body. Per BUILD-CONTRACT
 * section 7 the status code is 200 in both the ready and not-ready cases; readiness is
 * read from `status`/`checks`, not from the HTTP code.
 */

import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.js';
import { appVersion } from '../version.js';

/** Register `/health`, `/health/ready` and `/config` on the `/api` instance. */
export function registerHealthRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/health', async () => ({
    status: 'ok',
    uptimeSec: Math.floor(process.uptime()),
    version: appVersion(),
  }));

  app.get('/health/ready', async (_request, reply) => {
    const checks = { db: false, receiver: false };
    try {
      // A trivial indexed lookup proves the SQLite handle is open and answering.
      ctx.stores.targets.get(ctx.builtInTargetId);
      checks.db = true;
    } catch (err) {
      ctx.logger.warn({ err }, 'readiness: database check failed');
    }
    try {
      ctx.receiver.stats();
      checks.receiver = true;
    } catch (err) {
      ctx.logger.warn({ err }, 'readiness: receiver check failed');
    }
    const ready = checks.db && checks.receiver;
    // The frozen contract fixes this at 200; the verdict lives in the body.
    reply.code(200);
    return { status: ready ? 'ready' : 'not_ready', checks };
  });

  app.get('/config', async () => ({
    port: ctx.config.PORT,
    defaultTargetKind: ctx.config.DEFAULT_TARGET_KIND,
    workdayAccel: ctx.config.WORKDAY_ACCEL,
    maxRps: ctx.config.MAX_RPS,
    metricsIntervalMs: ctx.config.METRICS_INTERVAL_MS,
    natsEnabled: ctx.config.NATS_URL !== undefined,
    identityPoolSize: ctx.config.IDENTITY_POOL_SIZE,
    version: appVersion(),
  }));
}
