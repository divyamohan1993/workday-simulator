/**
 * NATS publisher: publishes each event's envelope to a subject derived per event
 * kind, so a receiver can subscribe by category or kind (`<base>.<kind>`, e.g.
 * "workday.joiner.hire"). A wildcard subscription on `<base>.>` receives all.
 *
 * NATS core delivery is fire-and-buffer: `publish` enqueues into the client's
 * outbound buffer and returns. A publish against a closed/draining connection
 * throws synchronously; we surface that as a transient network error so the base
 * adapter's retry and circuit breaker treat a NATS outage like any other. The
 * shared connection is owned by the server, so `stop()` never closes it.
 */

import type { NatsConnection } from 'nats';
import type { WorkdayEvent } from '../types/index.js';
import { buildEnvelope, serializeEnvelope } from './envelope.js';
import { DeliveryNetworkError } from './errors.js';
import type { SendResult, SingleSender } from './types.js';

/** Options for {@link createNatsSender}. */
export interface NatsSenderOptions {
  connection: NatsConnection;
  /** Base subject; the event kind is appended. Defaults to "workday". */
  baseSubject?: string;
}

/** Create a single-mode NATS publisher. */
export function createNatsSender(options: NatsSenderOptions): SingleSender {
  const base = (options.baseSubject && options.baseSubject.length > 0 ? options.baseSubject : 'workday').replace(/\.+$/, '');
  const encoder = new TextEncoder();

  return {
    mode: 'single',
    async start(): Promise<void> {
      /* connection lifecycle is owned by the server */
    },
    async stop(): Promise<void> {
      /* never close the shared connection */
    },
    async sendOne(event: WorkdayEvent): Promise<SendResult> {
      const subject = `${base}.${event.kind}`;
      const payload = encoder.encode(serializeEnvelope(buildEnvelope(event)));
      try {
        options.connection.publish(subject, payload);
      } catch (error) {
        throw new DeliveryNetworkError(
          error instanceof Error ? error.message : 'nats publish failed',
          error,
        );
      }
      return { noop: false };
    },
  };
}
