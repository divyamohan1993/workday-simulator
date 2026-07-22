/**
 * The built-in reference One Identity Manager (OneIM) receiver.
 *
 * WHY it exists: it makes the whole simulator demonstrable end-to-end with no
 * external system. It accepts the same inbound APIs a real identity manager
 * exposes (SCIM 2.0, webhook, REST, NATS, batch HR feed), simulates asynchronous
 * per-connector provisioning with realistic latency and failure and the
 * backpressure that emerges under load, enforces segregation-of-duties, accounts
 * for orphan and dormant accounts, and reports aggregate statistics for the
 * telemetry frame.
 *
 * This module's ONLY public export is the frozen factory `createReceiver`
 * (`ReceiverFactory`). Everything else (the engine, store, connectors, detectors,
 * rate limiter, HMAC, ingest parsers) is internal and unit-tested through its own
 * module path, never re-exported here, so the surface the server composes against
 * stays exactly the contract.
 */

import type { NatsConnection, Subscription } from 'nats';
import type { Receiver, ReceiverFactory } from '../contracts/index.js';
import type { ReceiverStats } from '../types/index.js';
import { PUMP_INTERVAL_MS } from './constants.js';
import { createReceiverEngine } from './engine.js';
import { parseWebhookEnvelope } from './ingest.js';
import { createReceiverPlugin } from './plugin.js';

/**
 * Build the reference receiver.
 *
 * @param options Receiver token, logger, optional deterministic seed and a flag to
 *   disable simulated provisioning latency.
 * @returns A {@link Receiver}: a mountable Fastify plugin plus stats/reset/NATS/stop.
 */
export const createReceiver: ReceiverFactory = (options): Receiver => {
  const engine = createReceiverEngine({
    logger: options.logger,
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.simulateLatency !== undefined ? { simulateLatency: options.simulateLatency } : {}),
  });

  const plugin = createReceiverPlugin({ engine, token: options.token, logger: options.logger });

  // Drive asynchronous provisioning, approvals and detection from one unref'd
  // interval so it never keeps the process alive on its own. All timing inside the
  // engine flows through the injected clock; here that clock is the wall clock.
  const timer: NodeJS.Timeout = setInterval(() => {
    try {
      engine.pump(Date.now());
    } catch (error) {
      options.logger.error({ err: error }, 'receiver pump iteration failed');
    }
  }, PUMP_INTERVAL_MS);
  timer.unref();

  const subscriptions: Subscription[] = [];
  let stopped = false;

  /** Consume one NATS subscription, ingesting each decoded event envelope. */
  const consume = async (subscription: Subscription): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const message of subscription) {
      try {
        const parsed: unknown = JSON.parse(decoder.decode(message.data));
        const event = parseWebhookEnvelope(parsed);
        if (event) engine.ingestEvent(event);
      } catch (error) {
        options.logger.warn({ err: error, subject: message.subject }, 'receiver dropped malformed NATS message');
      }
    }
  };

  return {
    plugin,

    stats(): ReceiverStats {
      return engine.stats();
    },

    reset(): void {
      engine.reset();
    },

    async connectNats(conn: NatsConnection, subject: string): Promise<void> {
      if (stopped) throw new Error('receiver has been stopped');
      // Delivery publishes to `<subject>.<kind>`; subscribe to the wildcard tree so
      // every kind is ingested, plus the bare subject for any direct publishes.
      const wildcard = /[*>]/.test(subject) ? subject : `${subject}.>`;
      const targets = wildcard === subject ? [subject] : [subject, wildcard];
      for (const target of targets) {
        const subscription = conn.subscribe(target);
        subscriptions.push(subscription);
        // Fire the consumer loop; it ends when the subscription is drained on stop.
        void consume(subscription).catch((error) => {
          options.logger.error({ err: error, subject: target }, 'receiver NATS consumer failed');
        });
      }
      options.logger.info({ subject, wildcard }, 'receiver subscribed to NATS');
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await Promise.all(
        subscriptions.map(async (subscription) => {
          try {
            await subscription.drain();
          } catch {
            subscription.unsubscribe();
          }
        }),
      );
      subscriptions.length = 0;
    },
  };
};
