import type {
  BackpressureState,
  DeliveryKind,
  DeliveryResult,
  DeliveryTarget,
  Unsubscribe,
  WorkdayEvent,
} from '../types/index.js';

/** Called once per event with its final delivery outcome. */
export type DeliveryResultHandler = (result: DeliveryResult) => void;

/**
 * Streams events to one delivery target (SCIM, webhook, REST, NATS or batch).
 *
 * The adapter OWNS all backpressure. `submit` is a non-blocking push into a bounded
 * internal queue; a bounded worker pool drains it with the target's concurrency
 * limit, token-bucket rate limit, jittered-exponential retry and a circuit breaker.
 * When the queue is saturated the adapter applies the target's overflow policy and
 * reports saturation through `pressure()`, which the runtime reads each tick to
 * throttle the arrival process (the only closed-loop control in the system).
 *
 * Mapping an event to a wire request uses the event's `delivery` metadata:
 * - scim: create/patch/deactivate SCIM Users and Groups
 * - webhook/rest: POST the event (webhook may HMAC-sign the body)
 * - nats: publish to the configured subject
 * - batch: accumulate to `batchSize` then POST the HR feed batch
 */
export interface DeliveryAdapter {
  readonly kind: DeliveryKind;
  readonly target: DeliveryTarget;

  /** Open connections and warm authentication. Idempotent. */
  start(): Promise<void>;

  /**
   * Enqueue an event for delivery. Non-blocking. Returns false when the event was
   * dropped because the queue was saturated and the overflow policy is drop_*.
   * For the `block` policy, implementations still return synchronously and apply
   * runtime throttling via `pressure()` rather than blocking the caller's stack.
   */
  submit(event: WorkdayEvent): boolean;

  /** Subscribe to per-event delivery results. Returns an unsubscribe function. */
  onResult(handler: DeliveryResultHandler): Unsubscribe;

  /** Current backpressure and circuit-breaker snapshot. */
  pressure(): BackpressureState;

  /** Drain the queue and await all in-flight deliveries. */
  flush(): Promise<void>;

  /** Stop workers and close connections. Safe to call once. */
  stop(): Promise<void>;
}

/**
 * Builds a DeliveryAdapter for a target, selecting the implementation by
 * `target.kind`. Injected with a logger and (optionally) a NATS connection by the
 * composition root.
 */
export interface DeliveryAdapterFactory {
  create(target: DeliveryTarget): DeliveryAdapter;
}
