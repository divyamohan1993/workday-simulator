import type { FastifyInstance } from 'fastify';
import type { NatsConnection } from 'nats';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/schema.js';
import type { TimezoneWeights } from '../types/index.js';
import type { ArrivalProcess } from './arrival.js';
import type { Clock } from './clock.js';
import type { DeliveryAdapterFactory } from './delivery-adapter.js';
import type { EventBus } from './event-bus.js';
import type { EventGenerator } from './event-generator.js';
import type { IdentityPool } from './identity-pool.js';
import type { MetricsRegistry } from './metrics-registry.js';
import type { Receiver } from './receiver.js';
import type { ScenarioRuntime } from './scenario-runtime.js';
import type { RunStore, ScenarioStore, TargetStore } from './stores.js';

/**
 * Factory-function contracts. Each builder's `index.ts` must export a `create*`
 * function whose signature matches the alias here. Freezing the wiring (not just
 * the interfaces) removes the ambiguity that otherwise appears when the server
 * composes the modules together. The server (`buildServer`) is the composition
 * root: it constructs every singleton and passes them to the runtime.
 */

/* --- src/core/index.ts ----------------------------------------------------- */

export interface ClockOptions {
  /** Simulated seconds per real second. */
  accel: number;
  /** Simulated epoch ms to start at; defaults to real now. */
  startSimEpochMs?: number;
}
export type ClockFactory = (options: ClockOptions) => Clock;

export interface ArrivalOptions {
  baselineRps: number;
  maxRps: number;
  timezoneWeights: TimezoneWeights;
  seed: string;
}
export type ArrivalFactory = (options: ArrivalOptions) => ArrivalProcess;

export type EventBusFactory = (options: { logger: Logger }) => EventBus;

/* --- src/identity/index.ts ------------------------------------------------- */

export interface IdentityPoolOptions {
  logger: Logger;
}
export type IdentityPoolFactory = (options: IdentityPoolOptions) => IdentityPool;

/* --- src/events/index.ts --------------------------------------------------- */

export interface EventGeneratorOptions {
  seed: string;
  logger: Logger;
}
export type EventGeneratorFactory = (options: EventGeneratorOptions) => EventGenerator;

/* --- src/delivery/index.ts ------------------------------------------------- */

export interface DeliveryFactoryOptions {
  logger: Logger;
  /** Present only when NATS_URL is configured; enables the nats delivery kind. */
  nats?: NatsConnection;
}
export type CreateDeliveryAdapterFactory = (
  options: DeliveryFactoryOptions,
) => DeliveryAdapterFactory;

/* --- src/receiver/index.ts ------------------------------------------------- */

export interface ReceiverOptions {
  /** Token the receiver requires on its inbound endpoints. */
  token: string;
  logger: Logger;
  /** Seed for deterministic simulated processing jitter. */
  seed?: string;
  /** When false, provisioning is acknowledged immediately (no simulated latency). */
  simulateLatency?: boolean;
}
export type ReceiverFactory = (options: ReceiverOptions) => Receiver;

/* --- src/metrics/index.ts -------------------------------------------------- */

export interface MetricsOptions {
  /** Size of the recent-events ring buffer carried in each telemetry frame. */
  recentEventsSize: number;
}
export type MetricsFactory = (options: MetricsOptions) => MetricsRegistry;

/* --- src/store/index.ts ---------------------------------------------------- */

export interface StoresBundle {
  runs: RunStore;
  scenarios: ScenarioStore;
  targets: TargetStore;
  /** Close the underlying better-sqlite3 handle. */
  close(): void;
}
export interface StoresOptions {
  dbPath: string;
  logger: Logger;
}
export type StoresFactory = (options: StoresOptions) => StoresBundle;

/* --- src/runtime/index.ts -------------------------------------------------- */

/** Everything the runtime needs, assembled by the server. */
export interface RuntimeDependencies {
  config: AppConfig;
  logger: Logger;
  bus: EventBus;
  pool: IdentityPool;
  generator: EventGenerator;
  metrics: MetricsRegistry;
  stores: StoresBundle;
  deliveryFactory: DeliveryAdapterFactory;
  /** Per-run clock is created from this on each start. */
  createClock: ClockFactory;
  /** Per-run arrival process is created from this on each start. */
  createArrival: ArrivalFactory;
}
export type ScenarioRuntimeFactory = (deps: RuntimeDependencies) => ScenarioRuntime;

/* --- src/server/index.ts --------------------------------------------------- */

/** Builds the fully-wired Fastify app: stores, runtime, receiver, routes, WS, static. */
export type BuildServer = (config: AppConfig) => Promise<FastifyInstance>;
