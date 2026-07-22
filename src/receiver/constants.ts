/**
 * Tunable defaults for the built-in reference One Identity Manager (OneIM).
 *
 * WHY these live in one place: the receiver models real connector behaviour
 * (Active Directory is fast, SAP and the mainframe are slow, everything fails a
 * little of the time), inbound rate limiting, backpressure and dormancy windows.
 * None of that is expressed on any frozen contract, so centralizing the derived
 * defaults keeps the simulated behaviour predictable and makes the one place to
 * retune it obvious. Every value is overridable through the engine options so
 * tests stay fast and deterministic.
 */

import type { ConnectorProfile } from './types.js';

/** Base path the SCIM 2.0 surface is mounted at (absolute, owned by the plugin). */
export const SCIM_BASE_PATH = '/scim/v2';

/** Base path the non-SCIM ingest surface is mounted at. */
export const INGEST_BASE_PATH = '/ingest';

/**
 * Downstream connectors the identity manager provisions into. Latencies and
 * failure rates are deliberately spread so that the telemetry shows a realistic
 * mix: AD acknowledges in tens of milliseconds, SAP and the mainframe take
 * seconds, and each fails a small, connector-specific fraction of the time. Under
 * load the per-connector queue is what deepens, so the measured provisioning
 * latency rises even though the profile itself is unchanged.
 */
export const DEFAULT_CONNECTOR_PROFILES: readonly ConnectorProfile[] = [
  { name: 'ActiveDirectory', minLatencyMs: 30, maxLatencyMs: 120, failureRate: 0.01, concurrency: 32 },
  { name: 'Exchange', minLatencyMs: 120, maxLatencyMs: 480, failureRate: 0.02, concurrency: 16 },
  { name: 'SAP', minLatencyMs: 500, maxLatencyMs: 2000, failureRate: 0.05, concurrency: 8 },
  { name: 'Mainframe', minLatencyMs: 800, maxLatencyMs: 3000, failureRate: 0.04, concurrency: 4 },
  { name: 'GenericConnector', minLatencyMs: 80, maxLatencyMs: 400, failureRate: 0.02, concurrency: 16 },
];

/** The connector a user account create/disable is provisioned to first. */
export const IDENTITY_PRIMARY_CONNECTOR = 'ActiveDirectory';

/** The connector a user's mailbox is provisioned to alongside the AD account. */
export const IDENTITY_MAILBOX_CONNECTOR = 'Exchange';

/** Fallback connector when a target system cannot be mapped to a known one. */
export const DEFAULT_CONNECTOR = 'GenericConnector';

/**
 * Maps a target system (as it appears on an entitlement) to the connector that
 * provisions it. Systems not listed fall back to {@link DEFAULT_CONNECTOR}. The
 * keys are lowercased for case-insensitive matching.
 */
export const SYSTEM_TO_CONNECTOR: Readonly<Record<string, string>> = {
  activedirectory: 'ActiveDirectory',
  azuread: 'ActiveDirectory',
  exchange: 'Exchange',
  sap: 'SAP',
  'swift-alliance': 'Mainframe',
  gpp: 'Mainframe',
  murex: 'Mainframe',
  avaloq: 'Mainframe',
  aladdin: 'Mainframe',
};

/** How often the production pump advances the connector queues, in ms. */
export const PUMP_INTERVAL_MS = 25;

/** How often orphan/dormant detection runs off the pump, in wall ms. */
export const DEFAULT_DETECTION_INTERVAL_MS = 1_000;

/**
 * Simulated-time window after which an untouched, still-enabled account is judged
 * dormant. Ninety days is the common recertification-driven dormancy threshold;
 * because dormancy is measured in SIMULATED time it actually trips inside an
 * accelerated run rather than never (a wall-clock threshold would not).
 */
export const DEFAULT_DORMANT_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1_000;

/**
 * Default per-source-IP inbound rate limit (requests/second) before 429.
 *
 * WHY it is far above MAX_RPS (2000): the built-in delivery is a SINGLE source. It
 * POSTs to the receiver over undici from the server process, so every request
 * shares one loopback address and one token bucket. A per-source cap at or below
 * the simulator's throughput would 429 the bulk of legitimate built-in traffic and
 * read as broken. Genuine overload is shed by the volume-scaled backpressure
 * high-water, not this per-source guard, which exists to stop a single pathological
 * source running orders of magnitude above any real scenario. Tighten it via engine
 * options for an external multi-source deployment where per-source fairness matters.
 */
export const DEFAULT_RATE_LIMIT_RPS = 100_000;

/** Default token-bucket burst capacity for the inbound rate limit. */
export const DEFAULT_RATE_LIMIT_BURST = 200_000;

/** Max distinct source buckets tracked before the least-recent are evicted. */
export const DEFAULT_RATE_LIMIT_MAX_KEYS = 20_000;

/**
 * Total queued work (connector queues plus pending approvals) at which the
 * receiver sheds new inbound requests with 429, modelling an overwhelmed identity
 * manager. Matched to the delivery target's default queue high-water so the two
 * sides reach saturation at a comparable scale.
 */
export const DEFAULT_BACKPRESSURE_HIGH_WATER = 10_000;

/** Retry-After seconds returned on a backpressure-driven 429 shed. */
export const DEFAULT_SHED_RETRY_AFTER_SEC = 2;

/** Wall-time an approval sits pending before it is auto-decided, in ms. */
export const DEFAULT_APPROVAL_DELAY_MS = 2_000;

/** Fraction of pending approvals that are approved rather than denied. */
export const DEFAULT_APPROVAL_APPROVE_RATE = 0.9;

/** Max at-least-once idempotency keys remembered for dedup (bounded memory). */
export const DEFAULT_SEEN_KEY_CAPACITY = 100_000;

/** Max SoD/orphan/dormant findings retained for inspection (bounded memory). */
export const DEFAULT_FINDINGS_RING = 256;

/** Max SCIM Bulk operations accepted in one request (RFC 7644 maxOperations). */
export const MAX_BULK_OPERATIONS = 1_000;

/** Max SCIM Bulk payload size advertised, in bytes. */
export const MAX_BULK_PAYLOAD_BYTES = 1_048_576;

/** Default page size for SCIM list responses when the client omits `count`. */
export const DEFAULT_LIST_PAGE_SIZE = 100;

/** Hard ceiling on a SCIM list page, regardless of the requested `count`. */
export const MAX_LIST_PAGE_SIZE = 200;

/** Lowercased HTTP header carrying the at-least-once idempotency key. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * Candidate lowercased headers a webhook HMAC signature may arrive in. The
 * built-in webhook target should be configured to write to the first of these
 * (`x-signature`); the rest are accepted so common real-world signers verify too.
 */
export const HMAC_SIGNATURE_HEADERS: readonly string[] = [
  'x-signature',
  'x-webhook-signature',
  'x-hub-signature-256',
  'x-hub-signature',
];

/** SCIM content type per RFC 7644. */
export const SCIM_CONTENT_TYPE = 'application/scim+json';
