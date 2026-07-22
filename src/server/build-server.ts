/**
 * The composition root.
 *
 * `buildServer` constructs every singleton exactly once, wires them per the frozen
 * cross-cutting protocol, and returns a fully-initialized Fastify instance. It is the
 * ONLY place that reaches across module boundaries: it imports each module's public
 * factory from its index and assembles the graph the runtime and routes then use
 * without ever re-constructing a dependency.
 *
 * Wiring, in order of the data flow it enables:
 *   config -> logger, stores (infra), metrics (infra), identity pool (domain, seeded
 *   so the org explorer has data before the first run), event generator (events),
 *   built-in receiver (receiver), optional NATS, delivery factory (delivery), event
 *   bus + scenario runtime (engine). The telemetry hub subscribes to the runtime's
 *   frames and fans them out to WebSocket clients; a light interval folds the
 *   receiver's stats into the metrics registry so every frame carries fresh receiver
 *   numbers (the runtime has no receiver reference by design).
 *
 * The optional second argument is a test/embedding seam. It never changes the
 * production shape: a no-op delivery factory, a silent logger, an in-memory database
 * (via config.DB_PATH), disabled static, or a skipped NATS connect let a unit test
 * exercise the control plane without real sinks. `buildServer` remains assignable to
 * the frozen `BuildServer` signature (the extra parameter is optional).
 */

import Fastify, { LogController } from 'fastify';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { connect } from 'nats';
import type { NatsConnection } from 'nats';
import type { AppConfig } from '../config/schema.js';
import type { BuildServer } from '../contracts/factories.js';
import type { DeliveryAdapterFactory } from '../contracts/delivery-adapter.js';
import { createIdentityPool } from '../domain/index.js';
import { createArrivalProcess, createClock, createEventBus, createScenarioRuntime } from '../engine/index.js';
import { createEventGenerator } from '../events/index.js';
import { createDeliveryAdapterFactory } from '../delivery/index.js';
import { createReceiver } from '../receiver/index.js';
import { CORRELATION_KEY, correlationId, createLogger, createMetricsRegistry, createStores } from '../infra/index.js';
import { createAdminAuthHook, FailedAuthTracker } from './auth.js';
import { DEFAULT_NATS_SUBJECT, ensureBuiltInTarget, ensureDefaultScenario } from './built-ins.js';
import type { ServerContext } from './context.js';
import { registerErrorHandling } from './errors.js';
import { registerSecurityPlugins, registerStaticAndNotFound } from './plugins.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerIdentityRoutes } from './routes/identities.js';
import { registerObservabilityRoutes } from './routes/observability.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerScenarioRoutes } from './routes/scenarios.js';
import { registerTargetRoutes } from './routes/targets.js';
import { createTelemetryHub } from './telemetry-hub.js';
import { registerTelemetryWebSocket } from './ws.js';

/** Max request body accepted (loopback SCIM Bulk deliveries can be a few MB). */
const BODY_LIMIT_BYTES = 16 * 1024 * 1024;

/** WebSocket close code for a normal server-initiated shutdown (RFC 6455 "going away"). */
const WS_CLOSE_GOING_AWAY = 1001;

/**
 * Test and embedding overrides. Every field has a production default; omit the whole
 * argument for the real server.
 */
export interface BuildServerOverrides {
  /** Inject a pre-built logger (tests pass a silent one); default builds from config. */
  logger?: Logger;
  /** Inject a delivery factory (tests pass a no-op sink); default is the real factory. */
  deliveryFactory?: DeliveryAdapterFactory;
  /** Simulate receiver provisioning latency; default true (realistic). */
  simulateReceiverLatency?: boolean;
  /** Serve the static dashboard when a build exists; default true. */
  serveStatic?: boolean;
  /** Attempt a NATS connection when NATS_URL is set; default true. */
  connectNats?: boolean;
  /** Seed the default scenario when the store is empty; default true. */
  seedDefaultScenario?: boolean;
}

/**
 * Build the fully-wired Fastify application.
 *
 * @param config Validated application configuration (from `loadConfig`).
 * @param overrides Optional test/embedding seams; omit for the production server.
 * @returns A ready Fastify instance; call `.listen()` to serve.
 */
export async function buildServer(config: AppConfig, overrides: BuildServerOverrides = {}): Promise<FastifyInstance> {
  const logger =
    overrides.logger ??
    createLogger({ level: config.LOG_LEVEL, name: 'workday-simulator', pretty: config.NODE_ENV === 'development' });
  const receiverToken = config.RECEIVER_TOKEN ?? config.ADMIN_TOKEN;

  /* --- Infrastructure: persistence and metrics ----------------------------- */
  const stores = createStores({ dbPath: config.DB_PATH, logger });
  const metrics = createMetricsRegistry({ recentEventsSize: config.TELEMETRY_RECENT_EVENTS });

  /* --- Domain and event generation ----------------------------------------- */
  const pool = createIdentityPool({ logger });
  // Seed at boot so the identity endpoints return the workforce before any run; the
  // runtime reseeds deterministically on each start, so this is not wasted work.
  pool.seed(config.IDENTITY_POOL_SIZE, config.SEED);
  const generator = createEventGenerator({ seed: config.SEED, logger });

  /* --- Built-in reference receiver ----------------------------------------- */
  const receiver = createReceiver({
    token: receiverToken,
    logger,
    seed: config.SEED,
    simulateLatency: overrides.simulateReceiverLatency ?? true,
  });

  /* --- Optional NATS transport --------------------------------------------- */
  let natsConn: NatsConnection | undefined;
  if (config.NATS_URL && overrides.connectNats !== false) {
    try {
      natsConn = await connect({ servers: config.NATS_URL, name: 'workday-simulator', timeout: 5_000 });
      logger.info({ url: config.NATS_URL }, 'connected to NATS');
      try {
        await receiver.connectNats(natsConn, DEFAULT_NATS_SUBJECT);
      } catch (err) {
        logger.error({ err }, 'receiver failed to subscribe to NATS; nats ingest disabled');
      }
    } catch (err) {
      // NATS is optional: a failed connection degrades gracefully to no nats transport
      // rather than aborting boot. The nats delivery kind then sheds via its adapter.
      logger.error({ err, url: config.NATS_URL }, 'NATS connection failed; nats delivery disabled');
      natsConn = undefined;
    }
  }
  const natsConnected = natsConn !== undefined;

  /* --- Delivery ------------------------------------------------------------ */
  const deliveryFactory =
    overrides.deliveryFactory ??
    createDeliveryAdapterFactory({ logger, ...(natsConn ? { nats: natsConn } : {}) });

  /* --- Built-in target and default scenario -------------------------------- */
  const builtInTargetId = ensureBuiltInTarget(stores, config, receiverToken, logger);
  if (overrides.seedDefaultScenario !== false) {
    ensureDefaultScenario(stores, config, builtInTargetId, logger);
  }

  /* --- Engine: bus and scenario runtime ------------------------------------ */
  const bus = createEventBus({ logger });
  const runtime = createScenarioRuntime({
    config,
    logger,
    bus,
    pool,
    generator,
    metrics,
    stores,
    deliveryFactory,
    createClock,
    createArrival: createArrivalProcess,
  });

  /* --- Telemetry fan-out ---------------------------------------------------- */
  const telemetry = createTelemetryHub({ logger });
  const unsubscribeFrames = runtime.onFrame((frame) => telemetry.ingestFrame(frame));

  // Fold the receiver's stats into the metrics registry once per interval so every
  // telemetry frame carries fresh receiver numbers (the runtime holds no receiver
  // reference, by design). Unref'd so it never keeps the process alive on its own.
  const receiverStatsTimer = setInterval(() => {
    try {
      metrics.recordReceiver(receiver.stats());
    } catch (err) {
      logger.debug({ err }, 'folding receiver stats into metrics failed');
    }
  }, config.METRICS_INTERVAL_MS);
  receiverStatsTimer.unref();

  const failedAuth = new FailedAuthTracker();

  const ctx: ServerContext = {
    config,
    logger,
    stores,
    pool,
    metrics,
    receiver,
    runtime,
    telemetry,
    adminToken: config.ADMIN_TOKEN,
    receiverToken,
    builtInTargetId,
    natsConnected,
  };

  /* --- Fastify application -------------------------------------------------- */
  const app = Fastify({
    // Cast to the base logger type so the Fastify instance is not specialized on the
    // concrete pino Logger (which would make it incompatible with the route registrars
    // typed against the default FastifyInstance). A pino Logger satisfies
    // FastifyBaseLogger, so this is a safe upcast, not a loss of behavior.
    loggerInstance: logger as FastifyBaseLogger,
    // Correlation id is always server-generated (never read from a client header) so
    // an attacker cannot forge the id echoed into logs and error bodies.
    genReqId: () => correlationId(),
    requestIdHeader: false,
    logController: new LogController({ requestIdLogLabel: CORRELATION_KEY }),
    // Behind Caddy/Cloudflare: trust the proxy so request.ip is the real client for
    // the failed-auth tracker and the receiver's per-source admission.
    trustProxy: true,
    bodyLimit: BODY_LIMIT_BYTES,
  });

  // Tolerate an empty body on the no-body POST routes (run stop/pause/resume, receiver
  // reset, target test): many HTTP clients send `Content-Type: application/json` with
  // no payload, and Fastify's default parser rejects that with a spurious 400. An empty
  // body parses to undefined; a non-empty body is still strict JSON. This overrides the
  // default json parser at root and is inherited by the api and receiver subtrees.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString();
    if (text.trim().length === 0) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      (err as Error & { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  registerErrorHandling(app);
  await registerSecurityPlugins(app, config);

  // The built-in receiver owns the full /scim/v2 and /ingest path trees; mount once.
  await app.register(receiver.plugin);

  // The admin control plane, encapsulated under /api with the bearer-auth hook.
  await app.register(
    async (api) => {
      api.addHook('onRequest', createAdminAuthHook(config.ADMIN_TOKEN, failedAuth));
      registerHealthRoutes(api, ctx);
      registerCatalogRoutes(api);
      registerScenarioRoutes(api, ctx);
      registerTargetRoutes(api, ctx);
      registerRunRoutes(api, ctx);
      registerIdentityRoutes(api, ctx);
      registerObservabilityRoutes(api, ctx);
    },
    { prefix: '/api' },
  );

  // Telemetry WebSocket (token-authenticated) at root, then static + not-found.
  registerTelemetryWebSocket(app, ctx);
  await registerStaticAndNotFound(app, ctx, overrides.serveStatic !== false);

  /* --- Graceful teardown ---------------------------------------------------- */
  app.addHook('onClose', async () => {
    clearInterval(receiverStatsTimer);
    try {
      unsubscribeFrames();
    } catch {
      /* handler set removal is best-effort */
    }
    // Stop the run first: it flushes delivery (into the receiver) and persists the
    // summary to the store, so this must precede closing the receiver and the store.
    try {
      if (runtime.state() !== null) await runtime.stop();
    } catch (err) {
      logger.warn({ err }, 'stopping active run during shutdown failed');
    }
    telemetry.closeAll(WS_CLOSE_GOING_AWAY, 'server shutting down');
    try {
      await receiver.stop();
    } catch (err) {
      logger.warn({ err }, 'stopping receiver during shutdown failed');
    }
    if (natsConn) {
      try {
        await natsConn.drain();
      } catch (err) {
        logger.warn({ err }, 'draining NATS during shutdown failed');
      }
    }
    try {
      stores.close();
    } catch (err) {
      logger.warn({ err }, 'closing stores during shutdown failed');
    }
  });

  await app.ready();
  logger.info(
    { port: config.PORT, host: config.HOST, builtInTargetId, natsConnected },
    'workday simulator server built',
  );
  return app;
}

// Compile-time conformance guard: the exported factory must satisfy the frozen
// `BuildServer` alias, so any signature drift fails the build here.
const _conformance: BuildServer = buildServer;
void _conformance;
