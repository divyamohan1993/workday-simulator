import type {
  ChaosInjectorConfig,
  ChaosInjectorKind,
  DeliveryAuthConfig,
  DeliveryKind,
  DeliveryRetryPolicy,
  EventMixWeights,
  TimezoneWeights,
} from '@/types/api';

/**
 * Request/response shapes that `web/src/types/api.ts` (the frozen mirror) does
 * not model: the mutating request bodies and a few small endpoint responses.
 * These intentionally live here, not in api.ts, because they describe the REST
 * transport (inputs and ad-hoc responses), not the shared domain model. They
 * mirror the zod schemas in `src/contracts/validation.ts`.
 */

/** Body of POST/PUT /api/scenarios (server assigns id + timestamps). */
export interface ScenarioInput {
  name: string;
  description?: string;
  baselineRps: number;
  maxRps: number;
  workdayAccel?: number;
  startSimTime?: string;
  timezoneWeights?: TimezoneWeights;
  eventMix?: EventMixWeights;
  chaos?: ChaosInjectorConfig[];
  targetId: string;
  durationSec?: number;
  seed?: string;
}

/** Body of POST/PUT /api/targets (server assigns id, builtIn, timestamps). */
export interface DeliveryTargetInput {
  name: string;
  kind: DeliveryKind;
  url: string;
  auth: DeliveryAuthConfig;
  headers?: Record<string, string>;
  rateLimit?: { rps: number; burst: number };
  concurrency?: number;
  retry?: DeliveryRetryPolicy;
  queueHighWater?: number;
  overflowPolicy?: 'block' | 'drop_new' | 'drop_oldest';
  batchSize?: number;
  natsSubject?: string;
}

/** Body of POST /api/runs. */
export interface RunStartInput {
  scenarioId: string;
  targetId?: string;
}

/** GET /api/config response (no secrets). Also the auth-gate validation probe. */
export interface AppConfigResponse {
  port: number;
  defaultTargetKind: DeliveryKind;
  workdayAccel: number;
  maxRps: number;
  metricsIntervalMs: number;
  natsEnabled: boolean;
  identityPoolSize: number;
  version: string;
}

export type ChaosParamType = 'number' | 'string' | 'boolean';

/** One tunable knob of a chaos injector, as advertised by the backend. */
export interface ChaosParamDef {
  name: string;
  type: ChaosParamType;
  default: number | string | boolean;
}

/** GET /api/chaos/injectors item. */
export interface ChaosInjectorDef {
  kind: ChaosInjectorKind;
  description: string;
  params: ChaosParamDef[];
}

/** POST /api/targets/:id/test response. */
export interface TestConnectionResult {
  ok: boolean;
  latencyMs?: number;
  httpStatus?: number;
  error?: string;
}

/** POST /api/runs/:id/chaos response. */
export interface ChaosInjectResult {
  injected: number;
}

/** Query params for list endpoints. */
export interface ListParams {
  limit?: number;
  offset?: number;
}
