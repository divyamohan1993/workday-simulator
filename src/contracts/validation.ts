import { z } from 'zod';
import type {
  ChaosInjectorKind,
  DeliveryAuthConfig,
  DeliveryKind,
  Division,
  EmployeeType,
  EventCategory,
  EventKind,
  Grade,
  LocationCode,
  RiskLevel,
} from '../types/index.js';

/**
 * Zod validation contract for the config-facing shapes. The REST API validates
 * every mutating request body against these schemas (all input is hostile).
 *
 * These schemas are a second, runtime representation of types that live in
 * `src/types/index.ts`. To stop the two from drifting, the enum schemas below are
 * guarded by compile-time parity assertions: if a TS union and its zod enum
 * diverge, this file fails to type-check.
 */

/** True only when A and B are the same type (order-independent for unions). */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/* --- Enum schemas ---------------------------------------------------------- */

export const eventKindSchema = z.enum([
  'login.success', 'login.failure', 'mfa.challenge', 'mfa.success', 'mfa.failure',
  'password.reset', 'account.lockout', 'session.start', 'session.end', 'sso.federation',
  'stepup', 'impossible.travel',
  'joiner.hire', 'mover.transfer', 'mover.promotion', 'mover.manager_change',
  'leaver.termination', 'leaver.resignation', 'leaver.loa', 'rehire',
  'contractor.convert', 'contract.expiry',
  'access.request', 'access.approve', 'access.deny', 'access.provision', 'access.revoke',
  'recertification', 'firefighter.grant', 'firefighter.revoke', 'sod.violation',
  'orphan.detected', 'dormant.detected',
  'payment.sepa', 'payment.swift', 'trade.book', 'card.txn', 'wire.approval',
  'limit.breach', 'highvalue.alert',
  'gdpr.request', 'audit.pull', 'nhi.activity', 'breakglass', 'duplicate.identity',
  'namecollision',
]);

export const eventCategorySchema = z.enum(['AUTH', 'JML', 'ACCESS', 'TXN', 'COMPLIANCE']);

export const divisionSchema = z.enum([
  'Investment Bank', 'Corporate Bank', 'Private Bank', 'Asset Management',
  'Technology, Data & Innovation', 'Operations', 'Risk', 'Compliance',
  'Human Resources', 'Finance',
]);

export const locationSchema = z.enum(['FFT', 'LDN', 'NYC', 'SIN', 'HKG', 'BLR', 'PNQ', 'JAX']);

export const gradeSchema = z.enum([
  'Intern', 'Contractor', 'Analyst', 'Associate', 'AVP', 'VP', 'Director', 'MD',
]);

export const employeeTypeSchema = z.enum(['FTE', 'Contractor', 'Intern', 'External', 'Service']);

export const deliveryKindSchema = z.enum(['scim', 'webhook', 'rest', 'nats', 'batch']);

export const chaosKindSchema = z.enum([
  'credential_stuffing', 'mass_termination_reorg', 'insider_threat', 'audit_season_surge',
  'ransomware_lateral', 'payroll_batch', 'mass_password_reset', 'connector_outage',
]);

export const riskLevelSchema = z.enum(['low', 'medium', 'high', 'critical']);

export const overflowPolicySchema = z.enum(['block', 'drop_new', 'drop_oldest']);

/* --- Compile-time parity guards (fail the build on drift) ------------------ */

const _parityEventKind: Equals<z.infer<typeof eventKindSchema>, EventKind> = true;
const _parityEventCategory: Equals<z.infer<typeof eventCategorySchema>, EventCategory> = true;
const _parityDivision: Equals<z.infer<typeof divisionSchema>, Division> = true;
const _parityLocation: Equals<z.infer<typeof locationSchema>, LocationCode> = true;
const _parityGrade: Equals<z.infer<typeof gradeSchema>, Grade> = true;
const _parityEmployeeType: Equals<z.infer<typeof employeeTypeSchema>, EmployeeType> = true;
const _parityDeliveryKind: Equals<z.infer<typeof deliveryKindSchema>, DeliveryKind> = true;
const _parityChaosKind: Equals<z.infer<typeof chaosKindSchema>, ChaosInjectorKind> = true;
const _parityRiskLevel: Equals<z.infer<typeof riskLevelSchema>, RiskLevel> = true;
void _parityEventKind;
void _parityEventCategory;
void _parityDivision;
void _parityLocation;
void _parityGrade;
void _parityEmployeeType;
void _parityDeliveryKind;
void _parityChaosKind;
void _parityRiskLevel;

/* --- Delivery target input ------------------------------------------------- */

export const deliveryAuthSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('bearer'), token: z.string().min(1) }),
  z.object({ kind: z.literal('basic'), username: z.string().min(1), password: z.string().min(1) }),
  z.object({
    kind: z.literal('oauth2_client_credentials'),
    tokenUrl: z.string().url(),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    scope: z.string().optional(),
  }),
  z.object({
    kind: z.literal('hmac'),
    algorithm: z.enum(['sha256', 'sha512']),
    secret: z.string().min(1),
    header: z.string().min(1),
    signaturePrefix: z.string().optional(),
  }),
]);

const _parityAuth: Equals<z.infer<typeof deliveryAuthSchema>, DeliveryAuthConfig> = true;
void _parityAuth;

export const deliveryRetrySchema = z.object({
  maxRetries: z.number().int().min(0).max(20).default(4),
  baseDelayMs: z.number().int().min(0).default(200),
  maxDelayMs: z.number().int().min(0).default(15_000),
  jitter: z.boolean().default(true),
  retryableStatuses: z.array(z.number().int()).default([408, 429, 500, 502, 503, 504]),
});

export const deliveryRateLimitSchema = z.object({
  rps: z.number().min(0).default(0),
  burst: z.number().int().min(0).default(0),
});

/**
 * Body of POST/PUT /api/targets. Server-managed fields (id, builtIn, timestamps)
 * are omitted and assigned by the server. `url` scheme is validated by the adapter
 * per kind (http(s) for scim/webhook/rest, nats:// for nats), not here.
 */
export const deliveryTargetInputSchema = z.object({
  name: z.string().min(1).max(120),
  kind: deliveryKindSchema,
  url: z.string().min(1).max(2048),
  auth: deliveryAuthSchema,
  headers: z.record(z.string(), z.string()).default({}),
  rateLimit: deliveryRateLimitSchema.prefault({}),
  concurrency: z.number().int().min(1).max(1024).default(16),
  retry: deliveryRetrySchema.prefault({}),
  queueHighWater: z.number().int().min(1).max(1_000_000).default(10_000),
  overflowPolicy: overflowPolicySchema.default('drop_oldest'),
  batchSize: z.number().int().min(1).max(10_000).optional(),
  natsSubject: z.string().max(256).optional(),
});

/* --- Chaos and scenario input --------------------------------------------- */

export const chaosInjectorConfigSchema = z.object({
  kind: chaosKindSchema,
  enabled: z.boolean().default(true),
  startAtSec: z.number().min(0).optional(),
  durationSec: z.number().min(0).optional(),
  intensity: z.number().min(0).max(1).default(0.5),
  params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).default({}),
});

/**
 * Organic threat weaving. All knobs but `enabled` are optional; the runtime's
 * `resolveThreatProfile` applies defaults and clamps. `kindWeights` keys are loose
 * strings (the scheduler only reads the known injector kinds and ignores the rest).
 */
export const threatProfileSchema = z.object({
  enabled: z.boolean().default(true),
  meanIntervalSimMin: z.number().min(1).max(1440).optional(),
  maxConcurrent: z.number().int().min(1).max(8).optional(),
  intensityMin: z.number().min(0).max(1).optional(),
  intensityMax: z.number().min(0).max(1).optional(),
  kindWeights: z.record(z.string(), z.number().min(0)).optional(),
});

/** Event-mix weights. Category keys are strict; per-kind overrides are loose. */
export const eventMixSchema = z.object({
  byCategory: z
    .object({
      AUTH: z.number().min(0).default(1),
      JML: z.number().min(0).default(0.2),
      ACCESS: z.number().min(0).default(0.6),
      TXN: z.number().min(0).default(1),
      COMPLIANCE: z.number().min(0).default(0.15),
    })
    .prefault({}),
  byKind: z.record(z.string(), z.number().min(0)).optional(),
});

/** Per-location activity weights. All eight sites default to a sane weight. */
export const timezoneWeightsSchema = z.object({
  byLocation: z
    .object({
      FFT: z.number().min(0).default(1),
      LDN: z.number().min(0).default(0.9),
      NYC: z.number().min(0).default(0.9),
      SIN: z.number().min(0).default(0.5),
      HKG: z.number().min(0).default(0.5),
      BLR: z.number().min(0).default(0.7),
      PNQ: z.number().min(0).default(0.5),
      JAX: z.number().min(0).default(0.4),
    })
    .prefault({}),
});

/**
 * Body of POST/PUT /api/scenarios. Server-managed fields (id, timestamps) are
 * omitted and assigned by the server.
 */
export const scenarioInputSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(''),
  baselineRps: z.number().min(0).max(1_000_000),
  maxRps: z.number().min(1).max(1_000_000),
  workdayAccel: z.number().min(1).max(86_400).default(60),
  startSimTime: z.string().datetime().optional(),
  timezoneWeights: timezoneWeightsSchema.prefault({}),
  eventMix: eventMixSchema.prefault({}),
  chaos: z.array(chaosInjectorConfigSchema).default([]),
  threatProfile: threatProfileSchema.optional(),
  targetId: z.string().min(1),
  durationSec: z.number().min(1).max(2_592_000).optional(),
  seed: z.string().max(128).optional(),
});

/** Body of POST /api/runs. `targetId` falls back to the scenario's target. */
export const runStartSchema = z.object({
  scenarioId: z.string().min(1),
  targetId: z.string().min(1).optional(),
});

/* --- Inferred input types (for handlers and stores) ------------------------ */

export type DeliveryTargetInput = z.infer<typeof deliveryTargetInputSchema>;
export type ScenarioInput = z.infer<typeof scenarioInputSchema>;
export type ChaosInjectInput = z.infer<typeof chaosInjectorConfigSchema>;
export type RunStartInput = z.infer<typeof runStartSchema>;
