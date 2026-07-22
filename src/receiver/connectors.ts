/**
 * A pool of simulated downstream connectors with realistic asynchronous
 * provisioning, per-connector latency and failure, concurrency limits and the
 * backpressure that emerges from them.
 *
 * WHY it is time-driven by an injected clock rather than real timers: the whole
 * point is that when arrivals outpace a connector's drain rate, its queue deepens
 * and each task's measured latency (enqueue to completion) rises. Driving that
 * from a `pump(now)` method with an injectable `now` makes the emergent behaviour
 * deterministic and unit-testable (advance the clock, pump, observe rising
 * latency) instead of flaky and wall-clock-bound. In production a single unref'd
 * interval calls `pump(Date.now())`.
 *
 * When `simulateLatency` is false the frozen contract requires provisioning to be
 * acknowledged immediately: tasks complete on the next pump with zero latency and
 * always succeed, so the connector counters still populate for a demo without any
 * simulated delay.
 */

import type { Prng } from '../engine/prng.js';
import type { ConnectorStat } from '../types/index.js';
import { DEFAULT_CONNECTOR } from './constants.js';
import type {
  ConnectorCompletionHandler,
  ConnectorProfile,
  ProvisioningTask,
} from './types.js';

/** One in-flight task with the wall-time it is scheduled to complete. */
interface InFlight {
  task: ProvisioningTask;
  completesAtMs: number;
  ok: boolean;
}

/** Per-connector queue, in-flight set and running counters. */
interface Lane {
  profile: ConnectorProfile;
  queue: ProvisioningTask[];
  inflight: InFlight[];
  provisioned: number;
  failed: number;
  sumLatencyMs: number;
  completed: number;
}

/** Options for {@link createConnectorPool}. */
export interface ConnectorPoolOptions {
  profiles: readonly ConnectorProfile[];
  prng: Prng;
  /** When false, tasks complete immediately with zero latency and always succeed. */
  simulateLatency: boolean;
  /** Fired on every completion; used by the engine for global accounting. */
  onComplete?: ConnectorCompletionHandler;
}

/** The connector pool surface consumed by the engine. */
export interface ConnectorPool {
  /** Route a task to its connector's queue (falls back to the default connector). */
  submit(task: ProvisioningTask): void;
  /** Advance all connectors to `nowMs`: complete due work, start queued work. */
  pump(nowMs: number): void;
  /** Total queued + in-flight tasks across all connectors. */
  queueDepth(): number;
  /** Per-connector statistics for the telemetry frame. */
  stats(): Record<string, ConnectorStat>;
  /** Aggregate totals across all connectors. */
  totals(): { provisioned: number; failed: number; avgProvisionMs: number; queueDepth: number };
  /** The connector a task with this system/name would be routed to. */
  resolveConnector(name: string): string;
  /** Clear all queues, in-flight work and counters. */
  reset(): void;
}

/**
 * Build a connector pool from a set of profiles.
 *
 * @param options Profiles, seeded PRNG, latency mode and completion hook.
 * @returns The pool.
 */
export function createConnectorPool(options: ConnectorPoolOptions): ConnectorPool {
  const { prng, simulateLatency, onComplete } = options;
  const lanes = new Map<string, Lane>();
  for (const profile of options.profiles) {
    lanes.set(profile.name, {
      profile,
      queue: [],
      inflight: [],
      provisioned: 0,
      failed: 0,
      sumLatencyMs: 0,
      completed: 0,
    });
  }
  // Guarantee a default lane so an unroutable task is never dropped on the floor.
  const defaultLane = lanes.get(DEFAULT_CONNECTOR) ?? lanes.values().next().value;
  if (!defaultLane) {
    throw new Error('createConnectorPool requires at least one connector profile');
  }

  const laneFor = (connector: string): Lane => lanes.get(connector) ?? defaultLane;

  const decideOutcome = (profile: ConnectorProfile): { latencyMs: number; ok: boolean } => {
    if (!simulateLatency) return { latencyMs: 0, ok: true };
    const span = Math.max(0, profile.maxLatencyMs - profile.minLatencyMs);
    const latencyMs = Math.round(profile.minLatencyMs + prng.next() * span);
    const ok = !prng.bool(profile.failureRate);
    return { latencyMs, ok };
  };

  const complete = (lane: Lane, task: ProvisioningTask, ok: boolean, completesAtMs: number): void => {
    const latencyMs = Math.max(0, completesAtMs - task.enqueuedAtMs);
    if (ok) lane.provisioned += 1;
    else lane.failed += 1;
    lane.sumLatencyMs += latencyMs;
    lane.completed += 1;
    onComplete?.(task, ok, latencyMs);
  };

  const startTask = (lane: Lane, task: ProvisioningTask, nowMs: number): void => {
    const { latencyMs, ok } = decideOutcome(lane.profile);
    const completesAtMs = nowMs + latencyMs;
    if (completesAtMs <= nowMs) {
      // Zero-latency task completes within this same pump (frees no slot).
      complete(lane, task, ok, completesAtMs);
    } else {
      lane.inflight.push({ task, completesAtMs, ok });
    }
  };

  return {
    submit(task: ProvisioningTask): void {
      laneFor(task.connector).queue.push(task);
    },

    pump(nowMs: number): void {
      for (const lane of lanes.values()) {
        if (lane.inflight.length > 0) {
          const still: InFlight[] = [];
          for (const f of lane.inflight) {
            if (f.completesAtMs <= nowMs) complete(lane, f.task, f.ok, f.completesAtMs);
            else still.push(f);
          }
          lane.inflight = still;
        }
        while (lane.inflight.length < lane.profile.concurrency && lane.queue.length > 0) {
          const task = lane.queue.shift();
          if (task) startTask(lane, task, nowMs);
        }
      }
    },

    queueDepth(): number {
      let depth = 0;
      for (const lane of lanes.values()) depth += lane.queue.length + lane.inflight.length;
      return depth;
    },

    stats(): Record<string, ConnectorStat> {
      const out: Record<string, ConnectorStat> = {};
      for (const [name, lane] of lanes.entries()) {
        out[name] = {
          connector: name,
          provisioned: lane.provisioned,
          failed: lane.failed,
          avgProvisionMs: lane.completed > 0 ? Math.round(lane.sumLatencyMs / lane.completed) : 0,
          queueDepth: lane.queue.length + lane.inflight.length,
        };
      }
      return out;
    },

    totals(): { provisioned: number; failed: number; avgProvisionMs: number; queueDepth: number } {
      let provisioned = 0;
      let failed = 0;
      let sumLatencyMs = 0;
      let completed = 0;
      let queueDepth = 0;
      for (const lane of lanes.values()) {
        provisioned += lane.provisioned;
        failed += lane.failed;
        sumLatencyMs += lane.sumLatencyMs;
        completed += lane.completed;
        queueDepth += lane.queue.length + lane.inflight.length;
      }
      return {
        provisioned,
        failed,
        avgProvisionMs: completed > 0 ? Math.round(sumLatencyMs / completed) : 0,
        queueDepth,
      };
    },

    resolveConnector(name: string): string {
      return lanes.has(name) ? name : defaultLane.profile.name;
    },

    reset(): void {
      for (const lane of lanes.values()) {
        lane.queue = [];
        lane.inflight = [];
        lane.provisioned = 0;
        lane.failed = 0;
        lane.sumLatencyMs = 0;
        lane.completed = 0;
      }
    },
  };
}
