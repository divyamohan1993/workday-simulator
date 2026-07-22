/**
 * `MetricsRegistry`: the hot-path aggregator that turns the event and delivery
 * streams into the telemetry frame the dashboard renders.
 *
 * All state is in-memory and bounded, exactly as the frozen `MetricsOptions`
 * (`{ recentEventsSize }`) implies: a reservoir latency histogram, a sliding rate
 * window, cumulative counters, and a recent-events ring. There is deliberately NO
 * database handle here; run-history persistence is driven by the wired
 * `RunStore.update` checkpoint (see `run-store.ts`), because under the frozen
 * contracts the registry cannot reach SQLite and the runtime never asks it to.
 *
 * Outcome classification matches the runtime's own accounting (retried counts as
 * delivered, circuit_open as failed, dropped as dropped) so `frame.delivery.*` can
 * never disagree with `RunState.counters`. Delivery latency is recorded only for
 * successful outcomes (delivered / retried): a short-circuited or dropped request has
 * no meaningful provisioning latency and would bias the histogram toward zero.
 *
 * The recording methods run on the hot path and are O(1); the only non-trivial work
 * (sorting the reservoir) happens in `snapshot`, which runs about once per second.
 */

import type { Logger } from 'pino';
import type { MetricsOptions } from '../contracts/factories.js';
import type { FrameContext, MetricsRegistry } from '../contracts/metrics-registry.js';
import type {
  DeliveryResult,
  DeliveryStats,
  EventCategory,
  EventKind,
  LatencyHistogram,
  MetricSample,
  ReceiverStats,
  TelemetryFrame,
  WorkdayEvent,
} from '../types/index.js';
import { ALL_EVENT_CATEGORIES } from '../types/index.js';
import { createReservoirHistogram } from './histogram.js';
import { createRateWindow } from './rate-window.js';
import { RingBuffer } from './ring-buffer.js';

/**
 * Optional runtime dependencies. Kept as a second, defaulted parameter so
 * `createMetricsRegistry` still satisfies the frozen `MetricsFactory` signature
 * `(options: MetricsOptions) => MetricsRegistry` (a function with an extra optional
 * parameter is assignable to it), while tests can inject a deterministic clock/seed.
 */
export interface MetricsRuntimeDeps {
  /** Wall-clock source in epoch ms; defaults to `Date.now`. */
  now?: () => number;
  /** Reservoir sampler seed; defaults to a fixed value for reproducibility. */
  seed?: string;
  /** Seconds of history the RPS/error-rate window averages over; default 5. */
  rpsWindowSec?: number;
  /** Reservoir capacity for the latency histogram; default 4096. */
  latencyReservoirSize?: number;
  /** Structured logger; optional because the registry logs nothing on the hot path. */
  logger?: Logger;
}

/** A fully-zeroed per-category count map (all categories present, as the type requires). */
function emptyByCategory(): Record<EventCategory, number> {
  const acc = {} as Record<EventCategory, number>;
  for (const category of ALL_EVENT_CATEGORIES) acc[category] = 0;
  return acc;
}

/** A fully-zeroed receiver stat block, used until the first `recordReceiver`. */
function emptyReceiverStats(): ReceiverStats {
  return {
    queueDepth: 0,
    provisioned: 0,
    failed: 0,
    sodViolations: 0,
    orphans: 0,
    dormant: 0,
    avgProvisionMs: 0,
    byConnector: {},
    totalIngested: 0,
  };
}

/**
 * Build a metrics registry.
 *
 * @param options Frozen options; `recentEventsSize` sizes the recent-events ring.
 * @param deps Optional deterministic clock, seed, and window tuning.
 * @returns A `MetricsRegistry`.
 */
export function createMetricsRegistry(
  options: MetricsOptions,
  deps: MetricsRuntimeDeps = {},
): MetricsRegistry {
  const now = deps.now ?? Date.now;
  const seed = deps.seed ?? 'metrics';
  const histogram = createReservoirHistogram(deps.latencyReservoirSize ?? 4096, seed);
  const rateWindow = createRateWindow(deps.rpsWindowSec ?? 5);
  const recent = new RingBuffer<WorkdayEvent>(options.recentEventsSize);

  let generatedTotal = 0;
  let deliveredTotal = 0;
  let failedTotal = 0;
  let droppedTotal = 0;
  let byCategory = emptyByCategory();
  let byKind: Partial<Record<EventKind, number>> = {};
  let latestReceiver: ReceiverStats | null = null;

  return {
    recordEvent(event: WorkdayEvent): void {
      generatedTotal += 1;
      byCategory[event.category] += 1;
      byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
      recent.push(event);
    },

    recordDelivery(result: DeliveryResult): void {
      const at = now();
      switch (result.outcome) {
        case 'delivered':
        case 'retried':
          deliveredTotal += 1;
          rateWindow.record('delivered', at);
          histogram.record(result.latencyMs);
          break;
        case 'failed':
        case 'circuit_open':
          failedTotal += 1;
          rateWindow.record('failed', at);
          break;
        case 'dropped':
          droppedTotal += 1;
          rateWindow.record('dropped', at);
          break;
        default:
          break;
      }
    },

    recordReceiver(stats: ReceiverStats): void {
      latestReceiver = stats;
    },

    snapshot(ctx: FrameContext): TelemetryFrame {
      const at = now();
      const latency = histogram.snapshot();
      const currentRps = rateWindow.rps(at);
      const errorRate = rateWindow.errorRate(at);
      const receiver = latestReceiver ?? emptyReceiverStats();

      // Delivery block filled with everything the registry knows. The runtime overlays
      // targetRps, queueDepth, inFlight and circuit from the live adapter after this.
      const delivery: DeliveryStats = {
        currentRps,
        targetRps: 0,
        inFlight: 0,
        queueDepth: 0,
        circuit: 'closed',
        deliveredTotal,
        failedTotal,
        droppedTotal,
        latency,
      };

      return {
        clock: ctx.clock,
        currentRps,
        targetRps: 0,
        latency,
        errorRate,
        eventMix: { byCategory: { ...byCategory }, byKind: { ...byKind } },
        receiver,
        delivery,
        recentEvents: recent.toArray(),
        activeChaos: ctx.activeChaos,
        run: ctx.run,
        frameSeq: ctx.frameSeq,
        emittedAt: new Date(at).toISOString(),
      };
    },

    latency(): LatencyHistogram {
      return histogram.snapshot();
    },

    currentRps(): number {
      return rateWindow.rps(now());
    },

    samples(): MetricSample[] {
      const at = now();
      const ts = new Date(at).toISOString();
      const lat = histogram.snapshot();
      const out: MetricSample[] = [
        { name: 'events.generated.total', value: generatedTotal, ts },
        { name: 'delivery.delivered.total', value: deliveredTotal, ts },
        { name: 'delivery.failed.total', value: failedTotal, ts },
        { name: 'delivery.dropped.total', value: droppedTotal, ts },
        { name: 'delivery.rps.current', value: rateWindow.rps(at), ts },
        { name: 'delivery.error_rate', value: rateWindow.errorRate(at), ts },
        { name: 'delivery.latency.p50', value: lat.p50, ts },
        { name: 'delivery.latency.p95', value: lat.p95, ts },
        { name: 'delivery.latency.p99', value: lat.p99, ts },
        { name: 'delivery.latency.max', value: lat.max, ts },
        { name: 'delivery.latency.count', value: lat.count, ts },
      ];
      for (const category of ALL_EVENT_CATEGORIES) {
        out.push({ name: 'events.category.count', value: byCategory[category], ts, labels: { category } });
      }
      return out;
    },

    reset(): void {
      generatedTotal = 0;
      deliveredTotal = 0;
      failedTotal = 0;
      droppedTotal = 0;
      byCategory = emptyByCategory();
      byKind = {};
      histogram.reset();
      rateWindow.reset();
      recent.clear();
      latestReceiver = null;
    },
  };
}
