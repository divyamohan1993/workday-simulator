/**
 * A bounded, newest-first dead-letter buffer.
 *
 * WHY bounded and O(1): every non-delivered outcome (failed after retries,
 * dropped on overflow, shed while the circuit is open) is recorded here for
 * operator inspection. Under an overflow storm that can be a high-frequency
 * path, so the buffer overwrites its oldest slot in place, giving constant-time
 * inserts and a fixed memory ceiling. It retains a recent SAMPLE, never the full
 * (potentially unbounded) history.
 */

import type { DeliveryOutcome } from '../types/index.js';

/** One dead-lettered delivery, retained for diagnostics. */
export interface DeadLetter {
  eventId: string;
  correlationId: string;
  outcome: DeliveryOutcome;
  attempts: number;
  httpStatus?: number;
  error?: string;
  at: string;
}

export class DeadLetterBuffer {
  private readonly slots: Array<DeadLetter | undefined>;
  private writeIndex = 0;
  private count = 0;

  constructor(capacity: number) {
    this.slots = new Array<DeadLetter | undefined>(Math.max(1, capacity));
  }

  /** Record a dead letter, overwriting the oldest entry when full. */
  add(entry: DeadLetter): void {
    this.slots[this.writeIndex] = entry;
    this.writeIndex = (this.writeIndex + 1) % this.slots.length;
    if (this.count < this.slots.length) this.count += 1;
  }

  /** Total dead letters recorded (may exceed retained {@link list} length). */
  size(): number {
    return this.count;
  }

  /** The retained entries, newest first. */
  list(): DeadLetter[] {
    const out: DeadLetter[] = [];
    for (let i = 1; i <= this.count; i += 1) {
      const idx = (this.writeIndex - i + this.slots.length) % this.slots.length;
      const entry = this.slots[idx];
      if (entry) out.push(entry);
    }
    return out;
  }
}
