import type { FastifyPluginAsync } from 'fastify';
import type { NatsConnection } from 'nats';
import type { ReceiverStats } from '../types/index.js';

/**
 * The bundled reference One Identity Manager (OneIM) receiver. It makes the whole
 * system demonstrable end-to-end with no external system: it accepts the same
 * inbound APIs a real Identity Manager exposes, simulates provisioning work, and
 * reports statistics.
 *
 * It is SELF-CONTAINED: it keeps its own in-memory provisioning state (accounts,
 * groups, SoD findings, per-connector queues) and does not read or write the
 * simulator's own store. This keeps the receiver and store builders fully decoupled
 * and lets the receiver be reset independently.
 *
 * Inbound surface. The plugin owns the FULL path trees (it registers absolute
 * paths, not prefix-relative ones), so the server mounts it once at root with no
 * prefix:
 * - SCIM 2.0 under /scim/v2: /scim/v2/Users (POST/GET/PUT/PATCH/DELETE),
 *   /scim/v2/Groups, /scim/v2/Bulk, /scim/v2/ServiceProviderConfig,
 *   /scim/v2/ResourceTypes, /scim/v2/Schemas
 * - Ingest: /ingest/webhook, /ingest/events (REST), /ingest/hr-batch (batch HR feed)
 *
 * Processing is simulated with realistic per-connector latency and failure rates,
 * SoD conflict detection, and orphan/dormant account accounting.
 */
export interface Receiver {
  /**
   * Fastify plugin exposing the inbound APIs. It owns the full `/scim/v2` and
   * `/ingest` path trees, so the server registers it exactly once at ROOT with no
   * prefix. Requests are authenticated against the receiver's configured token.
   */
  readonly plugin: FastifyPluginAsync;

  /** Aggregate processing statistics, pulled each telemetry frame. */
  stats(): ReceiverStats;

  /** Clear all provisioned state and counters. */
  reset(): void;

  /**
   * Subscribe to a NATS subject and ingest events published there, so the `nats`
   * delivery kind is demonstrable against the built-in receiver.
   */
  connectNats(conn: NatsConnection, subject: string): Promise<void>;

  /** Stop NATS subscriptions and any background processing. */
  stop(): Promise<void>;
}
