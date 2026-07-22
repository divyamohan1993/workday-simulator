/**
 * THE shared type universe for the Deutsche Bank Workday Simulator.
 *
 * This file is a FROZEN contract. Every module imports its cross-cutting types
 * from here; nothing redefines a shared shape locally. It is intentionally a
 * single file so there is exactly one import path (`../types/index.js`) and one
 * place to reason about the domain.
 *
 * Design notes that bind every builder:
 * - Events are a payload-map discriminated union keyed on `kind`. Narrow on
 *   `event.kind` in a switch and the payload type follows automatically.
 * - Every event separates `actor` (who caused it, possibly a service/NHI or the
 *   system itself) from `subject` (whom it is about). Consumers that need "the
 *   affected identity" read `subject ?? actor`. Do not stuff the subject into
 *   payloads ad hoc.
 * - Runtime maps (EVENT_CATEGORY, EVENT_KINDS_BY_CATEGORY, GRADE_SENIORITY) live
 *   here so the four consumers (events, delivery, receiver, metrics) never
 *   re-derive kind -> category and drift apart.
 *
 * Zod validation schemas that mirror the config-facing shapes below live in
 * `src/contracts/validation.ts`.
 */

/* ============================================================================
 * SECTION 1 - Organization and domain primitives (Deutsche Bank realism)
 * ========================================================================== */

/** Deutsche Bank operating divisions. "Asset Management" is DWS. */
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

/** Short site codes for the eight modeled locations. */
export type LocationCode = 'FFT' | 'LDN' | 'NYC' | 'SIN' | 'HKG' | 'BLR' | 'PNQ' | 'JAX';

/**
 * A physical site. `timezone` is the IANA zone used for accurate diurnal shaping
 * at runtime; `utcOffsetMinutes` is only a nominal hint for coarse weighting and
 * must not be used for time math (DST makes it wrong twice a year).
 */
export interface Location {
  code: LocationCode;
  city: string;
  country: string; // ISO 3166-1 alpha-2
  timezone: string; // IANA, e.g. "Europe/Frankfurt"
  isHeadquarters: boolean;
  utcOffsetMinutes: number;
}

/** Legal entities an identity can belong to; drives some provisioning routing. */
export type LegalEntity =
  | 'Deutsche Bank AG'
  | 'DB Privat- und Firmenkundenbank AG'
  | 'Deutsche Bank Trust Company Americas'
  | 'DWS Group GmbH & Co. KGaA'
  | 'Deutsche Bank Luxembourg S.A.'
  | 'Deutsche Bank AG, London Branch'
  | 'Deutsche India Private Limited'
  | 'Deutsche Bank (Singapore) Ltd'
  | 'Deutsche Bank AG, Hong Kong Branch';

/** Job families spanning the modeled divisions. */
export type JobFamily =
  | 'Trading'
  | 'Sales'
  | 'Research'
  | 'Quant'
  | 'Software Engineering'
  | 'Site Reliability'
  | 'Data Engineering'
  | 'Cybersecurity'
  | 'Relationship Management'
  | 'Credit Analysis'
  | 'Wealth Advisory'
  | 'Portfolio Management'
  | 'Operations Processing'
  | 'Payments Operations'
  | 'Settlements'
  | 'Risk Management'
  | 'Compliance & AFC'
  | 'Audit'
  | 'Human Resources'
  | 'Finance & Controlling'
  | 'Legal';

/**
 * Career grade. Ordered by seniority via GRADE_SENIORITY. "Contractor" and
 * "Intern" are grades as well as employment types because they map to distinct
 * birthright entitlement sets.
 */
export type Grade =
  | 'Intern'
  | 'Contractor'
  | 'Analyst'
  | 'Associate'
  | 'AVP'
  | 'VP'
  | 'Director'
  | 'MD';

/** Employment relationship. "Service" is a non-human (machine) identity (NHI). */
export type EmployeeType = 'FTE' | 'Contractor' | 'Intern' | 'External' | 'Service';

/** Cost center attached to an identity for chargeback and reporting. */
export interface CostCenter {
  code: string; // e.g. "CC-IB-4471"
  name: string;
  division: Division;
  legalEntity: LegalEntity;
}

/** Lifecycle status of an identity. Drives whether accounts stay enabled. */
export type IdentityStatus =
  | 'active'
  | 'onboarding'
  | 'suspended'
  | 'on_leave'
  | 'terminated'
  | 'disabled'
  | 'dormant';

export type EntitlementType =
  | 'role'
  | 'group'
  | 'profile'
  | 'privileged'
  | 'firefighter'
  | 'account'
  | 'application';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * A concrete access grant held by an identity. `sodTags` are the abstract duties
 * used for segregation-of-duties conflict detection (e.g. "payment.initiate" vs
 * "payment.approve"). `expiresAt` is set for time-boxed grants (firefighter).
 */
export interface Entitlement {
  id: string;
  system: string; // target system, e.g. "Murex", "ActiveDirectory", "SWIFT-Alliance"
  name: string; // human label, e.g. "Murex Trader - Frankfurt"
  type: EntitlementType;
  risk: RiskLevel;
  /** True for toxic-combination candidates that SoD rules watch. */
  sensitive: boolean;
  grantedAt: string; // ISO 8601
  expiresAt?: string; // ISO 8601, for temporary/firefighter grants
  sodTags: string[];
}

/** Compact reference to an entitlement embedded in events. */
export interface EntitlementRef {
  id: string;
  system: string;
  name: string;
  type: EntitlementType;
  risk: RiskLevel;
}

/* ============================================================================
 * SECTION 2 - Identity (Employee) and references
 * ========================================================================== */

/**
 * A simulated workforce identity. Names deliberately include edge cases (unicode,
 * very long, hyphenated, mononyms, apostrophes) to exercise downstream
 * normalization. `email`/`username` may collide by construction to drive dedup
 * and name-collision handling. `isNonHuman` marks service/machine identities.
 */
export interface Employee {
  /** Stable internal id (nanoid). Primary key across the sim and delivery. */
  id: string;
  /** HR personnel number, e.g. "DB00483927". */
  employeeId: string;
  firstName: string;
  lastName: string;
  displayName: string;
  email: string;
  username: string; // sAMAccountName-style
  /** Manager chain by id; null for top-of-house. */
  managerId: string | null;
  division: Division;
  jobFamily: JobFamily;
  grade: Grade;
  type: EmployeeType;
  status: IdentityStatus;
  location: LocationCode;
  legalEntity: LegalEntity;
  costCenter: string; // CostCenter.code
  entitlements: Entitlement[];
  startDate: string; // ISO date
  endDate?: string; // ISO date, set on leaver
  /** Realistic extra attributes: phone, buildingCode, riskFlags, adGroupOu, etc. */
  attributes: Record<string, string | number | boolean | null>;
  isNonHuman: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Compact identity reference embedded in events so consumers need not resolve the
 * full Employee to render or route an event.
 */
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

/**
 * The party that CAUSED an event. Usually an employee, sometimes a service (NHI)
 * identity, and sometimes the platform itself (detectors, schedulers, campaigns).
 * The `system` variant has no personnel identity, only a component name.
 */
export type ActorRef =
  | ({ kind: 'employee' } & IdentityRef)
  | ({ kind: 'service' } & IdentityRef)
  | { kind: 'system'; id: string; component: string };

/* ============================================================================
 * SECTION 3 - Events (payload-map discriminated union)
 * ========================================================================== */

export type EventCategory = 'AUTH' | 'JML' | 'ACCESS' | 'TXN' | 'COMPLIANCE';

export type Severity = 'info' | 'notice' | 'warning' | 'error' | 'critical';

/** Every event kind the simulator can emit, grouped by category in the union. */
export type EventKind =
  // AUTH
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
  // JML
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
  // ACCESS
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
  // TXN
  | 'payment.sepa'
  | 'payment.swift'
  | 'trade.book'
  | 'card.txn'
  | 'wire.approval'
  | 'limit.breach'
  | 'highvalue.alert'
  // COMPLIANCE
  | 'gdpr.request'
  | 'audit.pull'
  | 'nhi.activity'
  | 'breakglass'
  | 'duplicate.identity'
  | 'namecollision';

/** A latitude/longitude point with a human label, used for geo-velocity checks. */
export interface GeoPoint {
  city: string;
  country: string; // ISO 3166-1 alpha-2
  lat: number;
  lng: number;
}

/** The provisioning intent an event implies for the Identity Manager. */
export type ProvisioningOperation =
  | 'create'
  | 'update'
  | 'patch'
  | 'deactivate'
  | 'reactivate'
  | 'delete'
  | 'grant'
  | 'revoke'
  | 'notify'
  | 'noop';

export type ProvisioningResource =
  | 'identity'
  | 'entitlement'
  | 'group'
  | 'account'
  | 'session'
  | 'event';

/**
 * Delivery metadata carried on every event. It tells the delivery adapter and the
 * receiver how to map the event onto a provisioning operation, and provides an
 * idempotency key so at-least-once delivery does not double-provision.
 */
export interface EventDeliveryMeta {
  operation: ProvisioningOperation;
  resource: ProvisioningResource;
  idempotencyKey: string;
  priority: 'low' | 'normal' | 'high' | 'critical';
  requiresApproval: boolean;
}

/** Fields common to every event, independent of kind. */
export interface WorkdayEventBase {
  /** Stable event id (nanoid). */
  id: string;
  category: EventCategory;
  /** ISO 8601 timestamp in SIMULATED workday time. */
  timestamp: string;
  /** ISO 8601 wall-clock time at emission; used for delivery latency math. */
  emittedAtWall: string;
  /** Ties a multi-step saga together (request -> approve -> provision). */
  correlationId: string;
  /** The id of the event that directly caused this one, when part of a saga. */
  causationId?: string;
  severity: Severity;
  /** Who caused the event. */
  actor: ActorRef;
  /** Whom the event is about, when distinct from the actor. */
  subject?: IdentityRef;
  location: LocationCode;
  division: Division;
  delivery: EventDeliveryMeta;
  /** Monotonic sequence number within a run for deterministic ordering. */
  seq: number;
}

/* --- AUTH payloads --------------------------------------------------------- */

export interface LoginSuccessPayload {
  ip: string;
  userAgent: string;
  method: 'password' | 'sso' | 'certificate' | 'passkey';
  geo: GeoPoint;
  deviceId: string;
  sessionId: string;
  riskScore: number; // 0..100
}

export interface LoginFailurePayload {
  ip: string;
  userAgent: string;
  reason: 'bad_password' | 'unknown_user' | 'disabled' | 'locked' | 'expired' | 'mfa_required';
  attemptCount: number;
  geo: GeoPoint;
}

export interface MfaChallengePayload {
  sessionId: string;
  factor: 'totp' | 'push' | 'sms' | 'webauthn' | 'hardware_token';
  reason: 'login' | 'stepup' | 'high_risk' | 'new_device';
}

export interface MfaSuccessPayload {
  sessionId: string;
  factor: MfaChallengePayload['factor'];
  latencyMs: number;
}

export interface MfaFailurePayload {
  sessionId: string;
  factor: MfaChallengePayload['factor'];
  reason: 'timeout' | 'rejected' | 'wrong_code' | 'exhausted';
  attemptCount: number;
}

export interface PasswordResetPayload {
  channel: 'self_service' | 'helpdesk' | 'forced';
  reason: 'forgotten' | 'expired' | 'compromise' | 'policy';
  ticketId?: string;
}

export interface AccountLockoutPayload {
  reason: 'failed_attempts' | 'admin' | 'risk' | 'impossible_travel';
  failedAttempts: number;
  unlockAt?: string; // ISO 8601
}

export interface SessionStartPayload {
  sessionId: string;
  ip: string;
  deviceId: string;
  appId: string;
}

export interface SessionEndPayload {
  sessionId: string;
  durationSec: number;
  reason: 'logout' | 'timeout' | 'revoked' | 'expired';
}

export interface SsoFederationPayload {
  idp: 'AzureAD' | 'PingFederate' | 'ADFS' | 'Okta';
  protocol: 'SAML' | 'OIDC';
  spEntityId: string;
  assertionId: string;
}

export interface StepUpPayload {
  sessionId: string;
  resource: string;
  reason: 'high_value_txn' | 'privileged_access' | 'policy';
  satisfied: boolean;
}

export interface ImpossibleTravelPayload {
  fromGeo: GeoPoint;
  toGeo: GeoPoint;
  distanceKm: number;
  deltaMinutes: number;
  impliedSpeedKmh: number;
  priorIp: string;
  currentIp: string;
}

/* --- JML payloads ---------------------------------------------------------- */

export interface JoinerHirePayload {
  effectiveDate: string; // ISO date
  employeeType: EmployeeType;
  division: Division;
  grade: Grade;
  managerId: string | null;
  location: LocationCode;
  contractType: 'permanent' | 'fixed_term' | 'agency' | 'internship';
  positionId: string;
  /** Birthright entitlement ids provisioned automatically on hire. */
  birthrightEntitlements: string[];
}

export interface MoverTransferPayload {
  fromDivision: Division;
  toDivision: Division;
  fromLocation: LocationCode;
  toLocation: LocationCode;
  fromCostCenter: string;
  toCostCenter: string;
  effectiveDate: string;
  retainedEntitlements: string[];
  revokedEntitlements: string[];
}

export interface MoverPromotionPayload {
  fromGrade: Grade;
  toGrade: Grade;
  effectiveDate: string;
  newTitle: string;
}

export interface MoverManagerChangePayload {
  fromManagerId: string | null;
  toManagerId: string;
  effectiveDate: string;
  partOfReorg: boolean;
}

export interface LeaverTerminationPayload {
  reason: 'performance' | 'misconduct' | 'gross_misconduct' | 'redundancy';
  immediate: boolean;
  lastWorkingDay: string;
  revokeImmediately: boolean;
  escortRequired: boolean;
}

export interface LeaverResignationPayload {
  noticePeriodDays: number;
  lastWorkingDay: string;
  rehireEligible: boolean;
}

export interface LeaverLoaPayload {
  loaType: 'maternity' | 'paternity' | 'medical' | 'sabbatical' | 'garden_leave';
  startDate: string;
  expectedReturn?: string;
  suspendAccess: boolean;
}

export interface RehirePayload {
  previousEmployeeId: string;
  gapDays: number;
  restoredEntitlements: string[];
}

export interface ContractorConvertPayload {
  fromType: EmployeeType;
  toType: EmployeeType;
  effectiveDate: string;
  newEmployeeId: string;
}

export interface ContractExpiryPayload {
  contractEndDate: string;
  autoRevoke: boolean;
  extensionGranted: boolean;
}

/* --- ACCESS payloads ------------------------------------------------------- */

export interface AccessRequestPayload {
  requestId: string;
  entitlement: EntitlementRef;
  businessJustification: string;
  /** Identity the access is requested for (may differ from the actor). */
  forSubjectId: string;
  riskLevel: RiskLevel;
  sodPreCheck: 'clear' | 'conflict';
  channel: 'self_service' | 'manager' | 'birthright' | 'role_mining';
}

export interface AccessApprovePayload {
  requestId: string;
  approverId: string;
  approvalLevel: number;
  slaMs: number;
  comment?: string;
}

export interface AccessDenyPayload {
  requestId: string;
  approverId: string;
  reason: 'sod_conflict' | 'insufficient_justification' | 'policy' | 'risk';
}

export interface AccessProvisionPayload {
  requestId?: string;
  entitlement: EntitlementRef;
  targetSystem: string;
  connector: string;
  provisioningMode: 'automated' | 'manual';
  latencyMs: number;
}

export interface AccessRevokePayload {
  entitlement: EntitlementRef;
  reason: 'leaver' | 'mover' | 'recert_fail' | 'sod' | 'expiry' | 'manual';
  targetSystem: string;
  connector: string;
}

export interface RecertificationPayload {
  campaignId: string;
  decision: 'certify' | 'revoke' | 'delegate';
  reviewerId: string;
  itemCount: number;
  entitlement?: EntitlementRef;
}

export interface FirefighterGrantPayload {
  role: string;
  system: string;
  reason: string;
  ticketId: string;
  expiresAt: string;
  approverId: string;
}

export interface FirefighterRevokePayload {
  role: string;
  system: string;
  sessionDurationSec: number;
  actionsLogged: number;
}

export interface SodViolationPayload {
  ruleId: string;
  ruleName: string;
  /** The two conflicting grants that form the toxic combination. */
  conflictingEntitlements: [EntitlementRef, EntitlementRef];
  severity: RiskLevel;
  mitigation: 'blocked' | 'exception_granted' | 'flagged';
  exceptionApprover?: string;
}

export interface OrphanDetectedPayload {
  accountId: string;
  system: string;
  lastOwnerId?: string;
  lastActivityAt: string;
  ageDays: number;
}

export interface DormantDetectedPayload {
  accountId: string;
  system: string;
  dormantDays: number;
  lastLoginAt: string;
}

/* --- TXN payloads (banking) ------------------------------------------------ */

export interface PaymentSepaPayload {
  txnId: string;
  amount: number;
  currency: 'EUR';
  debtorIban: string;
  creditorIban: string;
  instrument: 'SCT' | 'SDD' | 'SCT_Inst';
  bic: string;
  purpose: string;
}

export interface PaymentSwiftPayload {
  txnId: string;
  amount: number;
  currency: string; // ISO 4217
  messageType: 'MT103' | 'MT202' | 'pacs.008';
  senderBic: string;
  receiverBic: string;
  correspondentBic?: string;
  uetr: string; // unique end-to-end transaction reference
}

export interface TradeBookPayload {
  tradeId: string;
  assetClass: 'Rates' | 'Credit' | 'FX' | 'Equities' | 'Commodities';
  instrument: string;
  notional: number;
  currency: string;
  book: string;
  counterparty: string;
  direction: 'buy' | 'sell';
}

export interface CardTxnPayload {
  txnId: string;
  panLast4: string;
  amount: number;
  currency: string;
  merchant: string;
  mcc: string; // merchant category code
  channel: 'pos' | 'ecom' | 'atm';
  country: string;
  fraudScore: number; // 0..100
}

export interface WireApprovalPayload {
  txnId: string;
  amount: number;
  currency: string;
  approvalTier: number;
  approverId: string;
  dualControl: boolean;
}

export interface LimitBreachPayload {
  limitType: 'intraday' | 'settlement' | 'credit' | 'position';
  limit: number;
  exposure: number;
  currency: string;
  book: string;
  breachPct: number;
}

export interface HighValueAlertPayload {
  txnId: string;
  amount: number;
  currency: string;
  threshold: number;
  flaggedBy: 'aml' | 'fraud' | 'sanctions';
  screeningStatus: 'pending' | 'cleared' | 'blocked';
}

/* --- COMPLIANCE payloads --------------------------------------------------- */

export interface GdprRequestPayload {
  requestType: 'access' | 'erasure' | 'rectification' | 'portability';
  dataSubjectId: string;
  regulation: 'GDPR' | 'DPDPA';
  dueDate: string;
}

export interface AuditPullPayload {
  auditId: string;
  scope: string;
  requestedBy: string;
  recordCount: number;
  regulator?: 'BaFin' | 'ECB' | 'FCA' | 'MAS' | 'HKMA' | 'RBI' | 'FED';
}

export interface NhiActivityPayload {
  serviceAccountId: string;
  action: string;
  targetSystem: string;
  tokenType: 'oauth' | 'api_key' | 'certificate' | 'kerberos';
  secretRotatedAt?: string;
  anomalous: boolean;
}

export interface BreakglassPayload {
  accountId: string;
  system: string;
  reason: string;
  approverId: string;
  incidentId: string;
  expiresAt: string;
  sessionRecorded: boolean;
}

export interface DuplicateIdentityPayload {
  candidateIds: string[];
  matchScore: number; // 0..1
  matchedAttributes: string[];
  resolution: 'merge' | 'flag' | 'ignore';
}

export interface NameCollisionPayload {
  collidingWith: string[];
  attribute: 'email' | 'username' | 'displayName';
  generatedSuffix: string;
  resolutionStrategy: 'numeric_suffix' | 'middle_initial' | 'location_suffix';
}

/* --- Payload map and the discriminated union ------------------------------- */

/**
 * Maps each event kind to its payload type. This is the single source of truth
 * for payload shapes; WorkdayEvent is derived from it so the union and the map
 * can never drift.
 */
export interface EventPayloadMap {
  'login.success': LoginSuccessPayload;
  'login.failure': LoginFailurePayload;
  'mfa.challenge': MfaChallengePayload;
  'mfa.success': MfaSuccessPayload;
  'mfa.failure': MfaFailurePayload;
  'password.reset': PasswordResetPayload;
  'account.lockout': AccountLockoutPayload;
  'session.start': SessionStartPayload;
  'session.end': SessionEndPayload;
  'sso.federation': SsoFederationPayload;
  stepup: StepUpPayload;
  'impossible.travel': ImpossibleTravelPayload;
  'joiner.hire': JoinerHirePayload;
  'mover.transfer': MoverTransferPayload;
  'mover.promotion': MoverPromotionPayload;
  'mover.manager_change': MoverManagerChangePayload;
  'leaver.termination': LeaverTerminationPayload;
  'leaver.resignation': LeaverResignationPayload;
  'leaver.loa': LeaverLoaPayload;
  rehire: RehirePayload;
  'contractor.convert': ContractorConvertPayload;
  'contract.expiry': ContractExpiryPayload;
  'access.request': AccessRequestPayload;
  'access.approve': AccessApprovePayload;
  'access.deny': AccessDenyPayload;
  'access.provision': AccessProvisionPayload;
  'access.revoke': AccessRevokePayload;
  recertification: RecertificationPayload;
  'firefighter.grant': FirefighterGrantPayload;
  'firefighter.revoke': FirefighterRevokePayload;
  'sod.violation': SodViolationPayload;
  'orphan.detected': OrphanDetectedPayload;
  'dormant.detected': DormantDetectedPayload;
  'payment.sepa': PaymentSepaPayload;
  'payment.swift': PaymentSwiftPayload;
  'trade.book': TradeBookPayload;
  'card.txn': CardTxnPayload;
  'wire.approval': WireApprovalPayload;
  'limit.breach': LimitBreachPayload;
  'highvalue.alert': HighValueAlertPayload;
  'gdpr.request': GdprRequestPayload;
  'audit.pull': AuditPullPayload;
  'nhi.activity': NhiActivityPayload;
  breakglass: BreakglassPayload;
  'duplicate.identity': DuplicateIdentityPayload;
  namecollision: NameCollisionPayload;
}

/**
 * The workday event. A discriminated union over `kind`: narrowing on `kind`
 * automatically narrows `payload` to the matching type.
 */
export type WorkdayEvent = {
  [K in EventKind]: WorkdayEventBase & { kind: K; payload: EventPayloadMap[K] };
}[EventKind];

/** Extract a single event variant by its kind, e.g. EventOfKind<'login.success'>. */
export type EventOfKind<K extends EventKind> = Extract<WorkdayEvent, { kind: K }>;

/* ============================================================================
 * SECTION 4 - Scenario configuration and chaos
 * ========================================================================== */

export type DeliveryKind = 'scim' | 'webhook' | 'rest' | 'nats' | 'batch';

/** The extreme-scenario injectors the simulator can layer onto a run. */
export type ChaosInjectorKind =
  | 'credential_stuffing'
  | 'mass_termination_reorg'
  | 'insider_threat'
  | 'audit_season_surge'
  | 'ransomware_lateral'
  | 'payroll_batch'
  | 'mass_password_reset'
  | 'connector_outage';

export interface ChaosInjectorConfig {
  kind: ChaosInjectorKind;
  enabled: boolean;
  /** Seconds from run start to fire; omit for manual/immediate injection. */
  startAtSec?: number;
  durationSec?: number;
  /** 0..1 multiplier on the injector's volume/severity. */
  intensity: number;
  /** Injector-specific knobs (e.g. targetCount, sourceIps, connector). */
  params: Record<string, number | string | boolean>;
}

/** Event-mix weighting. The generator normalizes across enabled kinds. */
export interface EventMixWeights {
  byCategory: Record<EventCategory, number>;
  byKind?: Partial<Record<EventKind, number>>;
}

/** Relative activity weight per location; shapes the multi-timezone diurnal curve. */
export interface TimezoneWeights {
  byLocation: Record<LocationCode, number>;
}

/** A named, reusable simulation profile. */
export interface ScenarioConfig {
  id: string;
  name: string;
  description: string;
  /** Steady-state events/sec before diurnal shaping and chaos. */
  baselineRps: number;
  /** Hard ceiling the runtime will not exceed regardless of shaping/chaos. */
  maxRps: number;
  /** Simulated seconds elapsed per real second. */
  workdayAccel: number;
  /** ISO 8601 simulated start time; omit to start "now". */
  startSimTime?: string;
  timezoneWeights: TimezoneWeights;
  eventMix: EventMixWeights;
  chaos: ChaosInjectorConfig[];
  targetId: string;
  /** Real seconds to run; omit for open-ended (until stopped). */
  durationSec?: number;
  /** Deterministic seed override; falls back to the global SEED. */
  seed?: string;
  createdAt: string;
  updatedAt: string;
}

/* ============================================================================
 * SECTION 5 - Delivery (targets, auth, results, backpressure)
 * ========================================================================== */

/**
 * Authentication for a delivery target. HMAC signs the request body with a shared
 * secret; oauth2 fetches and caches a client-credentials token.
 */
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
      header: string; // header the signature is written to, e.g. "X-Signature"
      signaturePrefix?: string; // e.g. "sha256="
    };

export interface DeliveryRetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Jittered exponential backoff when true. */
  jitter: boolean;
  /** HTTP statuses that trigger a retry (e.g. [429, 502, 503, 504]). */
  retryableStatuses: number[];
}

export interface DeliveryRateLimit {
  /** Max requests/sec toward the target; 0 = unlimited. */
  rps: number;
  /** Token-bucket burst capacity. */
  burst: number;
}

/**
 * A destination for the event stream. `builtIn: true` points at the bundled
 * reference OneIM receiver so the system is demonstrable end-to-end.
 */
export interface DeliveryTarget {
  id: string;
  name: string;
  kind: DeliveryKind;
  /** HTTP(S) base URL, nats:// URL, or batch sink URL. */
  url: string;
  auth: DeliveryAuthConfig;
  headers: Record<string, string>;
  rateLimit: DeliveryRateLimit;
  /** Max in-flight requests. */
  concurrency: number;
  retry: DeliveryRetryPolicy;
  /** Bounded internal queue depth before overflow handling kicks in. */
  queueHighWater: number;
  overflowPolicy: 'block' | 'drop_new' | 'drop_oldest';
  /** For kind "batch": events per batch payload. */
  batchSize?: number;
  /** For kind "nats": subject to publish to. */
  natsSubject?: string;
  builtIn: boolean;
  createdAt: string;
  updatedAt: string;
}

export type DeliveryOutcome =
  | 'delivered'
  | 'retried'
  | 'failed'
  | 'dropped'
  | 'circuit_open';

/** The result of attempting to deliver a single event. */
export interface DeliveryResult {
  eventId: string;
  correlationId: string;
  targetId: string;
  kind: DeliveryKind;
  outcome: DeliveryOutcome;
  httpStatus?: number;
  attempts: number;
  /** Wall time from submit to final outcome, in ms. */
  latencyMs: number;
  error?: string;
  at: string; // ISO 8601
}

/** What the receiver acknowledged for a delivered event. */
export interface DeliveryReceipt {
  eventId: string;
  /** Identifier the receiver assigned, e.g. a SCIM resource id. */
  receiverRef?: string;
  accepted: boolean;
  processedMs?: number;
}

export type CircuitState = 'closed' | 'open' | 'half_open';

/**
 * The delivery adapter owns all backpressure. The runtime reads this each tick and
 * throttles the arrival process when `saturated` is true (closed-loop safety on
 * top of the otherwise open-loop generator).
 */
export interface BackpressureState {
  queueDepth: number;
  highWater: number;
  inFlight: number;
  saturated: boolean;
  circuit: CircuitState;
  droppedTotal: number;
  deliveredTotal: number;
  failedTotal: number;
}

/* ============================================================================
 * SECTION 6 - Telemetry
 * ========================================================================== */

export interface LatencyHistogram {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  count: number;
}

/** Per-connector view inside the receiver (AD, Murex, SWIFT, etc.). */
export interface ConnectorStat {
  connector: string;
  provisioned: number;
  failed: number;
  avgProvisionMs: number;
  queueDepth: number;
}

/** Aggregate statistics exposed by the built-in receiver. */
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

export interface MetricSample {
  name: string;
  value: number;
  ts: string;
  labels?: Record<string, string>;
}

export type WorkdayPhase =
  | 'overnight'
  | 'pre_market'
  | 'market_open'
  | 'core_hours'
  | 'lunch'
  | 'market_close'
  | 'evening';

/** Snapshot of the accelerated workday clock. */
export interface ClockState {
  simEpochMs: number;
  simISO: string;
  wallEpochMs: number;
  accel: number;
  /** Business phase in Frankfurt local time; shapes the diurnal curve. */
  phase: WorkdayPhase;
  weekday: number; // 0=Sun .. 6=Sat
  isBusinessDay: boolean;
}

/** Delivery-side rollup for the telemetry frame. */
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

/**
 * One telemetry frame pushed over the WebSocket at METRICS_INTERVAL_MS and used to
 * render the live dashboard. It is a complete, self-contained snapshot.
 */
export interface TelemetryFrame {
  clock: ClockState;
  currentRps: number;
  targetRps: number;
  latency: LatencyHistogram;
  /** Fraction of recent deliveries that failed, 0..1. */
  errorRate: number;
  eventMix: {
    byCategory: Record<EventCategory, number>;
    byKind: Partial<Record<EventKind, number>>;
  };
  receiver: ReceiverStats;
  delivery: DeliveryStats;
  /** Newest-first ring buffer of recent events for the live ticker. */
  recentEvents: WorkdayEvent[];
  activeChaos: ActiveChaos[];
  run: RunState | null;
  frameSeq: number;
  emittedAt: string;
}

/* ============================================================================
 * SECTION 7 - Run lifecycle
 * ========================================================================== */

export type RunStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'paused'
  | 'stopping'
  | 'completed'
  | 'failed';

export interface RunCounters {
  generated: number;
  delivered: number;
  failed: number;
  dropped: number;
  byCategory: Record<EventCategory, number>;
}

/** Live, mutable state of a run. */
export interface RunState {
  id: string;
  scenarioId: string;
  targetId: string;
  status: RunStatus;
  startedAt?: string;
  endedAt?: string;
  /** Real seconds elapsed since start. */
  elapsedSec: number;
  currentRps: number;
  targetRps: number;
  counters: RunCounters;
  activeChaos: ChaosInjectorKind[];
  error?: string;
  seed: string;
}

/** Immutable end-of-run report persisted to the run store. */
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

/* ============================================================================
 * SECTION 8 - Shared utility types
 * ========================================================================== */

/** Cancels a subscription or timer. Returned by subscribe/on* methods. */
export type Unsubscribe = () => void;

/** Standard paginated envelope for list endpoints. */
export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Uniform API error body (mirrors the REST error contract). */
export interface ApiError {
  error: string;
  code: string;
  requestId: string;
  details?: unknown;
}

/** Distribution snapshot of the seeded identity pool. */
export interface IdentityPoolStats {
  total: number;
  byStatus: Record<IdentityStatus, number>;
  byType: Record<EmployeeType, number>;
  byDivision: Record<Division, number>;
  byLocation: Record<LocationCode, number>;
  byGrade: Record<Grade, number>;
  nonHuman: number;
  withSodConflicts: number;
}

/* ============================================================================
 * SECTION 9 - WebSocket telemetry protocol (/ws/telemetry)
 * ========================================================================== */

/** Protocol version for the telemetry WebSocket; bumped on breaking frame changes. */
export const WS_PROTOCOL_VERSION = 1;

/** Messages the dashboard may send to the server over /ws/telemetry. */
export type WsClientMessage =
  | { type: 'ping' }
  | { type: 'subscribe'; channels: Array<'frame' | 'event' | 'run'> };

/** Messages the server pushes to the dashboard over /ws/telemetry. */
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

/* ============================================================================
 * SECTION 10 - Runtime constant maps (single source of truth, prevents drift)
 * ========================================================================== */

/**
 * Event kinds grouped by category. This is the ONE place the grouping is defined;
 * EVENT_CATEGORY and ALL_EVENT_KINDS are derived from it so consumers never
 * hand-maintain a parallel kind -> category table.
 */
export const EVENT_KINDS_BY_CATEGORY = {
  AUTH: [
    'login.success',
    'login.failure',
    'mfa.challenge',
    'mfa.success',
    'mfa.failure',
    'password.reset',
    'account.lockout',
    'session.start',
    'session.end',
    'sso.federation',
    'stepup',
    'impossible.travel',
  ],
  JML: [
    'joiner.hire',
    'mover.transfer',
    'mover.promotion',
    'mover.manager_change',
    'leaver.termination',
    'leaver.resignation',
    'leaver.loa',
    'rehire',
    'contractor.convert',
    'contract.expiry',
  ],
  ACCESS: [
    'access.request',
    'access.approve',
    'access.deny',
    'access.provision',
    'access.revoke',
    'recertification',
    'firefighter.grant',
    'firefighter.revoke',
    'sod.violation',
    'orphan.detected',
    'dormant.detected',
  ],
  TXN: [
    'payment.sepa',
    'payment.swift',
    'trade.book',
    'card.txn',
    'wire.approval',
    'limit.breach',
    'highvalue.alert',
  ],
  COMPLIANCE: [
    'gdpr.request',
    'audit.pull',
    'nhi.activity',
    'breakglass',
    'duplicate.identity',
    'namecollision',
  ],
} as const satisfies Record<EventCategory, readonly EventKind[]>;

/** All event kinds in a stable, category-ordered array. */
export const ALL_EVENT_KINDS: readonly EventKind[] = Object.values(
  EVENT_KINDS_BY_CATEGORY,
).flat();

/** All event categories in a stable order. */
export const ALL_EVENT_CATEGORIES: readonly EventCategory[] = Object.keys(
  EVENT_KINDS_BY_CATEGORY,
) as EventCategory[];

/**
 * Reverse lookup kind -> category, derived from EVENT_KINDS_BY_CATEGORY so it can
 * never drift. Import this rather than hard-coding the mapping.
 */
export const EVENT_CATEGORY: Record<EventKind, EventCategory> = Object.fromEntries(
  (Object.entries(EVENT_KINDS_BY_CATEGORY) as [EventCategory, readonly EventKind[]][]).flatMap(
    ([category, kinds]) => kinds.map((kind) => [kind, category] as const),
  ),
) as Record<EventKind, EventCategory>;

/** Convenience accessor for the category of an event kind. */
export function eventCategoryOf(kind: EventKind): EventCategory {
  return EVENT_CATEGORY[kind];
}

/** Seniority ordering for grades (higher = more senior). Drives promotion logic. */
export const GRADE_SENIORITY: Record<Grade, number> = {
  Intern: 0,
  Contractor: 1,
  Analyst: 2,
  Associate: 3,
  AVP: 4,
  VP: 5,
  Director: 6,
  MD: 7,
};

/** The eight modeled divisions, for seeding and iteration. */
export const ALL_DIVISIONS: readonly Division[] = [
  'Investment Bank',
  'Corporate Bank',
  'Private Bank',
  'Asset Management',
  'Technology, Data & Innovation',
  'Operations',
  'Risk',
  'Compliance',
  'Human Resources',
  'Finance',
];

/** The eight modeled site codes, for seeding and iteration. */
export const ALL_LOCATIONS: readonly LocationCode[] = [
  'FFT',
  'LDN',
  'NYC',
  'SIN',
  'HKG',
  'BLR',
  'PNQ',
  'JAX',
];
