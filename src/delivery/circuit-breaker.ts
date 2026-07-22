/**
 * A three-state circuit breaker (closed -> open -> half_open -> closed).
 *
 * WHY: when a target is genuinely down, continuing to dial it (even with backoff)
 * wastes the worker pool, fills queues and inflates latency for events that were
 * never going to land. The breaker fails fast once failures cluster: it opens,
 * sheds load immediately for a cool-down, then admits a single probe to test
 * recovery before fully closing. The runtime also reads the breaker state via
 * `pressure()` and throttles arrivals while it is not closed.
 *
 * The state machine is pure over an injected clock so transitions are tested
 * without timers.
 */

import type { CircuitState } from '../types/index.js';

/** Configuration for {@link CircuitBreaker}. */
export interface CircuitBreakerOptions {
  /** Consecutive failures that trip closed -> open. */
  failureThreshold: number;
  /** Cool-down before the first half-open probe is admitted. */
  openMs: number;
  /** Concurrent probes admitted while half-open (typically 1). */
  halfOpenMaxProbes: number;
  /** Injected clock; defaults to `Date.now`. */
  now?: () => number;
}

/** The decision returned when a caller asks to pass through the breaker. */
export interface CircuitGate {
  /** Whether the send may proceed. */
  allowed: boolean;
  /** True when this send is the lone half-open recovery probe. */
  probe: boolean;
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly openMs: number;
  private readonly halfOpenMaxProbes: number;
  private readonly now: () => number;

  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAtMs = 0;
  private halfOpenProbes = 0;

  constructor(options: CircuitBreakerOptions) {
    this.failureThreshold = Math.max(1, options.failureThreshold);
    this.openMs = Math.max(0, options.openMs);
    this.halfOpenMaxProbes = Math.max(1, options.halfOpenMaxProbes);
    this.now = options.now ?? Date.now;
  }

  /** Current state, surfaced through the adapter's `pressure()` snapshot. */
  get current(): CircuitState {
    return this.state;
  }

  /**
   * Ask permission to send. When open and the cool-down has elapsed, this
   * transitions to half-open and grants exactly one probe; further callers are
   * denied until that probe resolves.
   */
  tryPass(nowMs: number = this.now()): CircuitGate {
    if (this.state === 'closed') return { allowed: true, probe: false };

    if (this.state === 'open') {
      if (nowMs - this.openedAtMs < this.openMs) return { allowed: false, probe: false };
      // Cool-down elapsed: enter half-open and let this caller be the probe.
      this.state = 'half_open';
      this.halfOpenProbes = 0;
    }

    // half_open: admit up to halfOpenMaxProbes probes, deny the rest.
    if (this.halfOpenProbes < this.halfOpenMaxProbes) {
      this.halfOpenProbes += 1;
      return { allowed: true, probe: true };
    }
    return { allowed: false, probe: false };
  }

  /** Record a successful send: any success closes the breaker and clears counts. */
  onSuccess(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.halfOpenProbes = 0;
  }

  /**
   * Record a failed send. A failure during a half-open probe re-opens
   * immediately; otherwise the breaker opens once consecutive failures reach the
   * threshold.
   */
  onFailure(nowMs: number = this.now()): void {
    this.consecutiveFailures += 1;
    if (this.state === 'half_open' || this.consecutiveFailures >= this.failureThreshold) {
      this.open(nowMs);
    }
  }

  private open(nowMs: number): void {
    this.state = 'open';
    this.openedAtMs = nowMs;
    this.halfOpenProbes = 0;
  }
}
