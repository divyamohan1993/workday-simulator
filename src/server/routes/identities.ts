/**
 * Identity inspection routes over the seeded workforce.
 *
 * The pool is the single owner of identity state; these routes are read-only windows
 * onto it for the dashboard's org explorer. `all()` returns a snapshot copy, so
 * filtering and pagination here never mutate or race the live pool. The static
 * `/identities/stats` route is registered alongside the parametric `/identities/:id`;
 * Fastify prefers the static match, so "stats" is never captured as an id.
 */

import type { FastifyInstance } from 'fastify';
import type { Employee } from '../../types/index.js';
import type { ServerContext } from '../context.js';
import { notFound } from '../errors.js';
import { firstString, paginateArray, parsePagination } from '../helpers.js';

/** Register the `/identities` inspection routes on the `/api` instance. */
export function registerIdentityRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/identities', async (request) => {
    const query = request.query as Record<string, unknown>;
    const { limit, offset } = parsePagination(query);
    const status = firstString(query['status']);
    const division = firstString(query['division']);
    const type = firstString(query['type']);

    let items: Employee[] = ctx.pool.all();
    if (status) items = items.filter((e) => e.status === status);
    if (division) items = items.filter((e) => e.division === division);
    if (type) items = items.filter((e) => e.type === type);

    return paginateArray(items, limit, offset);
  });

  app.get('/identities/stats', async () => ctx.pool.stats());

  app.get('/identities/:id', async (request) => {
    const { id } = request.params as { id: string };
    const employee = ctx.pool.get(id);
    if (!employee) throw notFound(`Identity ${id} not found`, 'identity_not_found');
    return employee;
  });
}
