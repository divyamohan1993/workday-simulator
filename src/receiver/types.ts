/**
 * Internal type surface for the built-in receiver.
 *
 * These types are private to `src/receiver/**`; the module's only public contract
 * export is `createReceiver` (see `index.ts`). Cross-cutting domain types come from
 * `../types/index.js`; SCIM resource shapes come from `../domain/scim.js`. Nothing
 * here is re-exported from the module barrel.
 */

import type {
  EntitlementType,
  ProvisioningOperation,
  ProvisioningResource,
} from '../types/index.js';

/**
 * A downstream connector profile: how long it takes to provision and how often it
 * fails. `minLatencyMs`/`maxLatencyMs` bound a uniform draw; `failureRate` is the
 * probability a single task fails; `concurrency` caps simultaneous in-flight work,
 * which is what turns a burst into a growing queue (backpressure).
 */
export interface ConnectorProfile {
  name: string;
  minLatencyMs: number;
  maxLatencyMs: number;
  /** Probability in [0,1] that a single provisioning task fails. */
  failureRate: number;
  /** Maximum simultaneously in-flight tasks on this connector. */
  concurrency: number;
}

/**
 * One unit of downstream provisioning work routed to a connector. `enqueuedAtMs`
 * is when it entered the connector queue; the measured provisioning latency is
 * `completedAtMs - enqueuedAtMs`, so time spent waiting behind a deep queue counts
 * against the latency, which is exactly how backpressure shows up in telemetry.
 */
export interface ProvisioningTask {
  id: string;
  connector: string;
  userId: string;
  operation: ProvisioningOperation;
  resource: ProvisioningResource;
  enqueuedAtMs: number;
}

/** Callback fired when a connector finishes a task (success or failure). */
export type ConnectorCompletionHandler = (
  task: ProvisioningTask,
  ok: boolean,
  latencyMs: number,
) => void;

/**
 * A provisioning request before it is expanded into connector tasks. Identity
 * operations fan out to the account and mailbox connectors; entitlement
 * operations route to the connector for their `system`.
 */
export interface ProvisionRequest {
  userId: string;
  operation: ProvisioningOperation;
  resource: ProvisioningResource;
  /** Target system for entitlement operations; drives connector routing. */
  system?: string;
}

/**
 * An entitlement the receiver believes a user holds, tracked for SoD evaluation.
 * `sodTags` are the abstract duties classified from the grant's name/system; they
 * are what the frozen SoD rules match on. Name/system/type are best-effort: SCIM
 * group membership PATCHes may not carry them, the ingest event stream does.
 */
export interface HeldEntitlement {
  id: string;
  system?: string;
  name?: string;
  type?: EntitlementType;
  sodTags: string[];
}

/** A recorded SoD finding, kept in a bounded ring for inspection and counting. */
export interface SodFinding {
  userId: string;
  ruleId: string;
  ruleName: string;
  entitlementIds: [string, string];
  at: string;
}

/** A recorded orphan or dormant finding, kept in a bounded ring. */
export interface AccountFinding {
  kind: 'orphan' | 'dormant';
  accountId: string;
  detail: string;
  at: string;
}

/** Outcome of an inbound rate-limit / backpressure decision. */
export interface AdmissionDecision {
  admitted: boolean;
  /** Seconds to advise the caller to wait, set only when `admitted` is false. */
  retryAfterSec: number;
  /** Why admission was refused, for structured logging. */
  reason?: 'rate_limited' | 'backpressure';
}
