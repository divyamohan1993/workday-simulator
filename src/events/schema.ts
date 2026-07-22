/**
 * Runtime zod schemas mirroring the frozen event types, for validating generated
 * events (and any inbound event the receiver or delivery adapter wishes to check).
 *
 * WHY this lives in the events module and why it is safe: the frozen `src/types`
 * defines the event shapes as TypeScript only; a traffic generator must be able to
 * prove at runtime that what it emits actually matches those shapes, which is exactly
 * what the payload-validity tests assert. To stop these schemas from silently drifting
 * from the types they mirror, every payload schema carries a compile-time parity guard
 * (`Equals<z.infer<typeof schema>, PayloadType>`): if a schema and its type diverge,
 * this file fails to type-check, localizing the break to one line.
 *
 * The enum schemas are reused from the frozen `contracts/validation.ts` where they
 * already exist (and are themselves parity-guarded), so there is one definition of the
 * division, location, grade, kind and risk vocabularies.
 */

import { z } from 'zod';
import {
  divisionSchema,
  employeeTypeSchema,
  eventCategorySchema,
  eventKindSchema,
  gradeSchema,
  locationSchema,
  riskLevelSchema,
} from '../contracts/validation.js';
import type {
  AccessApprovePayload,
  AccessDenyPayload,
  AccessProvisionPayload,
  AccessRequestPayload,
  AccessRevokePayload,
  AccountLockoutPayload,
  ActorRef,
  AuditPullPayload,
  BreakglassPayload,
  CardTxnPayload,
  ContractExpiryPayload,
  ContractorConvertPayload,
  DormantDetectedPayload,
  DuplicateIdentityPayload,
  EntitlementRef,
  EventDeliveryMeta,
  EventKind,
  FirefighterGrantPayload,
  FirefighterRevokePayload,
  GdprRequestPayload,
  GeoPoint,
  HighValueAlertPayload,
  IdentityRef,
  ImpossibleTravelPayload,
  JoinerHirePayload,
  LeaverLoaPayload,
  LeaverResignationPayload,
  LeaverTerminationPayload,
  LimitBreachPayload,
  LoginFailurePayload,
  LoginSuccessPayload,
  MfaChallengePayload,
  MfaFailurePayload,
  MfaSuccessPayload,
  MoverManagerChangePayload,
  MoverPromotionPayload,
  MoverTransferPayload,
  NameCollisionPayload,
  NhiActivityPayload,
  OrphanDetectedPayload,
  PasswordResetPayload,
  PaymentSepaPayload,
  PaymentSwiftPayload,
  RecertificationPayload,
  RehirePayload,
  SessionEndPayload,
  SessionStartPayload,
  SodViolationPayload,
  SsoFederationPayload,
  StepUpPayload,
  TradeBookPayload,
  WireApprovalPayload,
  WorkdayEvent,
} from '../types/index.js';

/** True only when A and B are the same type (order-independent). */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/**
 * True when A and B are mutually assignable. Used for the ActorRef union, whose
 * members are intersections (`{ kind } & IdentityRef`); the strict `Equals` above
 * distinguishes an intersection from its flattened object form even though they accept
 * the same values, so mutual assignability is the correct equivalence there. The
 * tuple wrappers stop the conditional from distributing over the union.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/* --- Shared sub-schemas ---------------------------------------------------- */

const entitlementTypeSchema = z.enum(['role', 'group', 'profile', 'privileged', 'firefighter', 'account', 'application']);
const severitySchema = z.enum(['info', 'notice', 'warning', 'error', 'critical']);
const provisioningOperationSchema = z.enum(['create', 'update', 'patch', 'deactivate', 'reactivate', 'delete', 'grant', 'revoke', 'notify', 'noop']);
const provisioningResourceSchema = z.enum(['identity', 'entitlement', 'group', 'account', 'session', 'event']);
const prioritySchema = z.enum(['low', 'normal', 'high', 'critical']);

export const geoPointSchema = z.object({
  city: z.string(),
  country: z.string(),
  lat: z.number(),
  lng: z.number(),
});

export const identityRefSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  displayName: z.string(),
  email: z.string(),
  division: divisionSchema,
  location: locationSchema,
  grade: gradeSchema,
  type: employeeTypeSchema,
});

export const entitlementRefSchema = z.object({
  id: z.string(),
  system: z.string(),
  name: z.string(),
  type: entitlementTypeSchema,
  risk: riskLevelSchema,
});

export const actorRefSchema = z.discriminatedUnion('kind', [
  identityRefSchema.extend({ kind: z.literal('employee') }),
  identityRefSchema.extend({ kind: z.literal('service') }),
  z.object({ kind: z.literal('system'), id: z.string(), component: z.string() }),
]);

export const eventDeliveryMetaSchema = z.object({
  operation: provisioningOperationSchema,
  resource: provisioningResourceSchema,
  idempotencyKey: z.string(),
  priority: prioritySchema,
  requiresApproval: z.boolean(),
});

/* --- AUTH payload schemas -------------------------------------------------- */

const mfaFactorSchema = z.enum(['totp', 'push', 'sms', 'webauthn', 'hardware_token']);

export const loginSuccessSchema = z.object({
  ip: z.string(),
  userAgent: z.string(),
  method: z.enum(['password', 'sso', 'certificate', 'passkey']),
  geo: geoPointSchema,
  deviceId: z.string(),
  sessionId: z.string(),
  riskScore: z.number(),
});
export const loginFailureSchema = z.object({
  ip: z.string(),
  userAgent: z.string(),
  reason: z.enum(['bad_password', 'unknown_user', 'disabled', 'locked', 'expired', 'mfa_required']),
  attemptCount: z.number(),
  geo: geoPointSchema,
});
export const mfaChallengeSchema = z.object({
  sessionId: z.string(),
  factor: mfaFactorSchema,
  reason: z.enum(['login', 'stepup', 'high_risk', 'new_device']),
});
export const mfaSuccessSchema = z.object({ sessionId: z.string(), factor: mfaFactorSchema, latencyMs: z.number() });
export const mfaFailureSchema = z.object({
  sessionId: z.string(),
  factor: mfaFactorSchema,
  reason: z.enum(['timeout', 'rejected', 'wrong_code', 'exhausted']),
  attemptCount: z.number(),
});
export const passwordResetSchema = z.object({
  channel: z.enum(['self_service', 'helpdesk', 'forced']),
  reason: z.enum(['forgotten', 'expired', 'compromise', 'policy']),
  ticketId: z.string().optional(),
});
export const accountLockoutSchema = z.object({
  reason: z.enum(['failed_attempts', 'admin', 'risk', 'impossible_travel']),
  failedAttempts: z.number(),
  unlockAt: z.string().optional(),
});
export const sessionStartSchema = z.object({ sessionId: z.string(), ip: z.string(), deviceId: z.string(), appId: z.string() });
export const sessionEndSchema = z.object({
  sessionId: z.string(),
  durationSec: z.number(),
  reason: z.enum(['logout', 'timeout', 'revoked', 'expired']),
});
export const ssoFederationSchema = z.object({
  idp: z.enum(['AzureAD', 'PingFederate', 'ADFS', 'Okta']),
  protocol: z.enum(['SAML', 'OIDC']),
  spEntityId: z.string(),
  assertionId: z.string(),
});
export const stepUpSchema = z.object({
  sessionId: z.string(),
  resource: z.string(),
  reason: z.enum(['high_value_txn', 'privileged_access', 'policy']),
  satisfied: z.boolean(),
});
export const impossibleTravelSchema = z.object({
  fromGeo: geoPointSchema,
  toGeo: geoPointSchema,
  distanceKm: z.number(),
  deltaMinutes: z.number(),
  impliedSpeedKmh: z.number(),
  priorIp: z.string(),
  currentIp: z.string(),
});

/* --- JML payload schemas --------------------------------------------------- */

export const joinerHireSchema = z.object({
  effectiveDate: z.string(),
  employeeType: employeeTypeSchema,
  division: divisionSchema,
  grade: gradeSchema,
  managerId: z.string().nullable(),
  location: locationSchema,
  contractType: z.enum(['permanent', 'fixed_term', 'agency', 'internship']),
  positionId: z.string(),
  birthrightEntitlements: z.array(z.string()),
});
export const moverTransferSchema = z.object({
  fromDivision: divisionSchema,
  toDivision: divisionSchema,
  fromLocation: locationSchema,
  toLocation: locationSchema,
  fromCostCenter: z.string(),
  toCostCenter: z.string(),
  effectiveDate: z.string(),
  retainedEntitlements: z.array(z.string()),
  revokedEntitlements: z.array(z.string()),
});
export const moverPromotionSchema = z.object({
  fromGrade: gradeSchema,
  toGrade: gradeSchema,
  effectiveDate: z.string(),
  newTitle: z.string(),
});
export const moverManagerChangeSchema = z.object({
  fromManagerId: z.string().nullable(),
  toManagerId: z.string(),
  effectiveDate: z.string(),
  partOfReorg: z.boolean(),
});
export const leaverTerminationSchema = z.object({
  reason: z.enum(['performance', 'misconduct', 'gross_misconduct', 'redundancy']),
  immediate: z.boolean(),
  lastWorkingDay: z.string(),
  revokeImmediately: z.boolean(),
  escortRequired: z.boolean(),
});
export const leaverResignationSchema = z.object({
  noticePeriodDays: z.number(),
  lastWorkingDay: z.string(),
  rehireEligible: z.boolean(),
});
export const leaverLoaSchema = z.object({
  loaType: z.enum(['maternity', 'paternity', 'medical', 'sabbatical', 'garden_leave']),
  startDate: z.string(),
  expectedReturn: z.string().optional(),
  suspendAccess: z.boolean(),
});
export const rehireSchema = z.object({
  previousEmployeeId: z.string(),
  gapDays: z.number(),
  restoredEntitlements: z.array(z.string()),
});
export const contractorConvertSchema = z.object({
  fromType: employeeTypeSchema,
  toType: employeeTypeSchema,
  effectiveDate: z.string(),
  newEmployeeId: z.string(),
});
export const contractExpirySchema = z.object({
  contractEndDate: z.string(),
  autoRevoke: z.boolean(),
  extensionGranted: z.boolean(),
});

/* --- ACCESS payload schemas ------------------------------------------------ */

export const accessRequestSchema = z.object({
  requestId: z.string(),
  entitlement: entitlementRefSchema,
  businessJustification: z.string(),
  forSubjectId: z.string(),
  riskLevel: riskLevelSchema,
  sodPreCheck: z.enum(['clear', 'conflict']),
  channel: z.enum(['self_service', 'manager', 'birthright', 'role_mining']),
});
export const accessApproveSchema = z.object({
  requestId: z.string(),
  approverId: z.string(),
  approvalLevel: z.number(),
  slaMs: z.number(),
  comment: z.string().optional(),
});
export const accessDenySchema = z.object({
  requestId: z.string(),
  approverId: z.string(),
  reason: z.enum(['sod_conflict', 'insufficient_justification', 'policy', 'risk']),
});
export const accessProvisionSchema = z.object({
  requestId: z.string().optional(),
  entitlement: entitlementRefSchema,
  targetSystem: z.string(),
  connector: z.string(),
  provisioningMode: z.enum(['automated', 'manual']),
  latencyMs: z.number(),
});
export const accessRevokeSchema = z.object({
  entitlement: entitlementRefSchema,
  reason: z.enum(['leaver', 'mover', 'recert_fail', 'sod', 'expiry', 'manual']),
  targetSystem: z.string(),
  connector: z.string(),
});
export const recertificationSchema = z.object({
  campaignId: z.string(),
  decision: z.enum(['certify', 'revoke', 'delegate']),
  reviewerId: z.string(),
  itemCount: z.number(),
  entitlement: entitlementRefSchema.optional(),
});
export const firefighterGrantSchema = z.object({
  role: z.string(),
  system: z.string(),
  reason: z.string(),
  ticketId: z.string(),
  expiresAt: z.string(),
  approverId: z.string(),
});
export const firefighterRevokeSchema = z.object({
  role: z.string(),
  system: z.string(),
  sessionDurationSec: z.number(),
  actionsLogged: z.number(),
});
export const sodViolationSchema = z.object({
  ruleId: z.string(),
  ruleName: z.string(),
  conflictingEntitlements: z.tuple([entitlementRefSchema, entitlementRefSchema]),
  severity: riskLevelSchema,
  mitigation: z.enum(['blocked', 'exception_granted', 'flagged']),
  exceptionApprover: z.string().optional(),
});
export const orphanDetectedSchema = z.object({
  accountId: z.string(),
  system: z.string(),
  lastOwnerId: z.string().optional(),
  lastActivityAt: z.string(),
  ageDays: z.number(),
});
export const dormantDetectedSchema = z.object({
  accountId: z.string(),
  system: z.string(),
  dormantDays: z.number(),
  lastLoginAt: z.string(),
});

/* --- TXN payload schemas --------------------------------------------------- */

export const paymentSepaSchema = z.object({
  txnId: z.string(),
  amount: z.number(),
  currency: z.literal('EUR'),
  debtorIban: z.string(),
  creditorIban: z.string(),
  instrument: z.enum(['SCT', 'SDD', 'SCT_Inst']),
  bic: z.string(),
  purpose: z.string(),
});
export const paymentSwiftSchema = z.object({
  txnId: z.string(),
  amount: z.number(),
  currency: z.string(),
  messageType: z.enum(['MT103', 'MT202', 'pacs.008']),
  senderBic: z.string(),
  receiverBic: z.string(),
  correspondentBic: z.string().optional(),
  uetr: z.string(),
});
export const tradeBookSchema = z.object({
  tradeId: z.string(),
  assetClass: z.enum(['Rates', 'Credit', 'FX', 'Equities', 'Commodities']),
  instrument: z.string(),
  notional: z.number(),
  currency: z.string(),
  book: z.string(),
  counterparty: z.string(),
  direction: z.enum(['buy', 'sell']),
});
export const cardTxnSchema = z.object({
  txnId: z.string(),
  panLast4: z.string(),
  amount: z.number(),
  currency: z.string(),
  merchant: z.string(),
  mcc: z.string(),
  channel: z.enum(['pos', 'ecom', 'atm']),
  country: z.string(),
  fraudScore: z.number(),
});
export const wireApprovalSchema = z.object({
  txnId: z.string(),
  amount: z.number(),
  currency: z.string(),
  approvalTier: z.number(),
  approverId: z.string(),
  dualControl: z.boolean(),
});
export const limitBreachSchema = z.object({
  limitType: z.enum(['intraday', 'settlement', 'credit', 'position']),
  limit: z.number(),
  exposure: z.number(),
  currency: z.string(),
  book: z.string(),
  breachPct: z.number(),
});
export const highValueAlertSchema = z.object({
  txnId: z.string(),
  amount: z.number(),
  currency: z.string(),
  threshold: z.number(),
  flaggedBy: z.enum(['aml', 'fraud', 'sanctions']),
  screeningStatus: z.enum(['pending', 'cleared', 'blocked']),
});

/* --- COMPLIANCE payload schemas -------------------------------------------- */

export const gdprRequestSchema = z.object({
  requestType: z.enum(['access', 'erasure', 'rectification', 'portability']),
  dataSubjectId: z.string(),
  regulation: z.enum(['GDPR', 'DPDPA']),
  dueDate: z.string(),
});
export const auditPullSchema = z.object({
  auditId: z.string(),
  scope: z.string(),
  requestedBy: z.string(),
  recordCount: z.number(),
  regulator: z.enum(['BaFin', 'ECB', 'FCA', 'MAS', 'HKMA', 'RBI', 'FED']).optional(),
});
export const nhiActivitySchema = z.object({
  serviceAccountId: z.string(),
  action: z.string(),
  targetSystem: z.string(),
  tokenType: z.enum(['oauth', 'api_key', 'certificate', 'kerberos']),
  secretRotatedAt: z.string().optional(),
  anomalous: z.boolean(),
});
export const breakglassSchema = z.object({
  accountId: z.string(),
  system: z.string(),
  reason: z.string(),
  approverId: z.string(),
  incidentId: z.string(),
  expiresAt: z.string(),
  sessionRecorded: z.boolean(),
});
export const duplicateIdentitySchema = z.object({
  candidateIds: z.array(z.string()),
  matchScore: z.number(),
  matchedAttributes: z.array(z.string()),
  resolution: z.enum(['merge', 'flag', 'ignore']),
});
export const nameCollisionSchema = z.object({
  collidingWith: z.array(z.string()),
  attribute: z.enum(['email', 'username', 'displayName']),
  generatedSuffix: z.string(),
  resolutionStrategy: z.enum(['numeric_suffix', 'middle_initial', 'location_suffix']),
});

/* --- Per-payload parity guards (drift becomes a compile error) ------------- */

const _pGeo: Equals<z.infer<typeof geoPointSchema>, GeoPoint> = true;
const _pIdRef: Equals<z.infer<typeof identityRefSchema>, IdentityRef> = true;
const _pEntRef: Equals<z.infer<typeof entitlementRefSchema>, EntitlementRef> = true;
const _pActor: MutuallyAssignable<z.infer<typeof actorRefSchema>, ActorRef> = true;
const _pDelivery: Equals<z.infer<typeof eventDeliveryMetaSchema>, EventDeliveryMeta> = true;
const _pLoginSuccess: Equals<z.infer<typeof loginSuccessSchema>, LoginSuccessPayload> = true;
const _pLoginFailure: Equals<z.infer<typeof loginFailureSchema>, LoginFailurePayload> = true;
const _pMfaChallenge: Equals<z.infer<typeof mfaChallengeSchema>, MfaChallengePayload> = true;
const _pMfaSuccess: Equals<z.infer<typeof mfaSuccessSchema>, MfaSuccessPayload> = true;
const _pMfaFailure: Equals<z.infer<typeof mfaFailureSchema>, MfaFailurePayload> = true;
const _pPasswordReset: Equals<z.infer<typeof passwordResetSchema>, PasswordResetPayload> = true;
const _pAccountLockout: Equals<z.infer<typeof accountLockoutSchema>, AccountLockoutPayload> = true;
const _pSessionStart: Equals<z.infer<typeof sessionStartSchema>, SessionStartPayload> = true;
const _pSessionEnd: Equals<z.infer<typeof sessionEndSchema>, SessionEndPayload> = true;
const _pSso: Equals<z.infer<typeof ssoFederationSchema>, SsoFederationPayload> = true;
const _pStepUp: Equals<z.infer<typeof stepUpSchema>, StepUpPayload> = true;
const _pImpossible: Equals<z.infer<typeof impossibleTravelSchema>, ImpossibleTravelPayload> = true;
const _pHire: Equals<z.infer<typeof joinerHireSchema>, JoinerHirePayload> = true;
const _pTransfer: Equals<z.infer<typeof moverTransferSchema>, MoverTransferPayload> = true;
const _pPromotion: Equals<z.infer<typeof moverPromotionSchema>, MoverPromotionPayload> = true;
const _pManagerChange: Equals<z.infer<typeof moverManagerChangeSchema>, MoverManagerChangePayload> = true;
const _pTermination: Equals<z.infer<typeof leaverTerminationSchema>, LeaverTerminationPayload> = true;
const _pResignation: Equals<z.infer<typeof leaverResignationSchema>, LeaverResignationPayload> = true;
const _pLoa: Equals<z.infer<typeof leaverLoaSchema>, LeaverLoaPayload> = true;
const _pRehire: Equals<z.infer<typeof rehireSchema>, RehirePayload> = true;
const _pConvert: Equals<z.infer<typeof contractorConvertSchema>, ContractorConvertPayload> = true;
const _pExpiry: Equals<z.infer<typeof contractExpirySchema>, ContractExpiryPayload> = true;
const _pAccessRequest: Equals<z.infer<typeof accessRequestSchema>, AccessRequestPayload> = true;
const _pAccessApprove: Equals<z.infer<typeof accessApproveSchema>, AccessApprovePayload> = true;
const _pAccessDeny: Equals<z.infer<typeof accessDenySchema>, AccessDenyPayload> = true;
const _pAccessProvision: Equals<z.infer<typeof accessProvisionSchema>, AccessProvisionPayload> = true;
const _pAccessRevoke: Equals<z.infer<typeof accessRevokeSchema>, AccessRevokePayload> = true;
const _pRecert: Equals<z.infer<typeof recertificationSchema>, RecertificationPayload> = true;
const _pFfGrant: Equals<z.infer<typeof firefighterGrantSchema>, FirefighterGrantPayload> = true;
const _pFfRevoke: Equals<z.infer<typeof firefighterRevokeSchema>, FirefighterRevokePayload> = true;
const _pSod: Equals<z.infer<typeof sodViolationSchema>, SodViolationPayload> = true;
const _pOrphan: Equals<z.infer<typeof orphanDetectedSchema>, OrphanDetectedPayload> = true;
const _pDormant: Equals<z.infer<typeof dormantDetectedSchema>, DormantDetectedPayload> = true;
const _pSepa: Equals<z.infer<typeof paymentSepaSchema>, PaymentSepaPayload> = true;
const _pSwift: Equals<z.infer<typeof paymentSwiftSchema>, PaymentSwiftPayload> = true;
const _pTrade: Equals<z.infer<typeof tradeBookSchema>, TradeBookPayload> = true;
const _pCard: Equals<z.infer<typeof cardTxnSchema>, CardTxnPayload> = true;
const _pWire: Equals<z.infer<typeof wireApprovalSchema>, WireApprovalPayload> = true;
const _pLimit: Equals<z.infer<typeof limitBreachSchema>, LimitBreachPayload> = true;
const _pHighValue: Equals<z.infer<typeof highValueAlertSchema>, HighValueAlertPayload> = true;
const _pGdpr: Equals<z.infer<typeof gdprRequestSchema>, GdprRequestPayload> = true;
const _pAudit: Equals<z.infer<typeof auditPullSchema>, AuditPullPayload> = true;
const _pNhi: Equals<z.infer<typeof nhiActivitySchema>, NhiActivityPayload> = true;
const _pBreakglass: Equals<z.infer<typeof breakglassSchema>, BreakglassPayload> = true;
const _pDuplicate: Equals<z.infer<typeof duplicateIdentitySchema>, DuplicateIdentityPayload> = true;
const _pNameCollision: Equals<z.infer<typeof nameCollisionSchema>, NameCollisionPayload> = true;

// Reference the guards so the unused-variable check treats them as consumed.
void [
  _pGeo, _pIdRef, _pEntRef, _pActor, _pDelivery, _pLoginSuccess, _pLoginFailure, _pMfaChallenge,
  _pMfaSuccess, _pMfaFailure, _pPasswordReset, _pAccountLockout, _pSessionStart, _pSessionEnd, _pSso,
  _pStepUp, _pImpossible, _pHire, _pTransfer, _pPromotion, _pManagerChange, _pTermination, _pResignation,
  _pLoa, _pRehire, _pConvert, _pExpiry, _pAccessRequest, _pAccessApprove, _pAccessDeny, _pAccessProvision,
  _pAccessRevoke, _pRecert, _pFfGrant, _pFfRevoke, _pSod, _pOrphan, _pDormant, _pSepa, _pSwift, _pTrade,
  _pCard, _pWire, _pLimit, _pHighValue, _pGdpr, _pAudit, _pNhi, _pBreakglass, _pDuplicate, _pNameCollision,
];

/* --- Envelope schema and the kind -> payload map --------------------------- */

/** The base envelope plus discriminant and an unchecked payload slot. */
export const eventEnvelopeSchema = z.object({
  id: z.string(),
  kind: eventKindSchema,
  category: eventCategorySchema,
  timestamp: z.string(),
  emittedAtWall: z.string(),
  correlationId: z.string(),
  causationId: z.string().optional(),
  severity: severitySchema,
  actor: actorRefSchema,
  subject: identityRefSchema.optional(),
  location: locationSchema,
  division: divisionSchema,
  delivery: eventDeliveryMetaSchema,
  seq: z.number(),
  payload: z.unknown(),
});

/** Kind -> payload schema. Complete over the frozen `EventKind` union. */
export const PAYLOAD_SCHEMAS: Record<EventKind, z.ZodType> = {
  'login.success': loginSuccessSchema,
  'login.failure': loginFailureSchema,
  'mfa.challenge': mfaChallengeSchema,
  'mfa.success': mfaSuccessSchema,
  'mfa.failure': mfaFailureSchema,
  'password.reset': passwordResetSchema,
  'account.lockout': accountLockoutSchema,
  'session.start': sessionStartSchema,
  'session.end': sessionEndSchema,
  'sso.federation': ssoFederationSchema,
  stepup: stepUpSchema,
  'impossible.travel': impossibleTravelSchema,
  'joiner.hire': joinerHireSchema,
  'mover.transfer': moverTransferSchema,
  'mover.promotion': moverPromotionSchema,
  'mover.manager_change': moverManagerChangeSchema,
  'leaver.termination': leaverTerminationSchema,
  'leaver.resignation': leaverResignationSchema,
  'leaver.loa': leaverLoaSchema,
  rehire: rehireSchema,
  'contractor.convert': contractorConvertSchema,
  'contract.expiry': contractExpirySchema,
  'access.request': accessRequestSchema,
  'access.approve': accessApproveSchema,
  'access.deny': accessDenySchema,
  'access.provision': accessProvisionSchema,
  'access.revoke': accessRevokeSchema,
  recertification: recertificationSchema,
  'firefighter.grant': firefighterGrantSchema,
  'firefighter.revoke': firefighterRevokeSchema,
  'sod.violation': sodViolationSchema,
  'orphan.detected': orphanDetectedSchema,
  'dormant.detected': dormantDetectedSchema,
  'payment.sepa': paymentSepaSchema,
  'payment.swift': paymentSwiftSchema,
  'trade.book': tradeBookSchema,
  'card.txn': cardTxnSchema,
  'wire.approval': wireApprovalSchema,
  'limit.breach': limitBreachSchema,
  'highvalue.alert': highValueAlertSchema,
  'gdpr.request': gdprRequestSchema,
  'audit.pull': auditPullSchema,
  'nhi.activity': nhiActivitySchema,
  breakglass: breakglassSchema,
  'duplicate.identity': duplicateIdentitySchema,
  namecollision: nameCollisionSchema,
};

/**
 * Validate a value as a complete, well-formed `WorkdayEvent`: the envelope first, then
 * the payload against the schema for the event's kind. Throws a `ZodError` on any
 * mismatch, so tests can assert an event parses (or a receiver can reject bad input).
 *
 * @param value The value to validate.
 * @returns The value typed as a `WorkdayEvent` once validated.
 */
export function parseEvent(value: unknown): WorkdayEvent {
  const envelope = eventEnvelopeSchema.parse(value);
  const payloadSchema = PAYLOAD_SCHEMAS[envelope.kind];
  payloadSchema.parse(envelope.payload);
  return value as WorkdayEvent;
}

/**
 * Non-throwing variant of {@link parseEvent}: returns whether the value is a valid
 * `WorkdayEvent`.
 *
 * @param value The value to check.
 * @returns True when the value is a structurally valid event.
 */
export function isValidEvent(value: unknown): boolean {
  const envelope = eventEnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    return false;
  }
  return PAYLOAD_SCHEMAS[envelope.data.kind].safeParse(envelope.data.payload).success;
}
