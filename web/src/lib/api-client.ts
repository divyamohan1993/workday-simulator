import type {
  DeliveryTarget,
  IdentityPoolStats,
  Paginated,
  ReceiverStats,
  RunState,
  RunSummary,
  ScenarioConfig,
  TelemetryFrame,
  WorkdayEvent,
} from '@/types/api';
import type {
  AppConfigResponse,
  ChaosInjectorDef,
  ChaosInjectResult,
  DeliveryTargetInput,
  ListParams,
  RunStartInput,
  ScenarioInput,
  TestConnectionResult,
} from '@/lib/api-types';
import type { ChaosInjectorConfig } from '@/types/api';

/**
 * Typed REST client for the simulator control plane. One transport with uniform
 * error handling; every method is a thin, named wrapper so call sites read like
 * the REST contract in `docs/BUILD-CONTRACT.md`.
 *
 * Design:
 * - The token is read lazily via `getToken()` so a re-auth updates every future
 *   request without re-wiring call sites.
 * - Any 401 invokes `onUnauthorized` so the app can drop back to the auth gate
 *   exactly once, from a single place.
 * - `fetchImpl` is injectable so the client is unit tested without a network.
 */

export interface ApiClientConfig {
  /** Origin prefix; empty string means same-origin (Vite proxies in dev). */
  baseUrl?: string;
  getToken: () => string | null;
  onUnauthorized?: (status: number) => void;
  fetchImpl?: typeof fetch;
}

/** Structured client-side error carrying the server's uniform error body. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly details?: unknown;

  constructor(args: {
    message: string;
    status: number;
    code: string;
    requestId?: string;
    details?: unknown;
  }) {
    super(args.message);
    this.name = 'ApiError';
    this.status = args.status;
    this.code = args.code;
    this.requestId = args.requestId;
    this.details = args.details;
  }

  /** True for the 3-strike IP throttle escalation (contract section 5). */
  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  /** Skip the Authorization header (health checks are public). */
  anonymous?: boolean;
}

export interface ApiClient {
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  getConfig(signal?: AbortSignal): Promise<AppConfigResponse>;

  listScenarios(params?: ListParams, signal?: AbortSignal): Promise<Paginated<ScenarioConfig>>;
  getScenario(id: string, signal?: AbortSignal): Promise<ScenarioConfig>;
  createScenario(input: ScenarioInput): Promise<ScenarioConfig>;
  updateScenario(id: string, input: ScenarioInput): Promise<ScenarioConfig>;
  deleteScenario(id: string): Promise<void>;

  listTargets(params?: ListParams, signal?: AbortSignal): Promise<Paginated<DeliveryTarget>>;
  getTarget(id: string, signal?: AbortSignal): Promise<DeliveryTarget>;
  createTarget(input: DeliveryTargetInput): Promise<DeliveryTarget>;
  updateTarget(id: string, input: DeliveryTargetInput): Promise<DeliveryTarget>;
  deleteTarget(id: string): Promise<void>;
  testTarget(id: string): Promise<TestConnectionResult>;

  listRuns(params?: ListParams, signal?: AbortSignal): Promise<Paginated<RunState>>;
  getRun(id: string, signal?: AbortSignal): Promise<RunState>;
  getRunSummary(id: string, signal?: AbortSignal): Promise<RunSummary>;
  startRun(input: RunStartInput): Promise<RunState>;
  stopRun(id: string): Promise<RunSummary>;
  pauseRun(id: string): Promise<RunState>;
  resumeRun(id: string): Promise<RunState>;
  injectChaos(id: string, config: ChaosInjectorConfig): Promise<ChaosInjectResult>;

  listChaosInjectors(signal?: AbortSignal): Promise<ChaosInjectorDef[]>;
  getIdentityStats(signal?: AbortSignal): Promise<IdentityPoolStats>;

  getCurrentTelemetry(signal?: AbortSignal): Promise<TelemetryFrame | null>;
  getRecentEvents(limit?: number, signal?: AbortSignal): Promise<WorkdayEvent[]>;
  getReceiverStats(signal?: AbortSignal): Promise<ReceiverStats>;
  resetReceiver(): Promise<void>;
}

/** Build a query string from a param record, skipping undefined values. */
function buildQuery(query: RequestOptions['query']): string {
  if (!query) return '';
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      usp.set(key, String(value));
    }
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

/**
 * Best-effort parse of the uniform error body `{ error, code, requestId, details }`.
 * Falls back to sensible defaults when the body is empty or not JSON.
 */
async function toApiError(response: Response): Promise<ApiError> {
  let code = `http_${response.status}`;
  let message = response.statusText || 'Request failed';
  let requestId: string | undefined;
  let details: unknown;
  try {
    const data = (await response.json()) as {
      error?: string;
      code?: string;
      requestId?: string;
      details?: unknown;
    };
    if (data && typeof data === 'object') {
      if (typeof data.error === 'string') message = data.error;
      if (typeof data.code === 'string') code = data.code;
      if (typeof data.requestId === 'string') requestId = data.requestId;
      details = data.details;
    }
  } catch {
    // Non-JSON error body; keep the status-derived defaults.
  }
  return new ApiError({ message, status: response.status, code, requestId, details });
}

export function createApiClient(config: ApiClientConfig): ApiClient {
  const baseUrl = config.baseUrl ?? '';
  const doFetch = config.fetchImpl ?? globalThis.fetch.bind(globalThis);

  async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = 'GET', body, query, signal, anonymous } = options;
    const headers: Record<string, string> = { Accept: 'application/json' };

    if (!anonymous) {
      const token = config.getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    let payload: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}${buildQuery(query)}`, {
        method,
        headers,
        body: payload,
        signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new ApiError({
        message: 'Network request failed. Is the simulator server reachable?',
        status: 0,
        code: 'network_error',
      });
    }

    if (response.status === 401) {
      config.onUnauthorized?.(401);
      throw await toApiError(response);
    }
    if (!response.ok) {
      throw await toApiError(response);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    // Some endpoints (telemetry/current) answer 204 for "no active run"; handled above.
    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  return {
    request,
    getConfig: (signal) => request('/api/config', { anonymous: false, signal }),

    listScenarios: (params, signal) =>
      request('/api/scenarios', { query: { ...params }, signal }),
    getScenario: (id, signal) => request(`/api/scenarios/${encodeURIComponent(id)}`, { signal }),
    createScenario: (input) => request('/api/scenarios', { method: 'POST', body: input }),
    updateScenario: (id, input) =>
      request(`/api/scenarios/${encodeURIComponent(id)}`, { method: 'PUT', body: input }),
    deleteScenario: (id) =>
      request(`/api/scenarios/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    listTargets: (params, signal) => request('/api/targets', { query: { ...params }, signal }),
    getTarget: (id, signal) => request(`/api/targets/${encodeURIComponent(id)}`, { signal }),
    createTarget: (input) => request('/api/targets', { method: 'POST', body: input }),
    updateTarget: (id, input) =>
      request(`/api/targets/${encodeURIComponent(id)}`, { method: 'PUT', body: input }),
    deleteTarget: (id) => request(`/api/targets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    testTarget: (id) =>
      request(`/api/targets/${encodeURIComponent(id)}/test`, { method: 'POST' }),

    listRuns: (params, signal) => request('/api/runs', { query: { ...params }, signal }),
    getRun: (id, signal) => request(`/api/runs/${encodeURIComponent(id)}`, { signal }),
    getRunSummary: (id, signal) =>
      request(`/api/runs/${encodeURIComponent(id)}/summary`, { signal }),
    startRun: (input) => request('/api/runs', { method: 'POST', body: input }),
    stopRun: (id) => request(`/api/runs/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
    pauseRun: (id) => request(`/api/runs/${encodeURIComponent(id)}/pause`, { method: 'POST' }),
    resumeRun: (id) => request(`/api/runs/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
    injectChaos: (id, cfg) =>
      request(`/api/runs/${encodeURIComponent(id)}/chaos`, { method: 'POST', body: cfg }),

    listChaosInjectors: (signal) => request('/api/chaos/injectors', { signal }),
    getIdentityStats: (signal) => request('/api/identities/stats', { signal }),

    getCurrentTelemetry: (signal) =>
      request('/api/telemetry/current', { signal }) as Promise<TelemetryFrame | null>,
    getRecentEvents: (limit, signal) =>
      request('/api/telemetry/events', { query: { limit }, signal }),
    getReceiverStats: (signal) => request('/api/receiver/stats', { signal }),
    resetReceiver: () => request('/api/receiver/reset', { method: 'POST' }),
  };
}
