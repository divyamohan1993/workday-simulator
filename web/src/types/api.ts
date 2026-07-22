/**
 * Frontend mirror of the REST and WebSocket contracts.
 *
 * The dashboard is built and bundled separately from the backend, so it cannot
 * import from `src/types`. These types mirror the API surface the dashboard
 * consumes. They MUST stay in sync with `src/types/index.ts` and the REST/WS
 * contract in `docs/BUILD-CONTRACT.md`. Event payloads are intentionally `unknown`
 * here: the dashboard renders the event envelope (kind, category, severity, actor)
 * and treats the payload opaquely.
 */

/* --- Enum mirrors ---------------------------------------------------------- */

export type Severity = 'info' | 'notice' | 'warning' | 'error' | 'critical';
export type EventCategory = 'AUTH' | 'JML' | 'ACCESS' | 'TXN' | 'COMPLIANCE';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type DeliveryKind = 'scim' | 'webhook' | 'rest' | 'nats' | 'batch';
export type CircuitState = 'closed' | 'open' | 'half_open';
export type RunStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'paused'
  | 'stopping'
  | 'completed'
  | 'failed';
export type WorkdayPhase =
  | 'overnight'
  | 'pre_market'
  | 'market_open'
  | 'core_hours'
  | 'lunch'
  | 'market_close'
  | 'evening';

export type Division =
  | 'Investment Bank'
  | 'Corporate Bank'
  | 'Private Bank'
  | 'Asset Management'
  | 'Technology, Data & Innovation'
  | 'Operations'
  | 'Risk'
  | 'Compliance'
  | 'Human Resources'
  | 'Finance';

export type LocationCode = 'FFT' | 'LDN' | 'NYC' | 'SIN' | 'HKG' | 'BLR' | 'PNQ' | 'JAX';

export type Grade =
  | 'Intern'
  | 'Contractor'
  | 'Analyst'
  | 'Associate'
  | 'AVP'
  | 'VP'
  | 'Director'
  | 'MD';

export type EmployeeType = 'FTE' | 'Contractor' | 'Intern' | 'External' | 'Service';

export type ChaosInjectorKind =
  | 'credential_stuffing'
  | 'mass_termination_reorg'
  | 'insider_threat'
  | 'audit_season_surge'
  | 'ransomware_lateral'
  | 'payroll_batch'
  | 'mass_password_reset'
  | 'connector_outage';

export type EventKind =
  | 'login.success'
  | 'login.failure'
  | 'mfa.challenge'
  | 'mfa.success'
  | 'mfa.failure'
  | 'password.reset'
  | 'account.lockout'
  | 'session.start'
  | 'session.end'
  | 'sso.federation'
  | 'stepup'
  | 'impossible.travel'
  | 'joiner.hire'
  | 'mover.transfer'
  | 'mover.promotion'
  | 'mover.manager_change'
  | 'leaver.termination'
  | 'leaver.resignation'
  | 'leaver.loa'
  | 'rehire'
  | 'contractor.convert'
  | 'contract.expiry'
  | 'access.request'
  | 'access.approve'
  | 'access.deny'
  | 'access.provision'
  | 'access.revoke'
  | 'recertification'
  | 'firefighter.grant'
  | 'firefighter.revoke'
  | 'sod.violation'
  | 'orphan.detected'
  | 'dormant.detected'
  | 'payment.sepa'
  | 'payment.swift'
  | 'trade.book'
  | 'card.txn'
  | 'wire.approval'
  | 'limit.breach'
  | 'highvalue.alert'
  | 'gdpr.request'
  | 'audit.pull'
  | 'nhi.activity'
  | 'breakglass'
  | 'duplicate.identity'
  | 'namecollision';

/* --- Identity references and events ---------------------------------------- */

export interface IdentityRef {
  id: string;
  employeeId: string;
  displayName: string;
  email: string;
  division: Division;
  location: LocationCode;
  grade: Grade;
  type: EmployeeType;
}

export type ActorRef =
  | ({ kind: 'employee' } & IdentityRef)
  | ({ kind: 'service' } & IdentityRef)
  | { kind: 'system'; id: string; component: string };

/** The event envelope as the dashboard consumes it (payload treated opaquely). */
export interface WorkdayEvent {
  id: string;
  kind: EventKind;
  category: EventCategory;
  timestamp: string;
  emittedAtWall: string;
  correlationId: string;
  causationId?: string;
  severity: Severity;
  actor: ActorRef;
  subject?: IdentityRef;
  location: LocationCode;
  division: Division;
  seq: number;
  payload: unknown;
}

/* --- Telemetry ------------------------------------------------------------- */

export interface LatencyHistogram {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  count: number;
}

export interface ClockState {
  simEpochMs: number;
  simISO: string;
  wallEpochMs: number;
  accel: number;
  phase: WorkdayPhase;
  weekday: number;
  isBusinessDay: boolean;
}

export interface ConnectorStat {
  connector: string;
  provisioned: number;
  failed: number;
  avgProvisionMs: number;
  queueDepth: number;
}

export interface ReceiverStats {
  queueDepth: number;
  provisioned: number;
  failed: number;
  sodViolations: number;
  orphans: number;
  dormant: number;
  avgProvisionMs: number;
  byConnector: Record<string, ConnectorStat>;
  totalIngested: number;
  lastIngestAt?: string;
}

export interface DeliveryStats {
  currentRps: number;
  targetRps: number;
  inFlight: number;
  queueDepth: number;
  circuit: CircuitState;
  deliveredTotal: number;
  failedTotal: number;
  droppedTotal: number;
  latency: LatencyHistogram;
}

export interface ActiveChaos {
  kind: ChaosInjectorKind;
  startedAt: string;
  endsAt?: string;
  intensity: number;
  eventsInjected: number;
}

export interface RunCounters {
  generated: number;
  delivered: number;
  failed: number;
  dropped: number;
  byCategory: Record<EventCategory, number>;
}

export interface RunState {
  id: string;
  scenarioId: string;
  targetId: string;
  status: RunStatus;
  startedAt?: string;
  endedAt?: string;
  elapsedSec: number;
  currentRps: number;
  targetRps: number;
  counters: RunCounters;
  activeChaos: ChaosInjectorKind[];
  error?: string;
  seed: string;
}

export interface RunSummary {
  runId: string;
  scenarioId: string;
  targetId: string;
  status: RunStatus;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  totals: RunCounters;
  byKind: Partial<Record<EventKind, number>>;
  latency: LatencyHistogram;
  errorRate: number;
  delivery: DeliveryStats;
  receiver: ReceiverStats;
  chaosFired: ActiveChaos[];
  seed: string;
}

export interface TelemetryFrame {
  clock: ClockState;
  currentRps: number;
  targetRps: number;
  latency: LatencyHistogram;
  errorRate: number;
  eventMix: {
    byCategory: Record<EventCategory, number>;
    byKind: Partial<Record<EventKind, number>>;
  };
  receiver: ReceiverStats;
  delivery: DeliveryStats;
  recentEvents: WorkdayEvent[];
  activeChaos: ActiveChaos[];
  run: RunState | null;
  frameSeq: number;
  emittedAt: string;
}

/* --- Scenario and target management --------------------------------------- */

export interface EventMixWeights {
  byCategory: Record<EventCategory, number>;
  byKind?: Partial<Record<EventKind, number>>;
}

export interface TimezoneWeights {
  byLocation: Record<LocationCode, number>;
}

export interface ChaosInjectorConfig {
  kind: ChaosInjectorKind;
  enabled: boolean;
  startAtSec?: number;
  durationSec?: number;
  intensity: number;
  params: Record<string, number | string | boolean>;
}

export interface ScenarioConfig {
  id: string;
  name: string;
  description: string;
  baselineRps: number;
  maxRps: number;
  workdayAccel: number;
  startSimTime?: string;
  timezoneWeights: TimezoneWeights;
  eventMix: EventMixWeights;
  chaos: ChaosInjectorConfig[];
  targetId: string;
  durationSec?: number;
  seed?: string;
  createdAt: string;
  updatedAt: string;
}

export type DeliveryAuthConfig =
  | { kind: 'none' }
  | { kind: 'bearer'; token: string }
  | { kind: 'basic'; username: string; password: string }
  | {
      kind: 'oauth2_client_credentials';
      tokenUrl: string;
      clientId: string;
      clientSecret: string;
      scope?: string;
    }
  | {
      kind: 'hmac';
      algorithm: 'sha256' | 'sha512';
      secret: string;
      header: string;
      signaturePrefix?: string;
    };

export interface DeliveryRetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
  retryableStatuses: number[];
}

export interface DeliveryTarget {
  id: string;
  name: string;
  kind: DeliveryKind;
  url: string;
  auth: DeliveryAuthConfig;
  headers: Record<string, string>;
  rateLimit: { rps: number; burst: number };
  concurrency: number;
  retry: DeliveryRetryPolicy;
  queueHighWater: number;
  overflowPolicy: 'block' | 'drop_new' | 'drop_oldest';
  batchSize?: number;
  natsSubject?: string;
  builtIn: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IdentityPoolStats {
  total: number;
  byStatus: Record<string, number>;
  byType: Record<EmployeeType, number>;
  byDivision: Record<Division, number>;
  byLocation: Record<LocationCode, number>;
  byGrade: Record<Grade, number>;
  nonHuman: number;
  withSodConflicts: number;
}

/* --- Generic REST envelopes ------------------------------------------------ */

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface ApiError {
  error: string;
  code: string;
  requestId: string;
  details?: unknown;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  uptimeSec: number;
  version: string;
}

export interface ReadyResponse {
  status: 'ready' | 'not_ready';
  checks: Record<string, boolean>;
}

/* --- WebSocket protocol (/ws/telemetry) ------------------------------------ */

export const WS_PROTOCOL_VERSION = 1;

export type WsClientMessage =
  | { type: 'ping' }
  | { type: 'subscribe'; channels: Array<'frame' | 'event' | 'run'> };

export type WsServerMessage =
  | {
      type: 'hello';
      serverTime: string;
      metricsIntervalMs: number;
      protocolVersion: number;
    }
  | { type: 'frame'; frame: TelemetryFrame }
  | { type: 'event'; event: WorkdayEvent }
  | { type: 'run'; run: RunState }
  | { type: 'pong' }
  | { type: 'error'; error: string; code: string };
