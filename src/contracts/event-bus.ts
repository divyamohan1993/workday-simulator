import type { Unsubscribe, WorkdayEvent } from '../types/index.js';

/** Synchronous subscriber callback. Must be fast and must not throw. */
export type EventHandler = (event: WorkdayEvent) => void;

/**
 * In-process publish/subscribe spine for generated events.
 *
 * Deliberately a lightweight SYNCHRONOUS fan-out with no internal buffering. All
 * backpressure lives in the DeliveryAdapter, not here, so the bus never becomes a
 * hidden unbounded queue. Handlers run in subscription order on the caller's stack.
 *
 * Typical subscribers: the delivery adapter (which enqueues into its own bounded
 * queue) and the metrics registry (which records the event). The runtime is the
 * sole publisher.
 */
export interface EventBus {
  /**
   * Fan out an event to every subscriber synchronously. A handler that throws is
   * isolated and logged; the error is never propagated to the publisher and never
   * prevents other handlers from running.
   */
  publish(event: WorkdayEvent): void;
  /** Register a handler. Returns a function that removes it. */
  subscribe(handler: EventHandler): Unsubscribe;
  /** Number of active subscribers, for diagnostics. */
  subscriberCount(): number;
}
