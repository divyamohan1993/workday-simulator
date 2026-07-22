import type {
  ActiveChaos,
  ClockState,
  DeliveryResult,
  LatencyHistogram,
  MetricSample,
  ReceiverStats,
  RunState,
  TelemetryFrame,
  WorkdayEvent,
} from '../types/index.js';

/** Runtime-supplied context folded into each telemetry frame. */
export interface FrameContext {
  clock: ClockState;
  run: RunState | null;
  activeChaos: ActiveChaos[];
  /** Monotonic frame counter. */
  frameSeq: number;
}

/**
 * Aggregates the run's live metrics. It observes generated events (subscribed to
 * the EventBus) and delivery results (from the DeliveryAdapter), maintains latency
 * histograms and rolling rates, keeps a newest-first ring buffer of recent events,
 * and assembles the telemetry frame the dashboard renders.
 *
 * All recording methods are cheap and allocation-light because they run on the hot
 * path. Histograms are computed with a bounded reservoir or fixed buckets, never an
 * unbounded array of samples.
 */
export interface MetricsRegistry {
  /** Record a generated event (updates mix counters and the recent-events ring). */
  recordEvent(event: WorkdayEvent): void;

  /** Record a delivery outcome (updates latency, error rate, delivered/failed). */
  recordDelivery(result: DeliveryResult): void;

  /** Fold in the latest receiver statistics, pulled once per frame. */
  recordReceiver(stats: ReceiverStats): void;

  /** Assemble a complete, self-contained telemetry frame. */
  snapshot(ctx: FrameContext): TelemetryFrame;

  /** Current delivery-latency histogram. */
  latency(): LatencyHistogram;

  /** Current smoothed delivered events/second. */
  currentRps(): number;

  /** Raw metric samples, for export or debugging. */
  samples(): MetricSample[];

  /** Clear all counters and buffers (used when a new run starts). */
  reset(): void;
}
