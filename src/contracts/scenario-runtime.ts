import type {
  ChaosInjectorConfig,
  DeliveryTarget,
  RunState,
  RunSummary,
  ScenarioConfig,
  TelemetryFrame,
  Unsubscribe,
} from '../types/index.js';

/**
 * The orchestrator. Composes clock, arrival process, event generator, identity
 * pool, event bus, delivery adapter and metrics registry into a running
 * simulation, and is the system's single composition root for a run.
 *
 * Control loop each tick: advance the clock, ask the arrival process when the next
 * event is due, generate it (plus any saga follow-ons), publish to the bus (the
 * delivery adapter and metrics subscribe), read `deliveryAdapter.pressure()` and
 * throttle the arrival rate if saturated, and emit a telemetry frame every
 * METRICS_INTERVAL_MS. Chaos injectors layer extra event bursts on top.
 *
 * Only one run is active at a time; `start` rejects if a run is already running.
 */
export interface ScenarioRuntime {
  /**
   * Start a run for `scenario` streaming to `target`. Seeds the identity pool,
   * persists the run, and begins the control loop. Resolves with the initial
   * RunState once the loop is live. Rejects if a run is already active.
   */
  start(scenario: ScenarioConfig, target: DeliveryTarget): Promise<RunState>;

  /**
   * Stop the active run: halt generation, flush the delivery adapter, compute and
   * persist the RunSummary, and return it. Safe to call when idle (resolves with
   * the most recent summary or throws a clear error if none exists).
   */
  stop(): Promise<RunSummary>;

  /** Pause generation without ending the run. Delivery continues draining. */
  pause(): void;

  /** Resume a paused run. */
  resume(): void;

  /** Inject a chaos scenario into the running simulation immediately. */
  injectChaos(config: ChaosInjectorConfig): void;

  /** Current run state, or null when idle. */
  state(): RunState | null;

  /**
   * Subscribe to telemetry frames emitted every METRICS_INTERVAL_MS. The server
   * forwards these to WebSocket clients. Returns an unsubscribe function.
   */
  onFrame(handler: (frame: TelemetryFrame) => void): Unsubscribe;
}
