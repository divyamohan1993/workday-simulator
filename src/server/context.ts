/**
 * The server context: the bundle of already-constructed singletons the route
 * modules and the WebSocket channel read from. The composition root (build-server.ts)
 * builds every field once and threads this object into each route registrar, so no
 * route reaches for a global, re-opens the database, or re-reads config; there is one
 * owner for every dependency and one place (the root) that wires them.
 */

import type { Logger } from 'pino';
import type { AppConfig } from '../config/schema.js';
import type { IdentityPool } from '../contracts/identity-pool.js';
import type { MetricsRegistry } from '../contracts/metrics-registry.js';
import type { Receiver } from '../contracts/receiver.js';
import type { ScenarioRuntime } from '../contracts/scenario-runtime.js';
import type { StoresBundle } from '../contracts/factories.js';
import type { TelemetryHub } from './telemetry-hub.js';

/** Everything a route or the WS channel needs, assembled by the composition root. */
export interface ServerContext {
  config: AppConfig;
  logger: Logger;
  stores: StoresBundle;
  pool: IdentityPool;
  metrics: MetricsRegistry;
  receiver: Receiver;
  runtime: ScenarioRuntime;
  telemetry: TelemetryHub;
  /** The resolved admin bearer token (guards `/api/*` and the telemetry socket). */
  adminToken: string;
  /** The token the built-in receiver requires (defaults to the admin token). */
  receiverToken: string;
  /** Id of the protected built-in receiver target. */
  builtInTargetId: string;
  /** Whether a NATS connection was established at boot (drives the nats target test). */
  natsConnected: boolean;
}
