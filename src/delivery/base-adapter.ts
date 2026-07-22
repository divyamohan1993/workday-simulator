/**
 * The managed delivery adapter: the transport-agnostic engine that owns ALL
 * backpressure for one target and turns a stream of submitted events into wire
 * calls through an injected {@link DeliverySender}.
 *
 * Responsibilities, per the frozen cross-cutting protocol:
 * - a bounded internal queue with the target's overflow policy (ingress control);
 * - a bounded worker pool draining it at the target's concurrency;
 * - a token-bucket rate limit honouring the target's rps AND server 429s;
 * - jittered exponential retry on transient failures (idempotent by key);
 * - a circuit breaker that sheds load fast when the target is down;
 * - a bounded dead-letter buffer of recent non-deliveries;
 * - exactly one {@link DeliveryResult} emitted per event via `onResult`.
 *
 * It reports saturation and circuit state through `pressure()`, which the runtime
 * reads each tick to throttle arrivals; this adapter is otherwise open-loop.
 *
 * The clock, sleep and jitter source are injected so retries, rate limiting and
 * circuit transitions are driven deterministically in tests without real timers.
 */

import type { Logger } from 'pino';
import type {
  BackpressureState,
  DeliveryKind,
  DeliveryOutcome,
  DeliveryResult,
  DeliveryTarget,
  Unsubscribe,
  WorkdayEvent,
} from '../types/index.js';
import type { DeliveryAdapter, DeliveryResultHandler } from '../contracts/delivery-adapter.js';
import { computeBackoffMs, type BackoffPolicy } from './backoff.js';
import { BoundedQueue, type QueueItem } from './bounded-queue.js';
import { CircuitBreaker } from './circuit-breaker.js';
import {
  DEFAULT_CIRCUIT_FAILURE_THRESHOLD,
  DEFAULT_CIRCUIT_HALF_OPEN_PROBES,
  DEFAULT_CIRCUIT_OPEN_MS,
  DEFAULT_DEAD_LETTER_CAPACITY,
  DEFAULT_MAX_BATCH_AGE_MS,
} from './constants.js';
import { DeadLetterBuffer } from './dead-letter.js';
import { classifyError } from './errors.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';
import type { BatchSender, DeliverySender, SingleSender } from './types.js';

/** A minimal counting semaphore bounding concurrent in-flight sends. */
class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = Math.max(1, permits);
  }

  acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.permits += 1;
    }
  }
}

/** A failed attempt's disposition: retry after `delayMs`, or fail terminally. */
type RetryDecision =
  | { retry: true; delayMs: number }
  | { retry: false; status?: number; message: string };

/** Test seams and derived tunables for {@link createManagedAdapter}. */
export interface ManagedAdapterOptions {
  target: DeliveryTarget;
  sender: DeliverySender;
  logger: Logger;
  /** Injected clock (ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Injected delay. Defaults to a real `setTimeout` promise. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected jitter source in [0,1). Defaults to `Math.random`. */
  random?: () => number;
  /** Circuit-breaker overrides (else derived defaults). */
  circuit?: { failureThreshold?: number; openMs?: number; halfOpenMaxProbes?: number };
  /** Dead-letter ring capacity. */
  deadLetterCapacity?: number;
  /** Max age of the oldest buffered event before a partial batch flushes. */
  maxBatchAgeMs?: number;
}

class ManagedDeliveryAdapter implements DeliveryAdapter {
  public readonly kind: DeliveryKind;
  public readonly target: DeliveryTarget;

  private readonly sender: DeliverySender;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  private readonly queue: BoundedQueue<WorkdayEvent>;
  private readonly dlq: DeadLetterBuffer;
  private readonly breaker: CircuitBreaker;
  private readonly limiter: TokenBucketRateLimiter;
  private readonly slots: Semaphore;
  private readonly backoffPolicy: BackoffPolicy;
  private readonly maxBatchAgeMs: number;

  private readonly resultHandlers = new Set<DeliveryResultHandler>();
  private readonly counters = { delivered: 0, failed: 0, dropped: 0 };

  private readonly batchBuffer: Array<QueueItem<WorkdayEvent>> = [];
  private inFlight = 0;
  private forceFlush = false;

  private started = false;
  private stopping = false;
  private loop: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;

  private readonly workWaiters: Array<() => void> = [];
  private readonly idleWaiters: Array<() => void> = [];

  constructor(options: ManagedAdapterOptions) {
    this.target = options.target;
    this.kind = options.target.kind;
    this.sender = options.sender;
    this.logger = options.logger.child({ module: 'delivery', targetId: options.target.id, kind: options.target.kind });
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;

    this.queue = new BoundedQueue<WorkdayEvent>(options.target.queueHighWater, options.target.overflowPolicy);
    this.dlq = new DeadLetterBuffer(options.deadLetterCapacity ?? DEFAULT_DEAD_LETTER_CAPACITY);
    this.limiter = new TokenBucketRateLimiter({
      rps: options.target.rateLimit.rps,
      burst: options.target.rateLimit.burst,
      now: this.now,
    });
    this.breaker = new CircuitBreaker({
      failureThreshold: options.circuit?.failureThreshold ?? DEFAULT_CIRCUIT_FAILURE_THRESHOLD,
      openMs: options.circuit?.openMs ?? DEFAULT_CIRCUIT_OPEN_MS,
      halfOpenMaxProbes: options.circuit?.halfOpenMaxProbes ?? DEFAULT_CIRCUIT_HALF_OPEN_PROBES,
      now: this.now,
    });
    this.slots = new Semaphore(options.target.concurrency);
    this.backoffPolicy = {
      baseDelayMs: options.target.retry.baseDelayMs,
      maxDelayMs: options.target.retry.maxDelayMs,
      jitter: options.target.retry.jitter,
    };
    this.maxBatchAgeMs = options.maxBatchAgeMs ?? DEFAULT_MAX_BATCH_AGE_MS;
  }

  /** Open connections/auth and spawn the drain loop. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.sender.start();
    this.loop = this.sender.mode === 'batch' ? this.runBatchLoop() : this.runSingleLoop();
  }

  /**
   * Enqueue an event. Non-blocking. Returns false only when THIS event was the
   * casualty of a `drop_new` overflow; a `drop_oldest` eviction returns true and
   * emits a dropped result for the evicted (older) event instead. Every dropped
   * event, new or evicted, yields exactly one `onResult('dropped')`.
   */
  submit(event: WorkdayEvent): boolean {
    const nowMs = this.now();
    if (this.stopping) {
      this.emitDropped(event, nowMs);
      return false;
    }
    const result = this.queue.enqueue(event, nowMs);
    if (result.type === 'rejected') {
      this.emitDropped(event, nowMs);
      return false;
    }
    if (result.type === 'accepted_evicted') {
      this.emitDropped(result.evicted.value, result.evicted.submitWallMs);
    }
    this.notifyWork();
    return true;
  }

  onResult(handler: DeliveryResultHandler): Unsubscribe {
    this.resultHandlers.add(handler);
    return () => {
      this.resultHandlers.delete(handler);
    };
  }

  pressure(): BackpressureState {
    const queueDepth = this.queue.size() + this.batchBuffer.length;
    return {
      queueDepth,
      highWater: this.target.queueHighWater,
      inFlight: this.inFlight,
      saturated: queueDepth >= this.target.queueHighWater || this.breaker.current !== 'closed',
      circuit: this.breaker.current,
      droppedTotal: this.counters.dropped,
      deliveredTotal: this.counters.delivered,
      failedTotal: this.counters.failed,
    };
  }

  /** Drain the queue and await all in-flight deliveries, flushing partial batches. */
  async flush(): Promise<void> {
    if (!this.started) await this.start();
    this.forceFlush = true;
    this.notifyWork();
    await this.waitUntilIdle();
  }

  /** Stop workers and release resources. Idempotent, and safe under concurrent
   * callers: the first call owns the teardown and later calls await it. */
  async stop(): Promise<void> {
    if (!this.stopPromise) this.stopPromise = this.runStop();
    return this.stopPromise;
  }

  private async runStop(): Promise<void> {
    this.stopping = true;
    this.notifyWork();
    // Best-effort drain of whatever is queued and in flight before releasing.
    await this.flush().catch((error) => {
      this.logger.warn({ err: error }, 'flush during stop failed');
    });
    if (this.loop) await this.loop.catch(() => undefined);
    try {
      await this.sender.stop();
    } catch (error) {
      this.logger.warn({ err: error }, 'sender stop failed');
    }
  }

  /** Recent dead letters, newest first. Not part of the frozen interface; used
   * for diagnostics and tests. */
  deadLetters(): ReturnType<DeadLetterBuffer['list']> {
    return this.dlq.list();
  }

  /* --- Drain loops --------------------------------------------------------- */

  private async runSingleLoop(): Promise<void> {
    const sender = this.sender as SingleSender;
    while (true) {
      if (this.stopping && this.queue.size() === 0) break;
      if (this.queue.size() === 0) {
        await this.waitForWork();
        continue;
      }
      await this.slots.acquire();
      const item = this.queue.dequeue();
      if (!item) {
        this.slots.release();
        continue;
      }
      this.inFlight += 1;
      void this.processSingle(sender, item).finally(() => {
        this.slots.release();
        this.signalIdle();
      });
    }
  }

  private async runBatchLoop(): Promise<void> {
    const sender = this.sender as BatchSender;
    const size = Math.max(1, sender.batchSize);
    while (true) {
      // Pull whatever is available now into the batch buffer.
      while (this.batchBuffer.length < size) {
        const item = this.queue.dequeue();
        if (!item) break;
        this.batchBuffer.push(item);
      }
      const first = this.batchBuffer[0];
      const full = this.batchBuffer.length >= size;
      const aged = first !== undefined && this.now() - first.submitWallMs >= this.maxBatchAgeMs;
      const forced = this.forceFlush && this.batchBuffer.length > 0;
      const drainOnStop = this.stopping && this.batchBuffer.length > 0;

      if (full || aged || forced || drainOnStop) {
        const items = this.batchBuffer.splice(0, size);
        if (this.queue.size() === 0 && this.batchBuffer.length === 0) this.forceFlush = false;
        await this.slots.acquire();
        this.inFlight += items.length;
        void this.processBatch(sender, items).finally(() => {
          this.slots.release();
          this.signalIdle();
        });
        continue;
      }

      if (this.stopping && this.batchBuffer.length === 0 && this.queue.size() === 0) break;

      if (first !== undefined) {
        const wait = Math.max(1, this.maxBatchAgeMs - (this.now() - first.submitWallMs));
        await Promise.race([this.waitForWork(), this.sleep(wait)]);
      } else {
        await this.waitForWork();
      }
    }
  }

  /* --- Send with retry / breaker ------------------------------------------- */

  private async processSingle(sender: SingleSender, item: QueueItem<WorkdayEvent>): Promise<void> {
    const event = item.value;
    let attempt = 0;
    try {
      for (;;) {
        if (!this.breaker.tryPass(this.now()).allowed) {
          this.finish(event, item.submitWallMs, 'circuit_open', attempt, { error: 'circuit open' });
          return;
        }
        await this.limiter.acquire(this.sleep);
        attempt += 1;
        try {
          const result = await sender.sendOne(event);
          this.breaker.onSuccess();
          this.finish(event, item.submitWallMs, 'delivered', attempt, {
            ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
          });
          return;
        } catch (error) {
          const decision = this.handleFailure(error, attempt);
          if (!decision.retry) {
            this.finish(event, item.submitWallMs, 'failed', attempt, {
              ...(decision.status !== undefined ? { httpStatus: decision.status } : {}),
              error: decision.message,
            });
            return;
          }
          await this.sleep(decision.delayMs);
        }
      }
    } finally {
      this.inFlight -= 1;
    }
  }

  private async processBatch(sender: BatchSender, items: Array<QueueItem<WorkdayEvent>>): Promise<void> {
    const events = items.map((item) => item.value);
    let attempt = 0;
    try {
      for (;;) {
        if (!this.breaker.tryPass(this.now()).allowed) {
          this.finishMany(items, 'circuit_open', attempt, { error: 'circuit open' });
          return;
        }
        await this.limiter.acquire(this.sleep);
        attempt += 1;
        try {
          const result = await sender.sendBatch(events);
          this.breaker.onSuccess();
          this.finishMany(items, 'delivered', attempt, {
            ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
          });
          return;
        } catch (error) {
          const decision = this.handleFailure(error, attempt);
          if (!decision.retry) {
            this.finishMany(items, 'failed', attempt, {
              ...(decision.status !== undefined ? { httpStatus: decision.status } : {}),
              error: decision.message,
            });
            return;
          }
          await this.sleep(decision.delayMs);
        }
      }
    } finally {
      this.inFlight -= items.length;
    }
  }

  /**
   * Fold a failed attempt into the breaker and rate limiter, then decide whether
   * to retry. A 429 Retry-After both penalizes the rate limiter and dictates the
   * wait; otherwise the wait is jittered exponential backoff.
   *
   * @returns `{ retry: true, delayMs }` to retry after a wait, or
   *   `{ retry: false, status?, message }` when the send has failed for good.
   */
  private handleFailure(error: unknown, attempt: number): RetryDecision {
    this.breaker.onFailure(this.now());
    const classified = classifyError(error, this.target.retry.retryableStatuses);
    if (classified.status === 429 && classified.retryAfterMs !== undefined) {
      this.limiter.penalize(classified.retryAfterMs);
    }
    const exhausted = attempt > this.target.retry.maxRetries;
    if (!classified.retryable || exhausted) {
      return {
        retry: false,
        ...(classified.status !== undefined ? { status: classified.status } : {}),
        message: classified.message,
      };
    }
    const delayMs =
      classified.status === 429 && classified.retryAfterMs !== undefined
        ? classified.retryAfterMs
        : computeBackoffMs(attempt - 1, this.backoffPolicy, this.random);
    return { retry: true, delayMs };
  }

  /* --- Result accounting --------------------------------------------------- */

  private finish(
    event: WorkdayEvent,
    submitWallMs: number,
    outcome: DeliveryOutcome,
    attempts: number,
    extra: { httpStatus?: number; error?: string } = {},
  ): void {
    this.recordOutcome(outcome);
    this.emitResult(event, submitWallMs, outcome, attempts, extra);
  }

  private finishMany(
    items: Array<QueueItem<WorkdayEvent>>,
    outcome: DeliveryOutcome,
    attempts: number,
    extra: { httpStatus?: number; error?: string } = {},
  ): void {
    for (const item of items) {
      this.recordOutcome(outcome);
      this.emitResult(item.value, item.submitWallMs, outcome, attempts, extra);
    }
  }

  private emitDropped(event: WorkdayEvent, submitWallMs: number): void {
    this.recordOutcome('dropped');
    this.emitResult(event, submitWallMs, 'dropped', 0, { error: 'queue overflow' });
  }

  private recordOutcome(outcome: DeliveryOutcome): void {
    switch (outcome) {
      case 'delivered':
        this.counters.delivered += 1;
        break;
      case 'failed':
        this.counters.failed += 1;
        break;
      // A dropped or circuit-shed event never reached the target; both are load
      // deliberately shed, so both count toward droppedTotal while remaining
      // distinguishable by the DeliveryResult.outcome the consumer receives.
      case 'dropped':
      case 'circuit_open':
        this.counters.dropped += 1;
        break;
      case 'retried':
        break;
    }
  }

  private emitResult(
    event: WorkdayEvent,
    submitWallMs: number,
    outcome: DeliveryOutcome,
    attempts: number,
    extra: { httpStatus?: number; error?: string },
  ): void {
    const at = new Date(this.now()).toISOString();
    const result: DeliveryResult = {
      eventId: event.id,
      correlationId: event.correlationId,
      targetId: this.target.id,
      kind: this.kind,
      outcome,
      attempts,
      latencyMs: Math.max(0, this.now() - submitWallMs),
      at,
      ...(extra.httpStatus !== undefined ? { httpStatus: extra.httpStatus } : {}),
      ...(extra.error !== undefined ? { error: extra.error } : {}),
    };
    if (outcome !== 'delivered') {
      this.dlq.add({
        eventId: event.id,
        correlationId: event.correlationId,
        outcome,
        attempts,
        at,
        ...(extra.httpStatus !== undefined ? { httpStatus: extra.httpStatus } : {}),
        ...(extra.error !== undefined ? { error: extra.error } : {}),
      });
    }
    for (const handler of this.resultHandlers) {
      try {
        handler(result);
      } catch (error) {
        this.logger.error({ err: error, eventId: event.id }, 'delivery result handler threw');
      }
    }
  }

  /* --- Coordination primitives -------------------------------------------- */

  private notifyWork(): void {
    const waiters = this.workWaiters.splice(0, this.workWaiters.length);
    for (const resolve of waiters) resolve();
  }

  private waitForWork(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return new Promise<void>((resolve) => this.workWaiters.push(resolve));
  }

  private isIdle(): boolean {
    return this.queue.size() === 0 && this.batchBuffer.length === 0 && this.inFlight === 0;
  }

  private signalIdle(): void {
    if (!this.isIdle()) return;
    const waiters = this.idleWaiters.splice(0, this.idleWaiters.length);
    for (const resolve of waiters) resolve();
  }

  private waitUntilIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }
}

/**
 * Build a managed delivery adapter around a sender.
 *
 * @param options Target, sender, logger and injectable seams.
 * @returns A {@link DeliveryAdapter} that owns backpressure for the target.
 */
export function createManagedAdapter(options: ManagedAdapterOptions): DeliveryAdapter {
  return new ManagedDeliveryAdapter(options);
}
