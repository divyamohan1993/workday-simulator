/**
 * Delivery-target CRUD plus a connectivity test.
 *
 * Two invariants this module enforces at the edge:
 * - Secret redaction: every response that echoes a target passes through
 *   `redactTarget`, so `auth.token`/`password`/`clientSecret`/`secret` are masked. The
 *   store keeps them in plaintext (the adapter needs them to authenticate); the mask
 *   is applied here, once, at the boundary.
 * - Built-in protection: the bundled receiver target cannot be deleted (409). The
 *   store also refuses structurally; this route reports the distinction (404 vs 409)
 *   so the dashboard can explain why.
 */

import { nanoid } from 'nanoid';
import type { FastifyInstance } from 'fastify';
import type { DeliveryTargetInput } from '../../contracts/validation.js';
import { deliveryTargetInputSchema } from '../../contracts/validation.js';
import type { DeliveryTarget } from '../../types/index.js';
import type { ServerContext } from '../context.js';
import { conflict, notFound } from '../errors.js';
import { parsePagination, redactTarget, redactTargetPage } from '../helpers.js';
import { probeTarget } from '../probe.js';

/** Build a full `DeliveryTarget` from validated input plus server-assigned fields. */
function toTarget(input: DeliveryTargetInput, id: string, createdAt: string, updatedAt: string): DeliveryTarget {
  return {
    id,
    name: input.name,
    kind: input.kind,
    url: input.url,
    auth: input.auth,
    headers: input.headers,
    rateLimit: input.rateLimit,
    concurrency: input.concurrency,
    retry: input.retry,
    queueHighWater: input.queueHighWater,
    overflowPolicy: input.overflowPolicy,
    batchSize: input.batchSize,
    natsSubject: input.natsSubject,
    builtIn: false,
    createdAt,
    updatedAt,
  };
}

/** Register the `/targets` CRUD and `/targets/:id/test` routes on the `/api` instance. */
export function registerTargetRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/targets', async (request) => {
    const { limit, offset } = parsePagination(request.query as Record<string, unknown>);
    return redactTargetPage(ctx.stores.targets.list(limit, offset));
  });

  app.post('/targets', async (request, reply) => {
    const input = deliveryTargetInputSchema.parse(request.body);
    const nowIso = new Date().toISOString();
    const target = toTarget(input, nanoid(), nowIso, nowIso);
    const created = ctx.stores.targets.create(target);
    reply.code(201);
    return redactTarget(created);
  });

  app.get('/targets/:id', async (request) => {
    const { id } = request.params as { id: string };
    const target = ctx.stores.targets.get(id);
    if (!target) throw notFound(`Target ${id} not found`, 'target_not_found');
    return redactTarget(target);
  });

  app.put('/targets/:id', async (request) => {
    const { id } = request.params as { id: string };
    const input = deliveryTargetInputSchema.parse(request.body);
    const patch: Partial<DeliveryTarget> = {
      name: input.name,
      kind: input.kind,
      url: input.url,
      auth: input.auth,
      headers: input.headers,
      rateLimit: input.rateLimit,
      concurrency: input.concurrency,
      retry: input.retry,
      queueHighWater: input.queueHighWater,
      overflowPolicy: input.overflowPolicy,
      batchSize: input.batchSize,
      natsSubject: input.natsSubject,
    };
    const updated = ctx.stores.targets.update(id, patch);
    if (!updated) throw notFound(`Target ${id} not found`, 'target_not_found');
    return redactTarget(updated);
  });

  app.delete('/targets/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = ctx.stores.targets.get(id);
    if (!existing) throw notFound(`Target ${id} not found`, 'target_not_found');
    if (existing.builtIn) throw conflict('The built-in receiver target cannot be deleted', 'target_protected');
    const removed = ctx.stores.targets.remove(id);
    if (!removed) throw notFound(`Target ${id} not found`, 'target_not_found');
    reply.code(204);
    return null;
  });

  app.post('/targets/:id/test', async (request) => {
    const { id } = request.params as { id: string };
    const target = ctx.stores.targets.get(id);
    if (!target) throw notFound(`Target ${id} not found`, 'target_not_found');
    return probeTarget(target, { natsConnected: ctx.natsConnected });
  });
}
