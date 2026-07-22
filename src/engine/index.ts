/**
 * The simulation engine: the accelerated workday clock, the non-homogeneous Poisson
 * arrival process, the synchronous event bus, and the scenario runtime that composes
 * them into a running simulation with chaos injection and JML lifecycle rules.
 *
 * This module fulfils the factory contracts that BUILD-CONTRACT groups under "core"
 * (clock, arrival, bus) and "runtime" (scenario runtime). The server's composition
 * root imports all four `create*` factories from HERE. The exported signatures match
 * the aliases in `src/contracts/factories.ts` exactly:
 *   createClock            : ClockFactory
 *   createArrivalProcess   : ArrivalFactory
 *   createEventBus         : EventBusFactory
 *   createScenarioRuntime  : ScenarioRuntimeFactory
 *
 * The chaos catalog and the JML state machine are exported for the REST layer
 * (GET /api/chaos/injectors) and for any consumer that needs lifecycle-transition
 * rules without reaching into the identity pool.
 */

import type {
  ArrivalFactory,
  ClockFactory,
  EventBusFactory,
  ScenarioRuntimeFactory,
} from '../contracts/factories.js';
import { createArrivalProcess } from './arrival.js';
import { createClock } from './clock.js';
import { createEventBus } from './event-bus.js';
import { createScenarioRuntime } from './scenario-runtime.js';

export { createClock } from './clock.js';
export { createArrivalProcess } from './arrival.js';
export { createEventBus } from './event-bus.js';
export { createScenarioRuntime } from './scenario-runtime.js';

// Compile-time conformance guards. The server assigns these factories to the frozen
// aliases in contracts/factories.ts; asserting assignability HERE makes any drift a
// build failure in this module rather than a surprise in the integrator's session.
const _clockFactory: ClockFactory = createClock;
const _arrivalFactory: ArrivalFactory = createArrivalProcess;
const _eventBusFactory: EventBusFactory = createEventBus;
const _scenarioRuntimeFactory: ScenarioRuntimeFactory = createScenarioRuntime;
void _clockFactory;
void _arrivalFactory;
void _eventBusFactory;
void _scenarioRuntimeFactory;

export {
  createChaosInjector,
  CHAOS_INJECTOR_CATALOG,
} from './chaos.js';
export type {
  ChaosInjector,
  ChaosContext,
  ChaosInjectorCatalogEntry,
  ChaosInjectorCatalogParam,
} from './chaos.js';

export {
  createJmlStateMachine,
  jmlStateMachine,
  isJmlKind,
  JML_TRANSITIONS,
  JML_KIND_EFFECT,
  isActiveLike,
} from './jml.js';
export type { JmlStateMachine, JmlEventKind, JmlKindEffect, TransitionPlan } from './jml.js';

// Lower-level building blocks, exported for reuse and focused testing. They are not
// part of the composition contract but are safe, dependency-light utilities.
export { diurnalShape, businessCurve, weekdayFactor, monthlyFactor, LOCATION_TIMEZONE } from './diurnal.js';
export { createPrng } from './prng.js';
export type { Prng } from './prng.js';
export { resolveMix, pickKind, mergeBiases } from './mix.js';
export type { ResolvedMix } from './mix.js';
