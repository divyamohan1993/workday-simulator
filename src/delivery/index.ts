/**
 * Public entry point for the delivery module.
 *
 * It exposes exactly one factory, `createDeliveryAdapterFactory`, matching the
 * frozen `CreateDeliveryAdapterFactory` signature. Given a logger and an optional
 * NATS connection, it returns a `DeliveryAdapterFactory` whose `.create(target)`
 * builds a fully-managed `DeliveryAdapter` for the target's kind:
 *
 * - scim    -> SCIM 2.0 User/Group operations (Bulk when batchSize > 1)
 * - webhook -> HMAC-signable event envelope POST
 * - rest    -> generic JSON `{ events }` POST
 * - batch   -> RFC 4180 HR-feed CSV POST
 * - nats    -> publish per event kind on the shared connection
 *
 * Every adapter shares the same managed engine (bounded queue, worker pool, token
 * bucket, jittered retry, circuit breaker, dead-letter buffer) from
 * `base-adapter.ts`; the per-kind code only maps an event onto a wire call.
 */

import type { CreateDeliveryAdapterFactory, DeliveryFactoryOptions } from '../contracts/factories.js';
import type { DeliveryAdapter, DeliveryAdapterFactory } from '../contracts/delivery-adapter.js';
import type { DeliveryTarget, WorkdayEvent } from '../types/index.js';
import type { Logger } from 'pino';
import { createAuthenticator } from './auth.js';
import { createManagedAdapter } from './base-adapter.js';
import { DeliveryNetworkError } from './errors.js';
import { createUndiciTransport } from './http-transport.js';
import { createBatchSender } from './sender-batch.js';
import { createNatsSender } from './sender-nats.js';
import { createRestSender } from './sender-rest.js';
import { createScimSender } from './sender-scim.js';
import { createWebhookSender } from './sender-webhook.js';
import type { DeliverySender, SingleSender } from './types.js';

/** A sender used when a NATS target has no configured connection: every send
 * fails transiently, so the breaker opens and sheds load instead of crashing. */
function unavailableNatsSender(logger: Logger, target: DeliveryTarget): SingleSender {
  let warned = false;
  return {
    mode: 'single',
    async start(): Promise<void> {
      logger.warn({ targetId: target.id }, 'nats target configured but NATS_URL is not set; deliveries will fail');
    },
    async stop(): Promise<void> {
      /* nothing to release */
    },
    async sendOne(_event: WorkdayEvent): Promise<never> {
      if (!warned) warned = true;
      throw new DeliveryNetworkError('NATS connection not configured');
    },
  };
}

/** Build the sender for an HTTP-family target, wiring transport and auth. */
function buildHttpSender(target: DeliveryTarget, logger: Logger): { sender: DeliverySender } {
  const transport = createUndiciTransport({ connections: Math.max(1, target.concurrency) });
  const auth = createAuthenticator(target.auth, { transport, logger });
  const shared = { target, transport, auth };
  switch (target.kind) {
    case 'scim':
      return { sender: createScimSender(shared) };
    case 'webhook':
      return { sender: createWebhookSender(shared) };
    case 'rest':
      return { sender: createRestSender(shared) };
    case 'batch':
      return { sender: createBatchSender(shared) };
    default:
      // Unreachable for HTTP kinds; nats is handled separately.
      return { sender: createWebhookSender(shared) };
  }
}

/**
 * Build the delivery adapter factory.
 *
 * @param options Logger and (when configured) a shared NATS connection.
 * @returns A factory whose `.create(target)` yields a managed adapter.
 */
export const createDeliveryAdapterFactory: CreateDeliveryAdapterFactory = (
  options: DeliveryFactoryOptions,
): DeliveryAdapterFactory => {
  const { logger, nats } = options;
  return {
    create(target: DeliveryTarget): DeliveryAdapter {
      if (target.kind === 'nats') {
        const sender: DeliverySender = nats
          ? createNatsSender({ connection: nats, ...(target.natsSubject ? { baseSubject: target.natsSubject } : {}) })
          : unavailableNatsSender(logger, target);
        return createManagedAdapter({ target, sender, logger });
      }
      const { sender } = buildHttpSender(target, logger);
      return createManagedAdapter({ target, sender, logger });
    },
  };
};

// Compile-time conformance guard: the exported factory must satisfy the frozen
// alias exactly, so any drift fails the build here rather than in the server.
const _conformance: CreateDeliveryAdapterFactory = createDeliveryAdapterFactory;
void _conformance;
