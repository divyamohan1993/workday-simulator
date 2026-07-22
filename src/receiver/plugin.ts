/**
 * The Fastify plugin exposing the receiver's inbound APIs.
 *
 * WHY it owns absolute paths and its own hooks: the server mounts this plugin ONCE
 * at root with no prefix, and Fastify encapsulation keeps the content-type parsers,
 * auth/admission hooks and raw-body capture scoped to the SCIM and ingest subtree,
 * so they never touch the server's own `/api` routes. Requests are authenticated
 * against the receiver token (bearer), with an either/or HMAC path on the webhook
 * route so an HMAC-configured target verifies over the raw body. Inbound load is
 * shed with 429 + Retry-After before any provisioning work when the per-source rate
 * limit trips or the identity manager is saturated (backpressure).
 *
 * Error bodies match the surface: SCIM routes return RFC 7644 error objects, the
 * ingest routes return the uniform `{ error, code, requestId }` API error.
 */

import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { ApiError } from '../types/index.js';
import { SCIM_SCHEMA } from '../domain/scim.js';
import {
  DEFAULT_LIST_PAGE_SIZE,
  INGEST_BASE_PATH,
  MAX_BULK_OPERATIONS,
  MAX_LIST_PAGE_SIZE,
  SCIM_BASE_PATH,
  SCIM_CONTENT_TYPE,
} from './constants.js';
import type { ReceiverEngine } from './engine.js';
import { verifyWebhookSignature } from './hmac.js';
import { parseHrCsv, parseRestBatch, parseWebhookEnvelope } from './ingest.js';
import { compileUserFilter } from './scim-filter.js';
import {
  resourceTypes,
  ScimError,
  scimErrorBody,
  scimListResponse,
  schemas,
  serviceProviderConfig,
} from './scim-resources.js';

/** Per-route policy stored in the Fastify route `config`. */
interface RouteConfig {
  /** Apply rate-limit + backpressure admission (mutating and ingest routes). */
  admission?: boolean;
  /** Allow bearer-or-HMAC auth (the webhook route only). */
  webhook?: boolean;
  /** Which error-body shape to render on rejection. */
  surface: 'scim' | 'ingest';
}

/** A request decorated with the captured raw body (webhook HMAC). */
type RequestWithRaw = FastifyRequest & { rawBody?: string };

/** The webhook route's absolute path, used to gate raw-body capture and auth. */
const WEBHOOK_PATH = `${INGEST_BASE_PATH}/webhook`;

/** Options for {@link createReceiverPlugin}. */
export interface ReceiverPluginOptions {
  engine: ReceiverEngine;
  /** Bearer token (and HMAC secret) the receiver requires on its endpoints. */
  token: string;
  logger: Logger;
}

/** Constant-time string equality guarding the bearer token comparison. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Extract a bearer token from the Authorization header, if present. */
function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : undefined;
}

/** Route config accessor with a safe default surface. */
function routeConfig(request: FastifyRequest): RouteConfig {
  const cfg = request.routeOptions.config as Partial<RouteConfig> | undefined;
  return { surface: cfg?.surface ?? 'ingest', admission: cfg?.admission, webhook: cfg?.webhook };
}

/**
 * Build the receiver's Fastify plugin.
 *
 * @param options Engine, receiver token and logger.
 * @returns A FastifyPluginAsync registering the SCIM and ingest routes at root.
 */
export function createReceiverPlugin(options: ReceiverPluginOptions): FastifyPluginAsync {
  const { engine, token, logger } = options;

  /** Reject a request with the surface-appropriate error body and status. */
  const deny = (
    request: FastifyRequest,
    reply: FastifyReply,
    surface: 'scim' | 'ingest',
    status: number,
    detail: string,
    code: string,
    scimType?: string,
    retryAfterSec?: number,
  ): FastifyReply => {
    if (retryAfterSec !== undefined) reply.header('retry-after', String(retryAfterSec));
    if (status === 401) reply.header('www-authenticate', 'Bearer');
    if (surface === 'scim') {
      reply.header('content-type', SCIM_CONTENT_TYPE);
      return reply.code(status).send(scimErrorBody(status, detail, scimType));
    }
    const body: ApiError = { error: detail, code, requestId: request.id };
    return reply.code(status).send(body);
  };

  /** Render a caught error as a SCIM error body, defaulting unknowns to 500. */
  const sendScimError = (reply: FastifyReply, error: unknown): unknown => {
    if (error instanceof ScimError) {
      reply.code(error.status).header('content-type', SCIM_CONTENT_TYPE);
      return scimErrorBody(error.status, error.message, error.scimType);
    }
    logger.error({ err: error }, 'unhandled SCIM handler error');
    reply.code(500).header('content-type', SCIM_CONTENT_TYPE);
    return scimErrorBody(500, 'Internal server error');
  };

  return async (fastify): Promise<void> => {
    // Parse SCIM's content type and the HR-feed CSV; application/json (webhook and
    // REST ingest) uses Fastify's default parser. These are scoped to this plugin.
    fastify.addContentTypeParser('application/scim+json', { parseAs: 'string' }, (_req, body, done) => {
      const text = typeof body === 'string' ? body : body.toString('utf8');
      try {
        done(null, text.length > 0 ? JSON.parse(text) : {});
      } catch (error) {
        const err = error as Error & { statusCode?: number };
        err.statusCode = 400;
        done(err, undefined);
      }
    });
    const csvParser = (_req: FastifyRequest, body: string | Buffer, done: (err: Error | null, value?: unknown) => void): void =>
      done(null, typeof body === 'string' ? body : body.toString('utf8'));
    fastify.addContentTypeParser('text/csv', { parseAs: 'string' }, csvParser);
    fastify.addContentTypeParser('application/csv', { parseAs: 'string' }, csvParser);

    if (!fastify.hasRequestDecorator('rawBody')) {
      fastify.decorateRequest('rawBody', '');
    }

    // Capture the untouched body bytes for the webhook route so HMAC verifies over
    // exactly what was received, then replay them to the normal parser.
    fastify.addHook('preParsing', (request, _reply, payload, done) => {
      if (request.routeOptions.url !== WEBHOOK_PATH) {
        done(null, payload);
        return;
      }
      const chunks: Buffer[] = [];
      payload.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      payload.on('end', () => {
        const raw = Buffer.concat(chunks);
        (request as RequestWithRaw).rawBody = raw.toString('utf8');
        const replay = new Readable({ read() {} });
        replay.push(raw);
        replay.push(null);
        done(null, replay);
      });
      payload.on('error', (error: Error) => done(error));
    });

    // Admission (429) and, for every route but the webhook, bearer auth. The
    // webhook defers to preHandler so its either/or HMAC can see the raw body.
    fastify.addHook('onRequest', async (request, reply) => {
      const cfg = routeConfig(request);
      if (cfg.admission) {
        const decision = engine.admit(request.ip);
        if (!decision.admitted) {
          logger.warn({ ip: request.ip, reason: decision.reason }, 'receiver shed inbound request');
          return deny(request, reply, cfg.surface, 429, 'Too Many Requests', 'tooManyRequests', undefined, decision.retryAfterSec);
        }
      }
      if (!cfg.webhook && !safeBearer(request)) {
        return deny(request, reply, cfg.surface, 401, 'Unauthorized', 'unauthorized');
      }
      return undefined;
    });

    // Webhook auth: valid bearer OR a valid HMAC over the raw body.
    fastify.addHook('preHandler', async (request, reply) => {
      const cfg = routeConfig(request);
      if (!cfg.webhook) return undefined;
      if (safeBearer(request)) return undefined;
      const raw = (request as RequestWithRaw).rawBody ?? '';
      if (verifyWebhookSignature(raw, request.headers, token)) return undefined;
      return deny(request, reply, cfg.surface, 401, 'Unauthorized', 'unauthorized');
    });

    /** True when the request carries a valid bearer receiver token. */
    function safeBearer(request: FastifyRequest): boolean {
      const provided = bearerToken(request);
      return provided !== undefined && safeEqual(provided, token);
    }

    /* --- SCIM Users -------------------------------------------------------- */

    const scimCfg = (admission: boolean): { config: RouteConfig } => ({
      config: { surface: 'scim', admission },
    });

    fastify.post(`${SCIM_BASE_PATH}/Users`, scimCfg(true), async (request, reply) => {
      try {
        const key = idempotencyKey(request);
        const { resource, created, etag } = engine.scimCreateUser(request.body, key);
        reply.code(created ? 201 : 200).header('content-type', SCIM_CONTENT_TYPE);
        reply.header('location', resource.meta.location);
        if (etag) reply.header('etag', etag);
        return resource;
      } catch (error) {
        return sendScimError(reply, error);
      }
    });

    fastify.get(`${SCIM_BASE_PATH}/Users/:id`, scimCfg(false), async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const user = engine.scimGetUser(id);
        reply.header('content-type', SCIM_CONTENT_TYPE);
        const etag = engine.store.userEtag(id);
        if (etag) reply.header('etag', etag);
        return user;
      } catch (error) {
        return sendScimError(reply, error);
      }
    });

    fastify.get(`${SCIM_BASE_PATH}/Users`, scimCfg(false), async (request, reply) => {
      try {
        const query = request.query as { filter?: string; startIndex?: string; count?: string };
        const predicate = compileUserFilter(query.filter);
        const startIndex = parsePositiveInt(query.startIndex, 1);
        const count = Math.min(parsePositiveInt(query.count, DEFAULT_LIST_PAGE_SIZE), MAX_LIST_PAGE_SIZE);
        const { resources, total } = engine.scimListUsers(predicate, startIndex, count);
        reply.header('content-type', SCIM_CONTENT_TYPE);
        return scimListResponse(resources, total, startIndex);
      } catch (error) {
        return sendScimError(reply, error);
      }
    });

    fastify.put(`${SCIM_BASE_PATH}/Users/:id`, scimCfg(true), async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const { user, etag } = engine.scimReplaceUser(id, request.body, idempotencyKey(request));
        reply.header('content-type', SCIM_CONTENT_TYPE);
        if (etag) reply.header('etag', etag);
        return user;
      } catch (error) {
        return sendScimError(reply, error);
      }
    });

    fastify.patch(`${SCIM_BASE_PATH}/Users/:id`, scimCfg(true), async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const { user, etag } = engine.scimPatchUser(id, request.body, idempotencyKey(request));
        reply.header('content-type', SCIM_CONTENT_TYPE);
        if (etag) reply.header('etag', etag);
        return user;
      } catch (error) {
        return sendScimError(reply, error);
      }
    });

    fastify.delete(`${SCIM_BASE_PATH}/Users/:id`, scimCfg(true), async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        engine.scimDeleteUser(id, idempotencyKey(request));
        return reply.code(204).send();
      } catch (error) {
        reply.header('content-type', SCIM_CONTENT_TYPE);
        return sendScimError(reply, error);
      }
    });

    /* --- SCIM Groups ------------------------------------------------------- */

    fastify.post(`${SCIM_BASE_PATH}/Groups`, scimCfg(true), async (request, reply) => {
      try {
        const { resource, created } = engine.scimCreateGroup(request.body, idempotencyKey(request));
        reply.code(created ? 201 : 200).header('content-type', SCIM_CONTENT_TYPE);
        reply.header('location', resource.meta.location);
        return resource;
      } catch (error) {
        return sendScimError(reply, error);
      }
    });

    fastify.get(`${SCIM_BASE_PATH}/Groups/:id`, scimCfg(false), async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        reply.header('content-type', SCIM_CONTENT_TYPE);
        return engine.scimGetGroup(id);
      } catch (error) {
        return sendScimError(reply, error);
      }
    });

    fastify.patch(`${SCIM_BASE_PATH}/Groups/:id`, scimCfg(true), async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const { group } = engine.scimPatchGroup(id, request.body, idempotencyKey(request));
        reply.header('content-type', SCIM_CONTENT_TYPE);
        return group;
      } catch (error) {
        return sendScimError(reply, error);
      }
    });

    /* --- SCIM Bulk --------------------------------------------------------- */

    fastify.post(`${SCIM_BASE_PATH}/Bulk`, scimCfg(true), async (request, reply) => {
      try {
        reply.header('content-type', SCIM_CONTENT_TYPE);
        return handleBulk(request.body);
      } catch (error) {
        return sendScimError(reply, error);
      }
    });

    /* --- SCIM discovery (auth required, no admission) ---------------------- */

    fastify.get(`${SCIM_BASE_PATH}/ServiceProviderConfig`, scimCfg(false), async (_request, reply) => {
      reply.header('content-type', SCIM_CONTENT_TYPE);
      return serviceProviderConfig();
    });

    fastify.get(`${SCIM_BASE_PATH}/ResourceTypes`, scimCfg(false), async (_request, reply) => {
      reply.header('content-type', SCIM_CONTENT_TYPE);
      const types = resourceTypes();
      return scimListResponse(types, types.length, 1);
    });

    fastify.get(`${SCIM_BASE_PATH}/Schemas`, scimCfg(false), async (_request, reply) => {
      reply.header('content-type', SCIM_CONTENT_TYPE);
      const docs = schemas();
      return scimListResponse(docs, docs.length, 1);
    });

    /* --- Ingest ------------------------------------------------------------ */

    fastify.post(WEBHOOK_PATH, { config: { surface: 'ingest', admission: true, webhook: true } }, async (request, reply) => {
      const event = parseWebhookEnvelope(request.body);
      if (!event) {
        return deny(request, reply, 'ingest', 400, 'Webhook body did not contain an event', 'invalid_body');
      }
      engine.ingestEvent(event);
      return reply.code(202).send({ accepted: 1 });
    });

    fastify.post(`${INGEST_BASE_PATH}/events`, { config: { surface: 'ingest', admission: true } }, async (request, reply) => {
      const events = parseRestBatch(request.body);
      for (const event of events) engine.ingestEvent(event);
      return reply.code(202).send({ accepted: events.length });
    });

    fastify.post(`${INGEST_BASE_PATH}/hr-batch`, { config: { surface: 'ingest', admission: true } }, async (request, reply) => {
      const body = typeof request.body === 'string' ? request.body : '';
      const rows = parseHrCsv(body);
      for (const row of rows) engine.ingestHrRow(row);
      return reply.code(202).send({ accepted: rows.length });
    });

    /* --- Bulk dispatch helper --------------------------------------------- */

    /** Process a SCIM BulkRequest, dispatching each op to the matching handler. */
    function handleBulk(body: unknown): unknown {
      if (typeof body !== 'object' || body === null) {
        throw new ScimError(400, 'Bulk body must be an object', 'invalidSyntax');
      }
      const ops = (body as { Operations?: unknown }).Operations;
      if (!Array.isArray(ops)) {
        throw new ScimError(400, 'Bulk requires an Operations array', 'invalidSyntax');
      }
      if (ops.length > MAX_BULK_OPERATIONS) {
        throw new ScimError(413, `Bulk exceeds maxOperations (${MAX_BULK_OPERATIONS})`, 'tooLarge');
      }
      const responses = ops.map((raw) => dispatchBulkOp(raw));
      return { schemas: [SCIM_SCHEMA.BULK_RESPONSE], Operations: responses };
    }

    /** Dispatch one bulk operation, capturing its per-op status and any error. */
    function dispatchBulkOp(raw: unknown): Record<string, unknown> {
      const op = (raw ?? {}) as { method?: unknown; path?: unknown; bulkId?: unknown; data?: unknown };
      const method = String(op.method ?? '').toUpperCase();
      const path = String(op.path ?? '');
      const bulkId = String(op.bulkId ?? '');
      const segments = path.replace(/^\/+/, '').split('/');
      const resource = segments[0] ?? '';
      const id = segments[1] ?? '';
      try {
        if (method === 'POST' && resource === 'Users') {
          const { resource: user } = engine.scimCreateUser(op.data, bulkId);
          return { method, bulkId, location: user.meta.location, status: '201' };
        }
        if (method === 'POST' && resource === 'Groups') {
          const { resource: group } = engine.scimCreateGroup(op.data, bulkId);
          return { method, bulkId, location: group.meta.location, status: '201' };
        }
        if (method === 'PUT' && resource === 'Users' && id) {
          const { user } = engine.scimReplaceUser(id, op.data, bulkId);
          return { method, bulkId, location: user.meta.location, status: '200' };
        }
        if (method === 'PATCH' && resource === 'Users' && id) {
          const { user } = engine.scimPatchUser(id, op.data, bulkId);
          return { method, bulkId, location: user.meta.location, status: '200' };
        }
        if (method === 'PATCH' && resource === 'Groups' && id) {
          engine.scimPatchGroup(id, op.data, bulkId);
          return { method, bulkId, status: '200' };
        }
        if (method === 'DELETE' && resource === 'Users' && id) {
          engine.scimDeleteUser(id, bulkId);
          return { method, bulkId, status: '204' };
        }
        return {
          method,
          bulkId,
          status: '400',
          response: scimErrorBody(400, `Unsupported bulk operation: ${method} ${path}`, 'invalidValue'),
        };
      } catch (error) {
        if (error instanceof ScimError) {
          return { method, bulkId, status: String(error.status), response: scimErrorBody(error.status, error.message, error.scimType) };
        }
        logger.error({ err: error, bulkId }, 'bulk operation failed');
        return { method, bulkId, status: '500', response: scimErrorBody(500, 'Internal server error') };
      }
    }
  };
}

/** Read the idempotency key header, or empty string when absent. */
function idempotencyKey(request: FastifyRequest): string {
  const raw = request.headers['idempotency-key'];
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
}

/** Parse a positive integer query param, falling back to a default. */
function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
