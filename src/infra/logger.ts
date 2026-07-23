/**
 * Structured logging factory (pino) and correlation-id helpers.
 *
 * WHY explicit redaction paths rather than a catch-all: pino's redaction (via
 * fast-redact) is path-based and a wildcard `*` matches exactly one level, so
 * `*.token` catches `auth.token` but not `target.auth.token`. The secrets in this
 * system have known shapes, the `DeliveryAuthConfig` union (`token`, `password`,
 * `clientSecret`, `secret`) and HTTP `authorization` headers, so we enumerate the
 * realistic nestings. Never log a secret or PII in the clear: everything below is
 * replaced with a fixed censor string before the record is serialized.
 */

import { nanoid } from 'nanoid';
import pino from 'pino';
import type { DestinationStream, Logger, LoggerOptions } from 'pino';

/** The value substituted for any redacted field. Matches the API response contract. */
export const REDACT_CENSOR = '***REDACTED***';

/** The property key used to carry a request correlation id on child loggers. */
export const CORRELATION_KEY = 'correlationId';

/**
 * Field paths scrubbed from every log record. Each path has at most one `*`
 * (fast-redact's single-wildcard rule) and none is a parent of another (so
 * fast-redact never rejects the set). Covers top-level secrets, one-level-nested
 * secrets (for example `{ auth: { token } }`), the `DeliveryTarget` shape
 * (`{ target: { auth: { token } } }`), and Authorization headers on request/response
 * objects.
 */
export const REDACT_PATHS: string[] = [
  'token',
  'password',
  'clientSecret',
  'secret',
  'apiKey',
  'authorization',
  'ADMIN_TOKEN',
  'RECEIVER_TOKEN',
  '*.token',
  '*.password',
  '*.clientSecret',
  '*.secret',
  '*.apiKey',
  '*.authorization',
  '*.auth.token',
  '*.auth.password',
  '*.auth.clientSecret',
  '*.auth.secret',
  'headers.authorization',
  'req.headers.authorization',
  'res.headers.authorization',
  'request.headers.authorization',
  'response.headers.authorization',
];

/** Options for the logger factory. */
export interface LoggerFactoryOptions {
  /** Minimum level to emit; one of pino's levels (from config `LOG_LEVEL`). */
  level: string;
  /** Optional logger name, attached to every record. */
  name?: string;
  /**
   * Human-friendly colorized output via pino-pretty. Intended for local development
   * only; ignored when a `destination` stream is supplied (pretty uses a transport
   * worker that cannot also target an in-process stream).
   */
  pretty?: boolean;
  /**
   * Base fields merged into every record. Pass `null` to strip pino's default
   * `pid`/`hostname`; omit to keep them.
   */
  base?: Record<string, unknown> | null;
}

/**
 * Build the application logger.
 *
 * @param options Level, optional name, pretty flag, and base fields.
 * @param destination Optional destination stream (used by tests to capture output).
 * @returns A configured pino `Logger` with secret redaction always enabled.
 */
export function createLogger(
  options: LoggerFactoryOptions,
  destination?: DestinationStream,
): Logger {
  const loggerOptions: LoggerOptions = {
    level: options.level,
    redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Strip the query string from every logged request URL. The telemetry WebSocket
    // authenticates via `/ws/telemetry?token=<ADMIN_TOKEN>` (browsers cannot set
    // WS headers), and Fastify's automatic request logging would otherwise write the
    // cleartext master token into stdout logs on every connect. Path-based redaction
    // cannot scrub a substring of a field, so we sanitize the URL in the serializer
    // instead, keeping the method + path for debugging while dropping any secret query.
    serializers: {
      req: pino.stdSerializers.wrapRequestSerializer((serialized) => {
        const r = serialized as { url?: unknown; query?: unknown };
        if (typeof r.url === 'string') {
          const q = r.url.indexOf('?');
          if (q !== -1) r.url = r.url.slice(0, q);
        }
        // pino-std-serializers also emits a PARSED `query` object, so a secret passed as a
        // query parameter (the WS `?token=`) survives URL stripping there. Drop the field
        // entirely: the sanitized path is enough for debugging and no query value is logged.
        if ('query' in r) delete r.query;
        return serialized;
      }),
    },
  };
  if (options.name !== undefined) loggerOptions.name = options.name;
  if (options.base !== undefined) loggerOptions.base = options.base;

  if (options.pretty && destination === undefined) {
    loggerOptions.transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
    };
  }

  return destination === undefined ? pino(loggerOptions) : pino(loggerOptions, destination);
}

/**
 * Generate a fresh correlation id (URL-safe, collision-resistant). Attach it to the
 * first log of a request and propagate it across service boundaries so a single
 * request's records can be stitched together.
 */
export function correlationId(): string {
  return nanoid();
}

/**
 * Derive a child logger that stamps every record with a correlation id.
 *
 * @param logger Parent logger.
 * @param id Correlation id to use; a fresh one is generated when omitted.
 * @returns A child logger carrying `{ correlationId }`.
 */
export function withCorrelationId(logger: Logger, id: string = correlationId()): Logger {
  return logger.child({ [CORRELATION_KEY]: id });
}
