/**
 * A fixed-capacity circular buffer with newest-first reads.
 *
 * WHY: the telemetry frame carries the most recent events for the live ticker, and
 * the hot path must not grow an unbounded array. A ring buffer gives O(1) push and a
 * bounded footprint; once full, the oldest element is overwritten. `toArray` returns
 * newest-first because that is the order the dashboard renders (latest on top).
 */

export class RingBuffer<T> {
  private readonly buf: Array<T | undefined>;
  private readonly cap: number;
  /** Index the next push writes to. */
  private head = 0;
  /** Number of live elements, in `[0, cap]`. */
  private count = 0;

  /**
   * @param capacity Maximum retained elements. A capacity of 0 makes the buffer a
   *   no-op sink (valid when `TELEMETRY_RECENT_EVENTS` is configured to 0).
   */
  constructor(capacity: number) {
    this.cap = Math.max(0, Math.trunc(capacity));
    this.buf = new Array<T | undefined>(this.cap);
  }

  /** Append an element, evicting the oldest when at capacity. */
  push(item: T): void {
    if (this.cap === 0) return;
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.cap;
    if (this.count < this.cap) this.count += 1;
  }

  /** Number of live elements currently retained. */
  get length(): number {
    return this.count;
  }

  /** Configured capacity. */
  get capacity(): number {
    return this.cap;
  }

  /**
   * Snapshot of the live elements, newest first. Allocates a fresh array so callers
   * cannot mutate internal state.
   */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i += 1) {
      // The i-th newest sits `i` slots behind `head`; `+ cap` keeps the index
      // non-negative before the modulo (i < count <= cap guarantees this).
      const idx = (this.head - 1 - i + this.cap) % this.cap;
      const value = this.buf[idx];
      if (value !== undefined) out.push(value);
    }
    return out;
  }

  /** Drop all elements. */
  clear(): void {
    this.head = 0;
    this.count = 0;
    this.buf.fill(undefined);
  }
}
