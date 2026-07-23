/**
 * Scenario CRUD. Every mutating body is validated against the frozen
 * `scenarioInputSchema` (all input is hostile) before a `ScenarioConfig` is minted;
 * server-managed fields (id, timestamps) are assigned here, never trusted from the
 * client.
 *
 * One deliberate enrichment: when a scenario omits per-kind mix weights, the events
 * module's recommended `DEFAULT_EVENT_MIX.byKind` is filled in. Without it the engine
 * would treat every kind in a category as equally likely (as many break-glass events
 * as logins), which is not a realistic bank day. Explicit per-kind weights from the
 * client are always respected.
 */

import { nanoid } from 'nanoid';
import type { FastifyInstance } from 'fastify';
import type { ScenarioInput } from '../../contracts/validation.js';
import { scenarioInputSchema } from '../../contracts/validation.js';
import { DEFAULT_EVENT_MIX } from '../../events/index.js';
import type { EventKind, EventMixWeights, ScenarioConfig } from '../../types/index.js';
import type { ServerContext } from '../context.js';
import { notFound } from '../errors.js';
import { parsePagination } from '../helpers.js';

/** Resolve the per-kind mix: client-provided if present, else the recommended default. */
function resolveEventMix(input: ScenarioInput['eventMix']): EventMixWeights {
  const byKind: Partial<Record<EventKind, number>> =
    input.byKind !== undefined
      ? (input.byKind as Partial<Record<EventKind, number>>)
      : { ...(DEFAULT_EVENT_MIX.byKind ?? {}) };
  return { byCategory: { ...input.byCategory }, byKind };
}

/** Build a full `ScenarioConfig` from validated input plus server-assigned fields. */
function toScenario(input: ScenarioInput, id: string, createdAt: string, updatedAt: string): ScenarioConfig {
  return {
    id,
    name: input.name,
    description: input.description,
    baselineRps: input.baselineRps,
    maxRps: input.maxRps,
    workdayAccel: input.workdayAccel,
    startSimTime: input.startSimTime,
    timezoneWeights: { byLocation: { ...input.timezoneWeights.byLocation } },
    eventMix: resolveEventMix(input.eventMix),
    chaos: input.chaos,
    ...(input.threatProfile ? { threatProfile: input.threatProfile } : {}),
    targetId: input.targetId,
    durationSec: input.durationSec,
    seed: input.seed,
    createdAt,
    updatedAt,
  };
}

/** Register the `/scenarios` CRUD routes on the `/api` instance. */
export function registerScenarioRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/scenarios', async (request) => {
    const { limit, offset } = parsePagination(request.query as Record<string, unknown>);
    return ctx.stores.scenarios.list(limit, offset);
  });

  app.post('/scenarios', async (request, reply) => {
    const input = scenarioInputSchema.parse(request.body);
    const nowIso = new Date().toISOString();
    const scenario = toScenario(input, nanoid(), nowIso, nowIso);
    const created = ctx.stores.scenarios.create(scenario);
    reply.code(201);
    return created;
  });

  app.get('/scenarios/:id', async (request) => {
    const { id } = request.params as { id: string };
    const scenario = ctx.stores.scenarios.get(id);
    if (!scenario) throw notFound(`Scenario ${id} not found`, 'scenario_not_found');
    return scenario;
  });

  app.put('/scenarios/:id', async (request) => {
    const { id } = request.params as { id: string };
    const input = scenarioInputSchema.parse(request.body);
    // A PUT replaces the mutable fields; optional fields left out clear their prior
    // value. Identity and creation time are preserved by the store's update guard.
    const patch: Partial<ScenarioConfig> = {
      name: input.name,
      description: input.description,
      baselineRps: input.baselineRps,
      maxRps: input.maxRps,
      workdayAccel: input.workdayAccel,
      startSimTime: input.startSimTime,
      timezoneWeights: { byLocation: { ...input.timezoneWeights.byLocation } },
      eventMix: resolveEventMix(input.eventMix),
      chaos: input.chaos,
      // Present-with-undefined clears a prior profile when a PUT omits it (replace semantics).
      threatProfile: input.threatProfile,
      targetId: input.targetId,
      durationSec: input.durationSec,
      seed: input.seed,
    };
    const updated = ctx.stores.scenarios.update(id, patch);
    if (!updated) throw notFound(`Scenario ${id} not found`, 'scenario_not_found');
    return updated;
  });

  app.delete('/scenarios/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const removed = ctx.stores.scenarios.remove(id);
    if (!removed) throw notFound(`Scenario ${id} not found`, 'scenario_not_found');
    reply.code(204);
    return null;
  });
}
