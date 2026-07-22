/**
 * The in-process publish/subscribe spine for generated events.
 *
 * Deliberately a lightweight SYNCHRONOUS fan-out with no internal buffering. All
 * backpressure lives in the delivery adapter's bounded queue, never here, so the bus
 * can never silently become an unbounded queue that hides memory growth. The runtime
 * is the sole publisher; the delivery adapter and the metrics registry are the usual
 * subscribers.
 *
 * Isolation guarantee: a subscriber that throws is caught and logged, and never
 * prevents the other subscribers from running or propagates back to the publisher. A
 * single misbehaving consumer must not stall the whole stream.
 */

import type { Logger } from 'pino';
import type { EventBus, EventHandler } from '../contracts/event-bus.js';
import type { Unsubscribe, WorkdayEvent } from '../types/index.js';

/**
 * Create a synchronous event bus.
 *
 * WHY copy-on-write: `publish` runs on the hot path and must be allocation-free, and
 * a handler may unsubscribe itself while being notified. Maintaining an immutable
 * snapshot array that is rebuilt only when subscriptions change lets `publish`
 * iterate a stable list with a plain for-loop (no per-publish allocation, safe
 * against concurrent modification), while subscribe/unsubscribe pay the copy cost on
 * the cold path.
 */
export function createEventBus(options: { logger: Logger }): EventBus {
  const logger = options.logger;
  const handlers = new Set<EventHandler>();
  let snapshot: EventHandler[] = [];

  const rebuild = (): void => {
    snapshot = [...handlers];
  };

  const bus: EventBus = {
    publish(event: WorkdayEvent): void {
      const current = snapshot;
      for (let i = 0; i < current.length; i += 1) {
        const handler = current[i];
        if (handler === undefined) continue;
        try {
          handler(event);
        } catch (err) {
          logger.error(
            { err, eventId: event.id, kind: event.kind },
            'event subscriber threw; isolated and continuing',
          );
        }
      }
    },
    subscribe(handler: EventHandler): Unsubscribe {
      handlers.add(handler);
      rebuild();
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        handlers.delete(handler);
        rebuild();
      };
    },
    subscriberCount(): number {
      return handlers.size;
    },
  };

  return bus;
}
