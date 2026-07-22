/**
 * Realistic per-event outcome and failure rates.
 *
 * WHY this is a single named table rather than magic numbers scattered through the
 * builders: the whole point of a production-like traffic generator is that the
 * failure mix matches reality (a few percent of logins fail, MFA fails less often,
 * a minority of access requests are denied, a handful of transactions trip
 * screening). Centralizing the probabilities means the generator and its band tests
 * read from ONE source, so "the failure rate is within band" is a property of a
 * documented constant, not an accident of a literal buried in a switch.
 *
 * These are the WITHIN-KIND and WITHIN-SAGA outcome rates. The cross-kind ratio of
 * whole failure kinds to their success counterparts (login.failure vs login.success)
 * is expressed instead through the event-mix weights in `event-mix.ts`, because the
 * engine samples those two as independent kinds.
 */

/**
 * Outcome probabilities used across the builders and asserted by the rate-band tests.
 * Each value is the probability of the named outcome for one generated event of the
 * relevant kind or saga step. Values are chosen from published IAM/banking baselines
 * and kept conservative so a band test with a reasonable tolerance is stable.
 */
export const EVENT_RATES = {
  /** MFA challenge that ends in failure (timeout/rejected/wrong code). Lower than login failure. */
  mfaFailure: 0.02,
  /** A login.success saga that triggers an MFA challenge step at all (new device / step-up). */
  loginTriggersMfa: 0.35,
  /** A login.success saga that opens a session afterwards. */
  loginOpensSession: 0.85,
  /** login.failure attempt that has already crossed the lockout threshold. */
  lockoutOnFailure: 0.12,
  /** Access request that is denied rather than approved. */
  accessDeny: 0.18,
  /** Approved access request that proceeds to an automated provision. */
  accessProvisionAfterApprove: 0.92,
  /** Access request whose pre-check already flags an SoD conflict. */
  accessSodPreCheckConflict: 0.08,
  /** SoD violation that is hard-blocked (vs exception-granted / flagged). */
  sodBlocked: 0.55,
  /** SoD violation that is allowed through with a documented exception. */
  sodException: 0.2,
  /** Card transaction scored as likely fraud (fraudScore > 80). */
  cardFraud: 0.03,
  /** High-value alert that screening blocks outright. */
  highValueBlocked: 0.15,
  /** High-value alert still pending manual screening. */
  highValuePending: 0.25,
  /** Step-up authentication that is satisfied by the user. */
  stepUpSatisfied: 0.9,
  /** NHI (service-account) activity flagged anomalous. */
  nhiAnomalous: 0.06,
  /** SWIFT/large payment that requires a dual-control wire approval follow-on. */
  wireApprovalRequired: 0.3,
  /** Recertification item decided as revoke (vs certify/delegate). */
  recertRevoke: 0.15,
  /** Impossible-travel detection that escalates to an account lockout. */
  impossibleTravelLockout: 0.4,
} as const;

/** A convenient union of the tunable rate keys. */
export type EventRateKey = keyof typeof EVENT_RATES;
