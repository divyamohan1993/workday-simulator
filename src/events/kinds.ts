/**
 * Per-category event-kind arrays and their derived union types.
 *
 * WHY this small module exists: the category builders each need the union of kinds in
 * their category (so their switch is exhaustive and type-safe), derived from the
 * frozen `EVENT_KINDS_BY_CATEGORY`. Deriving it inline forces a value import used only
 * in a `typeof`, which the lint rules (rightly) want as a type import, yet a type-only
 * import cannot back a `typeof` query. Centralizing the derivation here, where the
 * value is genuinely used at runtime to build the exported arrays, resolves that
 * tension and removes the same derivation repeated across five builders.
 */

import { EVENT_KINDS_BY_CATEGORY } from '../types/index.js';

/** The AUTH event kinds, in category order. */
export const AUTH_KINDS = EVENT_KINDS_BY_CATEGORY.AUTH;
/** The JML event kinds, in category order. */
export const JML_KINDS = EVENT_KINDS_BY_CATEGORY.JML;
/** The ACCESS event kinds, in category order. */
export const ACCESS_KINDS = EVENT_KINDS_BY_CATEGORY.ACCESS;
/** The TXN event kinds, in category order. */
export const TXN_KINDS = EVENT_KINDS_BY_CATEGORY.TXN;
/** The COMPLIANCE event kinds, in category order. */
export const COMPLIANCE_KINDS = EVENT_KINDS_BY_CATEGORY.COMPLIANCE;

export type AuthKind = (typeof AUTH_KINDS)[number];
export type JmlKind = (typeof JML_KINDS)[number];
export type AccessKind = (typeof ACCESS_KINDS)[number];
export type TxnKind = (typeof TXN_KINDS)[number];
export type ComplianceKind = (typeof COMPLIANCE_KINDS)[number];
