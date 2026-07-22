/**
 * Telemetry, metrics and receiver routes: the pull-based companions to the push-based
 * WebSocket.
 *
 * `/telemetry/current` and `/telemetry/events` serve the last frame the hub captured,
 * so a client that loads mid-run (or cannot hold a socket open) still paints. When no
 * run is active there is no current frame, so `/telemetry/current` answers 204 rather
 * than a stale snapshot. `/metrics` pairs the live registry view with recent run
 * history for charting. `/receiver/*` exposes and resets the built-in OneIM's stats.
 */

import type { FastifyInstance } from 'fastify';
import type { WorkdayEvent } from '../../types/index.js';
import type { ServerContext } from '../context.js';
import { firstString, parsePagination } from '../helpers.js';

/** Clamp a recent-events limit query to a sane range. */
function eventLimit(raw: string | undefined): number {
  if (raw === undefined) return 50;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(Math.trunc(n), 1_000);
}

/** Register telemetry, metrics and receiver routes on the `/api` instance. */
export function registerObservabilityRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/telemetry/current', async (_request, reply) => {
    // Only surface a frame while a run is live, and only if it belongs to THAT run: a
    // freshly started run may not have emitted its first frame yet, and the retained
    // frame is the previous run's, so returning it would be stale.
    const state = ctx.runtime.state();
    const frame = ctx.telemetry.lastFrame();
    if (state === null || !frame || frame.run?.id !== state.id) {
      reply.code(204);
      return null;
    }
    return frame;
  });

  app.get('/telemetry/events', async (request) => {
    const query = request.query as Record<string, unknown>;
    const limit = eventLimit(firstString(query['limit']));
    const recent: WorkdayEvent[] = ctx.telemetry.lastFrame()?.recentEvents ?? [];
    return recent.slice(0, limit);
  });

  app.get('/metrics', async (request) => {
    const { limit, offset } = parsePagination(request.query as Record<string, unknown>);
    return {
      current: {
        currentRps: ctx.metrics.currentRps(),
        latency: ctx.metrics.latency(),
        samples: ctx.metrics.samples(),
        frame: ctx.telemetry.lastFrame(),
        activeRun: ctx.runtime.state(),
      },
      historical: {
        runs: ctx.stores.runs.list(limit, offset),
      },
    };
  });

  app.get('/receiver/stats', async () => ctx.receiver.stats());

  app.post('/receiver/reset', async (_request, reply) => {
    ctx.receiver.reset();
    reply.code(204);
    return null;
  });
}
