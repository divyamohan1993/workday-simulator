/**
 * Uniform error handling for the control plane.
 *
 * WHY a single error shape and one handler: BUILD-CONTRACT section 5 freezes the
 * error body as `{ error, code, requestId, details? }` on every non-2xx response.
 * Centralizing construction here guarantees every route, the validation layer, the
 * not-found handler and the catch-all render exactly that shape, with `requestId`
 * always set to the request's correlation id so a failure can be traced end to end.
 *
 * Secrets never reach an error body: messages are hand-written or drawn from
 * validation issues (field paths and codes), never from raw config or a target's
 * auth. The catch-all deliberately hides the message of an unexpected error behind a
 * generic string so an internal exception can never leak stack or secret material to
 * a caller; the real error is logged server-side with the correlation id.
 */

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { ApiError } from '../types/index.js';

/**
 * An error carrying the HTTP status and stable machine code to render. Throw this
 * from a handler (or a helper) and the error handler turns it into the uniform body.
 */
export class AppHttpError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppHttpError';
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** 400 Bad Request with a stable code. */
export const badRequest = (message: string, code = 'bad_request', details?: unknown): AppHttpError =>
  new AppHttpError(400, code, message, details);

/** 401 Unauthorized. */
export const unauthorized = (message = 'Authentication required', code = 'unauthorized'): AppHttpError =>
  new AppHttpError(401, code, message);

/** 404 Not Found with a stable code. */
export const notFound = (message = 'Resource not found', code = 'not_found'): AppHttpError =>
  new AppHttpError(404, code, message);

/** 409 Conflict with a stable code. */
export const conflict = (message: string, code = 'conflict'): AppHttpError =>
  new AppHttpError(409, code, message);

/** Build the frozen API error body for a request. */
export function apiError(requestId: string, message: string, code: string, details?: unknown): ApiError {
  return details === undefined
    ? { error: message, code, requestId }
    : { error: message, code, requestId, details };
}

/** Send a uniform error response. Returns the reply for `return sendError(...)` use. */
export function sendError(
  reply: FastifyReply,
  request: FastifyRequest,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
): FastifyReply {
  return reply.code(statusCode).send(apiError(request.id, message, code, details));
}

/** Flatten a ZodError into a compact, secret-free details array for the body. */
function zodDetails(error: ZodError): Array<{ path: string; message: string; code: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * Install the Fastify error handler. Maps known error shapes onto the uniform body
 * and hides unexpected errors behind a generic 500 while logging the real cause. The
 * not-found handler is set separately (build-server.ts) because it depends on whether
 * a web build is being served (SPA fallback) or not (JSON 404).
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | AppHttpError | ZodError, request, reply) => {
    if (error instanceof AppHttpError) {
      return sendError(reply, request, error.statusCode, error.code, error.message, error.details);
    }

    if (error instanceof ZodError) {
      return sendError(reply, request, 400, 'validation_error', 'Request body failed validation', zodDetails(error));
    }

    // Fastify's own validation errors (from schema) and body-parse errors carry a
    // statusCode; surface 4xx as-is with a safe message, treat everything else as 500.
    const fastifyErr = error as FastifyError;
    const status = typeof fastifyErr.statusCode === 'number' ? fastifyErr.statusCode : 500;
    if (status >= 400 && status < 500) {
      const code = fastifyErr.code ? String(fastifyErr.code).toLowerCase() : 'bad_request';
      return sendError(reply, request, status, code, fastifyErr.message || 'Bad request');
    }

    request.log.error({ err: error }, 'unhandled request error');
    return sendError(reply, request, 500, 'internal_error', 'Internal server error');
  });
}
