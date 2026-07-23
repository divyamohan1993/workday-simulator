/**
 * Bootstrap of the two things that make the simulator demonstrable the instant it
 * boots, with no external system and no manual setup:
 *
 * 1. The built-in delivery target. It points the event stream back at THIS process,
 *    where the reference receiver plugin is mounted, so a run provisions against a
 *    real (loopback) OneIM. The target's url is the loopback base appropriate for the
 *    configured delivery kind, because each sender joins paths differently: the SCIM
 *    sender appends `/Users` to its base (so the base must be `/scim/v2`), while the
 *    webhook/rest/batch senders POST to the url verbatim (so the url is the full
 *    ingest path). It is flagged `builtIn` so the store refuses to delete it.
 *
 * 2. A default scenario. Seeded only when the scenario store is empty, so a fresh
 *    deploy has something to run immediately, while a restart never duplicates it.
 *    It adopts the events module's recommended per-kind mix so the very first run
 *    already looks like a real bank day rather than a uniform kind soup.
 *
 * Loopback uses 127.0.0.1 regardless of HOST: binding to 0.0.0.0 is not a valid
 * connect address on every platform, and the receiver is always reachable on the
 * loopback interface of the process that mounts it.
 */

import { DEFAULT_EVENT_MIX } from '../events/index.js';
import type { AppConfig } from '../config/schema.js';
import type { Logger } from 'pino';
import type {
  DeliveryKind,
  DeliveryTarget,
  ScenarioConfig,
  TimezoneWeights,
} from '../types/index.js';
import type { StoresBundle } from '../contracts/factories.js';

/** Stable id of the built-in receiver target (referenced by the default scenario). */
export const BUILTIN_TARGET_ID = 'builtin-receiver';

/** Stable id of the seeded default scenario. */
export const DEFAULT_SCENARIO_ID = 'default-bank-day';

/** Default NATS subject the built-in target publishes to when kind is `nats`. */
export const DEFAULT_NATS_SUBJECT = 'workday.events';

/**
 * The loopback url the built-in target delivers to, chosen per kind so it lands on
 * the matching receiver route once each sender applies its own path convention.
 */
export function builtInTargetUrl(kind: DeliveryKind, port: number, natsUrl: string | undefined): string {
  const base = `http://127.0.0.1:${port}`;
  switch (kind) {
    case 'scim':
      return `${base}/scim/v2`;
    case 'webhook':
      return `${base}/ingest/webhook`;
    case 'rest':
      return `${base}/ingest/events`;
    case 'batch':
      return `${base}/ingest/hr-batch`;
    case 'nats':
      return natsUrl ?? 'nats://127.0.0.1:4222';
    default:
      return `${base}/ingest/events`;
  }
}

/** Build the built-in target record from current config (not schema-validated: we own it). */
export function buildBuiltInTarget(config: AppConfig, receiverToken: string, nowIso: string): DeliveryTarget {
  const kind = config.DEFAULT_TARGET_KIND;
  const target: DeliveryTarget = {
    id: BUILTIN_TARGET_ID,
    name: 'Built-in OneIM Receiver',
    kind,
    url: builtInTargetUrl(kind, config.PORT, config.NATS_URL),
    auth: { kind: 'bearer', token: receiverToken },
    headers: {},
    rateLimit: { rps: 0, burst: 0 },
    concurrency: 32,
    retry: {
      maxRetries: 4,
      baseDelayMs: 200,
      maxDelayMs: 15_000,
      jitter: true,
      retryableStatuses: [408, 429, 500, 502, 503, 504],
    },
    queueHighWater: 10_000,
    overflowPolicy: 'drop_oldest',
    builtIn: true,
    createdAt: nowIso,
    updatedAt: nowIso,
    ...(kind === 'batch' ? { batchSize: 200 } : {}),
    ...(kind === 'nats' ? { natsSubject: DEFAULT_NATS_SUBJECT } : {}),
  };
  return target;
}

/**
 * Ensure the built-in target exists and reflects the current port/kind/token. On a
 * restart the stored row is refreshed (url and auth may have changed with config)
 * while its id and `builtIn` flag are preserved by the store's update guard.
 *
 * @returns The built-in target's id.
 */
export function ensureBuiltInTarget(
  stores: StoresBundle,
  config: AppConfig,
  receiverToken: string,
  logger: Logger,
): string {
  const nowIso = new Date().toISOString();
  const desired = buildBuiltInTarget(config, receiverToken, nowIso);
  const existing = stores.targets.get(BUILTIN_TARGET_ID);
  if (!existing) {
    stores.targets.create(desired);
    logger.info({ targetId: BUILTIN_TARGET_ID, kind: desired.kind, url: desired.url }, 'created built-in receiver target');
    return BUILTIN_TARGET_ID;
  }
  stores.targets.update(BUILTIN_TARGET_ID, {
    kind: desired.kind,
    url: desired.url,
    auth: desired.auth,
    // Set both explicitly (undefined when the new kind does not use them) so a kind
    // change across restarts cannot leave a stale batchSize (which would wrongly flip
    // a SCIM target into Bulk mode) or a stale natsSubject on the refreshed target.
    batchSize: desired.batchSize,
    natsSubject: desired.natsSubject,
  });
  logger.debug({ targetId: BUILTIN_TARGET_ID, kind: desired.kind, url: desired.url }, 'refreshed built-in receiver target');
  return BUILTIN_TARGET_ID;
}

/** Balanced per-location activity weights covering all eight modeled sites. */
function defaultTimezoneWeights(): TimezoneWeights {
  return {
    byLocation: { FFT: 1, LDN: 0.9, NYC: 0.9, SIN: 0.5, HKG: 0.5, BLR: 0.7, PNQ: 0.5, JAX: 0.4 },
  };
}

/** Build the default scenario record targeting the built-in receiver. */
export function buildDefaultScenario(config: AppConfig, targetId: string, nowIso: string): ScenarioConfig {
  return {
    id: DEFAULT_SCENARIO_ID,
    name: 'Deutsche Bank - Natural Workday',
    description:
      'A full, natural Deutsche Bank day delivered to the built-in OneIM receiver: multi-timezone ' +
      'logins, access governance, banking transactions and a lifecycle and compliance stream, carrying ' +
      'the ambient exception rate of a real day (failed logins, lockouts, SoD violations, orphan and ' +
      'dormant accounts, break-glass), and punctuated by organic, randomized security and operational ' +
      'INCIDENTS, credential-stuffing waves, insider activity, ransomware attempts, audit surges, mass ' +
      'resets, that occur a few times across the accelerated day and differ every run. One run is one ' +
      'accelerated 24h day.',
    baselineRps: 40,
    maxRps: Math.min(config.MAX_RPS, 500),
    workdayAccel: config.WORKDAY_ACCEL,
    timezoneWeights: defaultTimezoneWeights(),
    eventMix: {
      byCategory: { ...DEFAULT_EVENT_MIX.byCategory },
      ...(DEFAULT_EVENT_MIX.byKind ? { byKind: { ...DEFAULT_EVENT_MIX.byKind } } : {}),
    },
    chaos: [],
    // Organic threat weaving on by default: the runtime spawns coordinated incidents on a
    // Poisson schedule through the day (see ThreatProfile). Sane defaults are applied by
    // resolveThreatProfile; enabling it is enough.
    threatProfile: { enabled: true },
    // One run is one accelerated 24-hour day, so it plays the full night -> morning ramp ->
    // peak -> wind-down arc and then completes (which also bounds incident accumulation).
    durationSec: Math.max(60, Math.round(86_400 / config.WORKDAY_ACCEL)),
    targetId,
    seed: config.SEED,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/**
 * Seed the default scenario only when no scenarios exist yet, so a fresh deploy is
 * immediately runnable and a restart never creates a duplicate.
 */
export function ensureDefaultScenario(
  stores: StoresBundle,
  config: AppConfig,
  targetId: string,
  logger: Logger,
): void {
  const existing = stores.scenarios.list(1, 0);
  if (existing.total > 0) return;
  const nowIso = new Date().toISOString();
  stores.scenarios.create(buildDefaultScenario(config, targetId, nowIso));
  logger.info({ scenarioId: DEFAULT_SCENARIO_ID }, 'seeded default scenario');
}
