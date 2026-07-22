/**
 * Run lifecycle routes: start, inspect, stop, pause, resume, chaos-inject.
 *
 * The runtime enforces one active run at a time and owns the control loop; this
 * module is the thin HTTP surface over it, reconciling the runtime's live view
 * (`state()`) with the run store's persisted history so a request always gets the
 * freshest truth: the live state for the active run, the stored record for past ones.
 *
 * Status-code discipline follows BUILD-CONTRACT section 7: 404 for an unknown id,
 * 409 when the requested transition is illegal for the run's current state (already
 * active, not active, not finished), and the success code the table specifies.
 */

import type { FastifyInstance } from 'fastify';
import { chaosInjectorConfigSchema, runStartSchema } from '../../contracts/validation.js';
import type { ServerContext } from '../context.js';
import { AppHttpError, conflict, notFound } from '../errors.js';
import { parsePagination } from '../helpers.js';

/** Register the `/runs` lifecycle routes on the `/api` instance. */
export function registerRunRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/runs', async (request) => {
    const { limit, offset } = parsePagination(request.query as Record<string, unknown>);
    return ctx.stores.runs.list(limit, offset);
  });

  app.post('/runs', async (request, reply) => {
    const input = runStartSchema.parse(request.body);
    const scenario = ctx.stores.scenarios.get(input.scenarioId);
    if (!scenario) throw notFound(`Scenario ${input.scenarioId} not found`, 'scenario_not_found');
    const targetId = input.targetId ?? scenario.targetId;
    const target = ctx.stores.targets.get(targetId);
    if (!target) throw notFound(`Target ${targetId} not found`, 'target_not_found');

    if (ctx.runtime.state() !== null) throw conflict('A run is already active', 'run_active');

    try {
      const runState = await ctx.runtime.start(scenario, target);
      reply.code(201);
      return runState;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/already active/i.test(message)) throw conflict('A run is already active', 'run_active');
      ctx.logger.error({ err, scenarioId: scenario.id, targetId }, 'run start failed');
      throw new AppHttpError(500, 'run_start_failed', 'Failed to start run');
    }
  });

  app.get('/runs/:id', async (request) => {
    const { id } = request.params as { id: string };
    const active = ctx.runtime.state();
    if (active && active.id === id) return active;
    const run = ctx.stores.runs.get(id);
    if (!run) throw notFound(`Run ${id} not found`, 'run_not_found');
    return run;
  });

  app.get('/runs/:id/summary', async (request) => {
    const { id } = request.params as { id: string };
    const summary = ctx.stores.runs.getSummary(id);
    if (summary) return summary;
    const run = ctx.stores.runs.get(id);
    if (!run) throw notFound(`Run ${id} not found`, 'run_not_found');
    throw conflict(`Run ${id} has not finished`, 'run_not_finished');
  });

  app.post('/runs/:id/stop', async (request) => {
    const { id } = request.params as { id: string };
    const active = ctx.runtime.state();
    if (active && active.id === id) {
      return ctx.runtime.stop();
    }
    const existing = ctx.stores.runs.get(id);
    if (!existing) throw notFound(`Run ${id} not found`, 'run_not_found');
    // Not the active run: if it already finished, return its summary (idempotent stop).
    const summary = ctx.stores.runs.getSummary(id);
    if (summary) return summary;
    throw conflict(`Run ${id} is not active`, 'run_not_active');
  });

  app.post('/runs/:id/pause', async (request) => {
    const { id } = request.params as { id: string };
    const active = ctx.runtime.state();
    if (!active || active.id !== id) throw conflict(`Run ${id} is not the active run`, 'run_not_active');
    if (active.status !== 'running') throw conflict(`Run ${id} is not running`, 'run_not_running');
    ctx.runtime.pause();
    return ctx.runtime.state() ?? active;
  });

  app.post('/runs/:id/resume', async (request) => {
    const { id } = request.params as { id: string };
    const active = ctx.runtime.state();
    if (!active || active.id !== id) throw conflict(`Run ${id} is not the active run`, 'run_not_active');
    if (active.status !== 'paused') throw conflict(`Run ${id} is not paused`, 'run_not_paused');
    ctx.runtime.resume();
    return ctx.runtime.state() ?? active;
  });

  app.post('/runs/:id/chaos', async (request, reply) => {
    const { id } = request.params as { id: string };
    const config = chaosInjectorConfigSchema.parse(request.body);
    const active = ctx.runtime.state();
    if (!active || active.id !== id) throw conflict(`Run ${id} is not active`, 'run_not_active');
    try {
      ctx.runtime.injectChaos(config);
    } catch (err) {
      ctx.logger.warn({ err, runId: id, kind: config.kind }, 'chaos injection rejected');
      throw conflict('Cannot inject chaos: run is not active', 'run_not_active');
    }
    reply.code(202);
    return { injected: config.kind };
  });
}
