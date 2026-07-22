/**
 * Tunable defaults for the delivery subsystem.
 *
 * WHY these live in one place: several are not expressed on `DeliveryTarget`
 * (the operator configures rate limit, retry, concurrency, queue and overflow,
 * but not the circuit-breaker thresholds, request timeout, dead-letter depth or
 * batch flush cadence). Centralizing the derived defaults keeps the wire
 * behaviour predictable and makes the one place to retune them obvious. Every
 * value here can be overridden per adapter through the internal options so tests
 * stay fast and deterministic.
 */

/** Hard ceiling on a single HTTP request, covering connect + headers + body. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Undici keep-alive connections held open per target origin (bounded reuse). */
export const DEFAULT_HTTP_CONNECTIONS = 64;

/** Consecutive failures that trip the circuit breaker from closed to open. */
export const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 8;

/** How long the breaker stays open before admitting a single half-open probe. */
export const DEFAULT_CIRCUIT_OPEN_MS = 10_000;

/** Concurrent probes admitted while half-open. One keeps the probe unambiguous. */
export const DEFAULT_CIRCUIT_HALF_OPEN_PROBES = 1;

/** Newest-first ring capacity for the dead-letter buffer (bounded memory). */
export const DEFAULT_DEAD_LETTER_CAPACITY = 512;

/** Events per batch when a batch/HR-feed target omits `batchSize`. */
export const DEFAULT_BATCH_SIZE = 500;

/**
 * Max age of the oldest buffered event before a partial batch is flushed, so a
 * low arrival rate never leaves events languishing until the run stops.
 */
export const DEFAULT_MAX_BATCH_AGE_MS = 2_000;

/** Seconds of clock skew shaved off an OAuth token's lifetime before refresh. */
export const OAUTH_EXPIRY_SKEW_SEC = 30;

/** Fallback OAuth token lifetime when the token endpoint omits `expires_in`. */
export const OAUTH_DEFAULT_TTL_SEC = 300;

/** Largest response body (bytes) read back from a target; the rest is drained. */
export const MAX_RESPONSE_BYTES = 64 * 1024;

/** Header carrying the at-least-once idempotency key on every HTTP delivery.
 * Lowercased for consistency with every other framework-set header (and with the
 * lowercased names any HTTP server exposes on inbound requests). */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** CloudEvents-style source identifier stamped on every outbound envelope. */
export const ENVELOPE_SOURCE = 'urn:workday-simulator';

/** Content types per wire format. */
export const CONTENT_TYPE = {
  scim: 'application/scim+json',
  json: 'application/json',
  csv: 'text/csv',
  form: 'application/x-www-form-urlencoded',
} as const;
