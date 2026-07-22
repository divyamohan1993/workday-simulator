/**
 * Public entry point for the infrastructure module: persistence + observability.
 *
 * This one module fulfils three responsibilities that the frozen
 * `contracts/factories.ts` describes under the (pre-reorg) directory comments
 * `src/store`, `src/metrics`, and the logger the server builds. After the repository
 * reorganization (core -> engine, identity -> domain), storage, metrics, and logging
 * live together here in `src/infra`. The exported factories match the frozen aliases
 * exactly:
 *
 *   createStores           : StoresFactory      (runs / scenarios / targets + close)
 *   createMetricsRegistry  : MetricsFactory     (telemetry aggregation)
 *   createLogger           : the pino factory the server injects into every module
 *
 * The server's composition root imports all three from HERE. The Drizzle schema is
 * re-exported so `drizzle.config.ts` can target either `./src/infra/schema.ts` or
 * this barrel.
 */

import type { MetricsFactory, StoresFactory } from '../contracts/factories.js';
import { createMetricsRegistry } from './metrics.js';
import { createStores } from './stores.js';

// Persistence.
export { createStores } from './stores.js';
export { openDatabase } from './db.js';
export type { AppDatabase, OpenedDatabase } from './db.js';
export * from './schema.js';

// Observability.
export { createMetricsRegistry } from './metrics.js';
export type { MetricsRuntimeDeps } from './metrics.js';
export {
  createLogger,
  correlationId,
  withCorrelationId,
  REDACT_PATHS,
  REDACT_CENSOR,
  CORRELATION_KEY,
} from './logger.js';
export type { LoggerFactoryOptions } from './logger.js';

// Compile-time conformance guards. Asserting assignability to the frozen aliases HERE
// makes any signature drift a build failure in this module rather than a surprise in
// the integrator's session.
const _storesFactory: StoresFactory = createStores;
const _metricsFactory: MetricsFactory = createMetricsRegistry;
void _storesFactory;
void _metricsFactory;
