/**
 * The scenario runtime: the closed-loop control that composes clock, arrival
 * process, event generator, identity pool, event bus, delivery adapter, metrics and
 * chaos injectors into a running simulation.
 *
 * Control loop each tick (real cadence TICK_MS):
 * 1. advance the accelerated clock by the real time since the previous tick;
 * 2. update chaos: activate injectors whose window has opened, run their bursts, and
 *    recompute the active-chaos set, rate multiplier and mix bias;
 * 3. read the delivery adapter's backpressure and derive an arrival throttle (the
 *    only closed-loop control in the system);
 * 4. generate every event now due under the shaped, chaos-scaled, throttled rate,
 *    publish each to the bus (delivery and metrics are subscribed) and chain saga
 *    follow-ons;
 * 5. emit a telemetry frame every METRICS_INTERVAL_MS and persist run state
 *    periodically.
 *
 * Exactly one run is active at a time. Determinism comes from a single run seed that
 * reseeds the identity pool and the arrival process and seeds the runtime's own PRNG
 * for kind selection and chaos targeting.
 *
 * Two deliberate boundary notes, forced by the frozen dependency shape:
 * - The event generator exposes no reseed, so per-run determinism covers the pool,
 *   the arrival process and this module's PRNG; the generator keeps its construction
 *   seed. The server can construct the generator with the run seed if strict
 *   per-scenario generator determinism is required.
 * - There is no receiver reference here, so receiver statistics are folded into the
 *   frame by whatever calls metrics.recordReceiver (the server). Frames and the
 *   summary carry the latest receiver stats the metrics registry has been given.
 */

import { nanoid } from 'nanoid';
import type { ArrivalProcess } from '../contracts/arrival.js';
import type { Clock } from '../contracts/clock.js';
import type { DeliveryAdapter } from '../contracts/delivery-adapter.js';
import type { GenerationContext } from '../contracts/event-generator.js';
import type { RuntimeDependencies } from '../contracts/factories.js';
import type { ScenarioRuntime } from '../contracts/scenario-runtime.js';
import type {
  ActiveChaos,
  ChaosInjectorConfig,
  ChaosInjectorKind,
  DeliveryResult,
  DeliveryStats,
  DeliveryTarget,
  Employee,
  EventCategory,
  EventKind,
  RunCounters,
  RunState,
  RunSummary,
  ScenarioConfig,
  TelemetryFrame,
  Unsubscribe,
  WorkdayEvent,
} from '../types/index.js';
import { ALL_EVENT_CATEGORIES } from '../types/index.js';
import type { ChaosContext, ChaosInjector } from './chaos.js';
import { createChaosInjector } from './chaos.js';
import { mergeBiases, pickKind, resolveMix, type ResolvedMix } from './mix.js';
import { createPrng, type Prng } from './prng.js';

/** Real-time tick cadence. Small enough for smooth pacing, large enough to be cheap. */
const TICK_MS = 25;

/** How often run state is written back to the store (not per event: sqlite friendly). */
const PERSIST_INTERVAL_MS = 1000;

/** Everything that lives for the duration of one run. */
interface ActiveRun {
  runState: RunState;
  scenario: ScenarioConfig;
  target: DeliveryTarget;
  clock: Clock;
  arrival: ArrivalProcess;
  adapter: DeliveryAdapter;
  prng: Prng;
  seq: number;
  byKind: Partial<Record<EventKind, number>>;
  injectors: ChaosInjector[];
  resolvedMix: ResolvedMix;
  lastActiveKeys: string;
  activeChaosKinds: ChaosInjectorKind[];
  throttle: number;
  chaosRateMultiplier: number;
  targetRps: number;
  currentRps: number;
  effMaxRps: number;
  maxEventsPerTick: number;
  nextArrivalWall: number;
  lastTickWall: number;
  lastFrameWall: number;
  lastPersistWall: number;
  startWallMs: number;
  frameSeq: number;
  paused: boolean;
  interval: ReturnType<typeof setInterval> | null;
  unsubscribers: Unsubscribe[];
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Zeroed per-category counter record in the frozen category order. */
function zeroByCategory(): Record<EventCategory, number> {
  const record = {} as Record<EventCategory, number>;
  for (const category of ALL_EVENT_CATEGORIES) record[category] = 0;
  return record;
}

function emptyCounters(): RunCounters {
  return { generated: 0, delivered: 0, failed: 0, dropped: 0, byCategory: zeroByCategory() };
}

/**
 * Translate delivery backpressure into an arrival throttle in [0, 1]. Full rate below
 * half the queue high-water mark, a linear ramp down to a small floor as the queue
 * fills, near-pause when the circuit is open, and a hard cap when the adapter reports
 * saturation. This is the system's only closed-loop safety valve.
 */
function pressureToThrottle(circuit: string, queueDepth: number, highWater: number, saturated: boolean): number {
  if (circuit === 'open') return 0.02;
  const hw = highWater > 0 ? highWater : 1;
  const ratio = queueDepth / hw;
  let throttle: number;
  if (ratio <= 0.5) throttle = 1;
  else if (ratio >= 1) throttle = 0.05;
  else throttle = 1 - ((ratio - 0.5) / 0.5) * 0.95;
  if (saturated) throttle = Math.min(throttle, 0.1);
  return throttle;
}

/**
 * Create the scenario runtime. The returned object is the single composition root for
 * a run and is safe to hold as a server-scoped singleton; it manages at most one run.
 */
export function createScenarioRuntime(deps: RuntimeDependencies): ScenarioRuntime {
  const { config, logger, bus, pool, generator, metrics, stores, deliveryFactory, createClock, createArrival } = deps;

  let active: ActiveRun | null = null;
  let lastSummary: RunSummary | null = null;
  let finishing: Promise<RunSummary> | null = null;
  const frameHandlers = new Set<(frame: TelemetryFrame) => void>();

  /* --- Run-state helpers --------------------------------------------------- */

  const snapshotRunState = (run: ActiveRun): RunState => ({
    ...run.runState,
    counters: { ...run.runState.counters, byCategory: { ...run.runState.counters.byCategory } },
    activeChaos: [...run.runState.activeChaos],
  });

  const persistRunState = (run: ActiveRun): void => {
    stores.runs.update(run.runState.id, {
      status: run.runState.status,
      elapsedSec: run.runState.elapsedSec,
      currentRps: run.runState.currentRps,
      targetRps: run.runState.targetRps,
      endedAt: run.runState.endedAt,
      error: run.runState.error,
      counters: { ...run.runState.counters, byCategory: { ...run.runState.counters.byCategory } },
      activeChaos: [...run.runState.activeChaos],
    });
  };

  /* --- Emission and generation --------------------------------------------- */

  const emitEvent = (run: ActiveRun, event: WorkdayEvent): void => {
    bus.publish(event);
    const counters = run.runState.counters;
    counters.generated += 1;
    counters.byCategory[event.category] = (counters.byCategory[event.category] ?? 0) + 1;
    run.byKind[event.kind] = (run.byKind[event.kind] ?? 0) + 1;
  };

  const makeGenCtx = (run: ActiveRun): GenerationContext => ({
    clock: run.clock,
    pool,
    runId: run.runState.id,
    nextSeq: () => {
      run.seq += 1;
      return run.seq;
    },
    correlationId: undefined,
    causationId: undefined,
    activeChaos: run.activeChaosKinds,
  });

  const safeGenerate = (run: ActiveRun, kind: EventKind): WorkdayEvent | null => {
    try {
      return generator.generate(kind, makeGenCtx(run));
    } catch (err) {
      logger.debug({ err, kind }, 'generator.generate failed; skipping this arrival');
      return null;
    }
  };

  const safeSaga = (run: ActiveRun, primary: WorkdayEvent): WorkdayEvent[] => {
    try {
      return generator.saga(primary, makeGenCtx(run));
    } catch (err) {
      logger.debug({ err, kind: primary.kind }, 'generator.saga failed; no follow-ons');
      return [];
    }
  };

  const sampleEmployees = (count: number, predicate?: (employee: Employee) => boolean): Employee[] => {
    const out: Employee[] = [];
    const seen = new Set<string>();
    const maxAttempts = count * 20 + 50;
    for (let i = 0; i < maxAttempts && out.length < count; i += 1) {
      const employee = pool.pick(predicate);
      if (!employee) break;
      if (seen.has(employee.id)) continue;
      seen.add(employee.id);
      out.push(employee);
    }
    return out;
  };

  const makeChaosCtx = (run: ActiveRun): ChaosContext => ({
    pool,
    prng: run.prng,
    logger,
    activeChaosKinds: run.activeChaosKinds,
    generate: (kind) => safeGenerate(run, kind),
    emit: (event) => emitEvent(run, event),
    sampleEmployees,
  });

  const creditAmbientChaos = (run: ActiveRun, kind: EventKind): void => {
    const elapsed = run.runState.elapsedSec;
    for (const injector of run.injectors) {
      if (injector.isActive(elapsed)) injector.creditAmbient(kind);
    }
  };

  const clampRate = (run: ActiveRun, rate: number): number => {
    if (!Number.isFinite(rate) || rate <= 0) return 0;
    return rate > run.effMaxRps ? run.effMaxRps : rate;
  };

  /* --- Chaos maintenance --------------------------------------------------- */

  const updateChaos = (run: ActiveRun, elapsedSec: number, tickDeltaMs: number, runBursts: boolean): void => {
    const activeKinds: ChaosInjectorKind[] = [];
    for (const injector of run.injectors) {
      if (injector.isActive(elapsedSec) && !activeKinds.includes(injector.kind)) {
        activeKinds.push(injector.kind);
      }
    }
    run.activeChaosKinds = activeKinds;
    run.runState.activeChaos = activeKinds;

    // Run injector ticks after the active set is published so bursts and any ambient
    // generation they trigger see the correct activeChaos in the generation context.
    // Skipped while paused: a paused run must not emit chaos bursts either.
    if (runBursts) {
      const ctx = makeChaosCtx(run);
      for (const injector of run.injectors) injector.tick(ctx, elapsedSec, tickDeltaMs);
    }

    let multiplier = 1;
    for (const injector of run.injectors) multiplier *= injector.rateMultiplier(elapsedSec);
    run.chaosRateMultiplier = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;

    const key = [...activeKinds].sort().join(',');
    if (key !== run.lastActiveKeys) {
      run.lastActiveKeys = key;
      const biasMaps = run.injectors
        .filter((injector) => injector.isActive(elapsedSec))
        .map((injector) => injector.mixBias(elapsedSec));
      const merged = mergeBiases(biasMaps);
      run.resolvedMix = resolveMix(run.scenario.eventMix, merged.size > 0 ? merged : undefined);
    }
  };

  const generateDueEvents = (run: ActiveRun, wallNow: number): void => {
    let produced = 0;
    while (run.nextArrivalWall <= wallNow && produced < run.maxEventsPerTick) {
      const kind = pickKind(run.prng, run.resolvedMix);
      if (kind) {
        const primary = safeGenerate(run, kind);
        if (primary) {
          emitEvent(run, primary);
          creditAmbientChaos(run, primary.kind);
          for (const follow of safeSaga(run, primary)) emitEvent(run, follow);
        }
      }
      produced += 1;

      const baseGap = run.arrival.nextInterArrivalMs(run.clock.now(), run.throttle);
      const gap = run.chaosRateMultiplier > 1 ? baseGap / run.chaosRateMultiplier : baseGap;
      const safeGap = Number.isFinite(gap) && gap >= 0 ? gap : 1000;
      // Floor the gap at the maxRps period so chaos raises the ambient rate UP TO
      // maxRps and no further. This enforces the frozen ScenarioConfig.maxRps as a
      // hard ceiling on the continuous stream (the arrival already clamps rateAt, but
      // the chaos multiplier divides the gap) and keeps the realized rate at or below
      // the reported targetRps. It also guarantees the anchor advances strictly, since
      // effMaxRps >= 1 makes minGap positive. Discrete chaos bursts are exempt by
      // design; the delivery queue's overflow policy absorbs those shocks.
      const minGap = 1000 / run.effMaxRps;
      run.nextArrivalWall += Math.max(safeGap, minGap);
    }
    // If the per-tick cap was hit while still behind, drop the backlog rather than
    // letting it spiral; sustained overload is already bounded to maxRps by clamping.
    if (produced >= run.maxEventsPerTick && run.nextArrivalWall < wallNow) {
      run.nextArrivalWall = wallNow;
    }
  };

  /* --- Frame emission ------------------------------------------------------ */

  const buildFrame = (run: ActiveRun): TelemetryFrame => {
    run.frameSeq += 1;
    const activeChaos: ActiveChaos[] = run.injectors
      .filter((injector) => injector.isActive(run.runState.elapsedSec) || injector.eventsInjected > 0)
      .map((injector) => injector.toActiveChaos(run.startWallMs));

    const frame = metrics.snapshot({
      clock: run.clock.state(),
      run: snapshotRunState(run),
      activeChaos,
      frameSeq: run.frameSeq,
    });

    // Overlay live delivery numbers the metrics registry cannot know. Clone rather
    // than mutate: the snapshot may share internal references with the registry.
    const bp = run.adapter.pressure();
    return {
      ...frame,
      targetRps: run.runState.targetRps,
      delivery: {
        ...frame.delivery,
        targetRps: run.runState.targetRps,
        queueDepth: bp.queueDepth,
        inFlight: bp.inFlight,
        circuit: bp.circuit,
      },
    };
  };

  const emitFrame = (run: ActiveRun): void => {
    const frame = buildFrame(run);
    for (const handler of frameHandlers) {
      try {
        handler(frame);
      } catch (err) {
        logger.error({ err }, 'telemetry frame handler threw; isolated');
      }
    }
  };

  /* --- Delivery result accounting ------------------------------------------ */

  const applyResult = (run: ActiveRun, result: DeliveryResult): void => {
    const counters = run.runState.counters;
    switch (result.outcome) {
      case 'delivered':
      case 'retried':
        counters.delivered += 1;
        break;
      case 'failed':
      case 'circuit_open':
        counters.failed += 1;
        break;
      case 'dropped':
        counters.dropped += 1;
        break;
      default:
        break;
    }
  };

  /* --- Summary and finalization -------------------------------------------- */

  const buildSummary = (run: ActiveRun, status: RunState['status']): RunSummary => {
    const snap = metrics.snapshot({
      clock: run.clock.state(),
      run: null,
      activeChaos: [],
      frameSeq: run.frameSeq,
    });
    const bp = run.adapter.pressure();
    const delivery: DeliveryStats = {
      ...snap.delivery,
      targetRps: 0,
      queueDepth: bp.queueDepth,
      inFlight: bp.inFlight,
      circuit: bp.circuit,
    };
    const chaosFired: ActiveChaos[] = run.injectors
      .filter((injector) => injector.eventsInjected > 0 || injector.hasExpired(run.runState.elapsedSec))
      .map((injector) => injector.toActiveChaos(run.startWallMs));

    return {
      runId: run.runState.id,
      scenarioId: run.runState.scenarioId,
      targetId: run.runState.targetId,
      status,
      startedAt: run.runState.startedAt ?? new Date(run.startWallMs).toISOString(),
      endedAt: run.runState.endedAt ?? new Date().toISOString(),
      durationSec: run.runState.elapsedSec,
      totals: { ...run.runState.counters, byCategory: { ...run.runState.counters.byCategory } },
      byKind: { ...run.byKind },
      latency: metrics.latency(),
      errorRate: snap.errorRate,
      delivery,
      receiver: snap.receiver,
      chaosFired,
      seed: run.runState.seed,
    };
  };

  const doFinalize = async (run: ActiveRun, status: 'completed' | 'failed', error?: unknown): Promise<RunSummary> => {
    if (run.interval) {
      clearInterval(run.interval);
      run.interval = null;
    }
    run.runState.status = 'stopping';

    // Flush BEFORE unsubscribing the result handler so that delivery results from
    // in-flight requests draining during the flush are still counted. Generation has
    // already stopped (the interval is cleared), so no new events reach the bus.
    try {
      await run.adapter.flush();
    } catch (err) {
      logger.warn({ err }, 'delivery adapter flush failed during finalize');
    }

    for (const unsubscribe of run.unsubscribers) {
      try {
        unsubscribe();
      } catch (err) {
        logger.debug({ err }, 'unsubscribe during finalize failed');
      }
    }
    run.unsubscribers = [];

    try {
      await run.adapter.stop();
    } catch (err) {
      logger.warn({ err }, 'delivery adapter stop failed during finalize');
    }

    const endWall = Date.now();
    run.runState.status = status;
    run.runState.endedAt = new Date(endWall).toISOString();
    run.runState.elapsedSec = (endWall - run.startWallMs) / 1000;
    run.currentRps = metrics.currentRps();
    run.runState.currentRps = run.currentRps;
    run.runState.targetRps = 0;
    if (error !== undefined) run.runState.error = errorMessage(error);

    const summary = buildSummary(run, status);

    try {
      persistRunState(run);
      stores.runs.saveSummary(summary);
    } catch (err) {
      logger.error({ err }, 'failed to persist run finalization');
    }

    try {
      emitFrame(run);
    } catch (err) {
      logger.debug({ err }, 'final frame emission failed');
    }

    lastSummary = summary;
    active = null;
    logger.info({ runId: summary.runId, status, durationSec: summary.durationSec }, 'run finalized');
    return summary;
  };

  const finish = (run: ActiveRun, status: 'completed' | 'failed', error?: unknown): Promise<RunSummary> => {
    if (finishing) return finishing;
    finishing = doFinalize(run, status, error).finally(() => {
      finishing = null;
    });
    return finishing;
  };

  /* --- The tick ------------------------------------------------------------ */

  const tick = (run: ActiveRun): void => {
    const wallNow = Date.now();
    const delta = wallNow - run.lastTickWall;
    run.lastTickWall = wallNow;
    run.clock.advance(delta);

    const elapsedSec = (wallNow - run.startWallMs) / 1000;
    run.runState.elapsedSec = elapsedSec;

    updateChaos(run, elapsedSec, delta, !run.paused);

    const bp = run.adapter.pressure();
    run.throttle = pressureToThrottle(bp.circuit, bp.queueDepth, bp.highWater, bp.saturated);

    const simNow = run.clock.now();
    run.targetRps = clampRate(run, run.arrival.rateAt(simNow) * run.chaosRateMultiplier);

    if (run.paused) {
      run.nextArrivalWall = wallNow;
    } else {
      generateDueEvents(run, wallNow);
    }

    run.currentRps = metrics.currentRps();
    run.runState.currentRps = run.currentRps;
    run.runState.targetRps = run.paused ? 0 : run.targetRps;

    if (wallNow - run.lastFrameWall >= config.METRICS_INTERVAL_MS) {
      run.lastFrameWall = wallNow;
      emitFrame(run);
    }
    if (wallNow - run.lastPersistWall >= PERSIST_INTERVAL_MS) {
      run.lastPersistWall = wallNow;
      persistRunState(run);
    }

    if (run.scenario.durationSec !== undefined && elapsedSec >= run.scenario.durationSec && !finishing) {
      void finish(run, 'completed');
    }
  };

  const scheduleTick = (run: ActiveRun): void => {
    run.interval = setInterval(() => {
      if (active !== run) return;
      try {
        tick(run);
      } catch (err) {
        logger.error({ err }, 'runtime tick failed; finalizing run as failed');
        void finish(run, 'failed', err);
      }
    }, TICK_MS);
  };

  /* --- Public surface ------------------------------------------------------ */

  const start = async (scenario: ScenarioConfig, target: DeliveryTarget): Promise<RunState> => {
    if (active) {
      throw new Error('a run is already active; stop it before starting another');
    }

    const seed = scenario.seed && scenario.seed.length > 0 ? scenario.seed : config.SEED;
    const effMaxRps = Math.max(1, Math.min(scenario.maxRps, config.MAX_RPS));

    // Reset all deterministic state for a reproducible run.
    pool.seed(config.IDENTITY_POOL_SIZE, seed);
    metrics.reset();

    const parsedStart = scenario.startSimTime ? Date.parse(scenario.startSimTime) : Number.NaN;
    const startSimEpochMs = Number.isFinite(parsedStart) ? parsedStart : Date.now();

    const clock = createClock({ accel: scenario.workdayAccel, startSimEpochMs });
    const arrival = createArrival({
      baselineRps: scenario.baselineRps,
      maxRps: effMaxRps,
      timezoneWeights: scenario.timezoneWeights,
      seed,
    });
    const adapter = deliveryFactory.create(target);

    const runId = nanoid();
    const startWallMs = Date.now();
    const runState: RunState = {
      id: runId,
      scenarioId: scenario.id,
      targetId: target.id,
      status: 'starting',
      startedAt: new Date(startWallMs).toISOString(),
      elapsedSec: 0,
      currentRps: 0,
      targetRps: 0,
      counters: emptyCounters(),
      activeChaos: [],
      seed,
    };

    const injectors = scenario.chaos
      .filter((chaosConfig) => chaosConfig.enabled !== false)
      .map((chaosConfig) => createChaosInjector(chaosConfig));

    const run: ActiveRun = {
      runState,
      scenario,
      target,
      clock,
      arrival,
      adapter,
      prng: createPrng(`${seed} engine`),
      seq: 0,
      byKind: {},
      injectors,
      resolvedMix: resolveMix(scenario.eventMix),
      lastActiveKeys: '',
      activeChaosKinds: [],
      throttle: 1,
      chaosRateMultiplier: 1,
      targetRps: 0,
      currentRps: 0,
      effMaxRps,
      maxEventsPerTick: Math.max(1, Math.ceil((effMaxRps * TICK_MS) / 1000) + 16),
      nextArrivalWall: startWallMs,
      lastTickWall: startWallMs,
      lastFrameWall: startWallMs,
      lastPersistWall: startWallMs,
      startWallMs,
      frameSeq: 0,
      paused: false,
      interval: null,
      unsubscribers: [],
    };

    active = run;
    finishing = null;

    try {
      stores.runs.create(runState);
    } catch (err) {
      active = null;
      throw new Error(`failed to persist new run: ${errorMessage(err)}`);
    }

    // Wire delivery and metrics to the bus, and delivery results back to both metrics
    // and the run counters. The runtime owns these subscriptions for the run lifetime.
    run.unsubscribers.push(
      bus.subscribe((event) => {
        adapter.submit(event);
      }),
      bus.subscribe((event) => {
        metrics.recordEvent(event);
      }),
      adapter.onResult((result) => {
        metrics.recordDelivery(result);
        if (active === run) applyResult(run, result);
      }),
    );

    try {
      await adapter.start();
    } catch (err) {
      for (const unsubscribe of run.unsubscribers) {
        try {
          unsubscribe();
        } catch {
          // best effort during failed startup
        }
      }
      run.unsubscribers = [];
      try {
        await adapter.stop();
      } catch {
        // best effort
      }
      runState.status = 'failed';
      runState.error = errorMessage(err);
      runState.endedAt = new Date().toISOString();
      try {
        persistRunState(run);
      } catch {
        // best effort
      }
      active = null;
      throw new Error(`delivery adapter failed to start: ${errorMessage(err)}`);
    }

    runState.status = 'running';
    // Anchor timing to the moment generation actually begins, so the async adapter
    // start does not count as elapsed simulated time or produce a catch-up burst.
    const beginWall = Date.now();
    run.startWallMs = beginWall;
    run.lastTickWall = beginWall;
    run.nextArrivalWall = beginWall;
    run.lastFrameWall = beginWall;
    run.lastPersistWall = beginWall;
    runState.startedAt = new Date(beginWall).toISOString();

    try {
      persistRunState(run);
    } catch (err) {
      logger.warn({ err }, 'failed to persist running run state');
    }

    scheduleTick(run);
    logger.info({ runId, scenarioId: scenario.id, targetId: target.id, seed }, 'run started');
    return snapshotRunState(run);
  };

  const stop = async (): Promise<RunSummary> => {
    if (!active) {
      if (finishing) return finishing;
      if (lastSummary) return lastSummary;
      throw new Error('no active run and no previous run summary exists');
    }
    return finish(active, 'completed');
  };

  const pause = (): void => {
    if (!active || active.runState.status !== 'running') return;
    active.paused = true;
    active.runState.status = 'paused';
    active.runState.targetRps = 0;
    persistRunState(active);
    logger.info({ runId: active.runState.id }, 'run paused');
  };

  const resume = (): void => {
    if (!active || active.runState.status !== 'paused') return;
    active.paused = false;
    active.runState.status = 'running';
    const now = Date.now();
    active.nextArrivalWall = now;
    active.lastTickWall = now;
    persistRunState(active);
    logger.info({ runId: active.runState.id }, 'run resumed');
  };

  const injectChaos = (chaosConfig: ChaosInjectorConfig): void => {
    if (!active || (active.runState.status !== 'running' && active.runState.status !== 'paused')) {
      throw new Error('cannot inject chaos: no active run');
    }
    // Normalize startAtSec to be relative to now, so an ad-hoc injection fires
    // immediately (or after its own offset) regardless of how long the run has run.
    const normalized: ChaosInjectorConfig = {
      ...chaosConfig,
      enabled: chaosConfig.enabled !== false,
      startAtSec: active.runState.elapsedSec + (chaosConfig.startAtSec ?? 0),
      params: chaosConfig.params ?? {},
    };
    active.injectors.push(createChaosInjector(normalized));
    // Force a mix recompute on the next tick so the new bias takes effect at once.
    active.lastActiveKeys = ' dirty';
    logger.info({ kind: chaosConfig.kind, intensity: chaosConfig.intensity }, 'chaos injected');
  };

  const state = (): RunState | null => (active ? snapshotRunState(active) : null);

  const onFrame = (handler: (frame: TelemetryFrame) => void): Unsubscribe => {
    frameHandlers.add(handler);
    return () => {
      frameHandlers.delete(handler);
    };
  };

  return { start, stop, pause, resume, injectChaos, state, onFrame };
}
