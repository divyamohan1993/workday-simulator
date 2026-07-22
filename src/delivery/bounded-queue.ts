/**
 * A bounded FIFO queue with an overflow policy, backing the adapter's internal
 * buffer. It is the sole place backpressure decisions are made on ingress.
 *
 * WHY a head-index ring rather than `Array.shift`: at thousands of events per
 * second, `shift` is O(n) and would dominate CPU. This keeps enqueue/dequeue
 * amortized O(1) by advancing a head pointer and compacting only occasionally.
 *
 * Overflow semantics (see `DeliveryTarget.overflowPolicy`):
 * - `drop_new`    : at capacity, reject the incoming event (it is the casualty).
 * - `drop_oldest` : at capacity, evict the oldest to admit the newest.
 * - `block`       : never drop; accept past the high-water mark and rely on the
 *                   runtime's closed-loop throttle (which reads `pressure()`) to
 *                   stop the inflow. It stays bounded in practice because a
 *                   saturated adapter reports saturation and arrivals back off.
 */

import type { DeliveryTarget } from '../types/index.js';

/** One buffered event plus the wall time it was submitted (for latency math). */
export interface QueueItem<T> {
  value: T;
  submitWallMs: number;
}

/** Result of an enqueue, distinguishing who (if anyone) was dropped. */
export type EnqueueResult<T> =
  | { type: 'accepted' }
  | { type: 'accepted_evicted'; evicted: QueueItem<T> }
  | { type: 'rejected' };

const COMPACT_THRESHOLD = 1024;

export class BoundedQueue<T> {
  private readonly buffer: Array<QueueItem<T> | undefined> = [];
  private head = 0;

  /**
   * @param highWater Capacity at which the overflow policy engages.
   * @param policy Overflow behaviour once at capacity.
   */
  constructor(
    private readonly highWater: number,
    private readonly policy: DeliveryTarget['overflowPolicy'],
  ) {}

  /** Number of buffered items. */
  size(): number {
    return this.buffer.length - this.head;
  }

  /**
   * Enqueue an event, applying the overflow policy at capacity.
   *
   * @returns `accepted` when buffered cleanly; `accepted_evicted` (drop_oldest)
   *   carrying the evicted item so the adapter can emit its dropped result;
   *   `rejected` (drop_new) when the incoming event itself is dropped.
   */
  enqueue(value: T, submitWallMs: number): EnqueueResult<T> {
    if (this.size() >= this.highWater) {
      if (this.policy === 'drop_new') {
        return { type: 'rejected' };
      }
      if (this.policy === 'drop_oldest') {
        const evicted = this.dequeue();
        this.push(value, submitWallMs);
        // `evicted` is defined because size() >= highWater >= 1 here.
        return evicted
          ? { type: 'accepted_evicted', evicted }
          : { type: 'accepted' };
      }
      // 'block': accept beyond capacity; the runtime throttle is the safety valve.
    }
    this.push(value, submitWallMs);
    return { type: 'accepted' };
  }

  /** Remove and return the oldest item, or undefined when empty. */
  dequeue(): QueueItem<T> | undefined {
    if (this.head >= this.buffer.length) return undefined;
    const item = this.buffer[this.head];
    this.buffer[this.head] = undefined;
    this.head += 1;
    // Amortized compaction: once the consumed prefix is large and dominant,
    // drop it so the backing array cannot grow without bound under churn.
    if (this.head > COMPACT_THRESHOLD && this.head * 2 > this.buffer.length) {
      this.buffer.splice(0, this.head);
      this.head = 0;
    }
    return item;
  }

  private push(value: T, submitWallMs: number): void {
    this.buffer.push({ value, submitWallMs });
  }
}
