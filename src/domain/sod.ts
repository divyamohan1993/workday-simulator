/**
 * Segregation-of-duties (SoD) rule set and conflict detection.
 *
 * WHY this module exists: SoD enforcement is a core reason an identity manager
 * exists, so the simulator must model real toxic combinations (the same person able
 * to both initiate and approve a payment, or both execute and settle a trade) and
 * detect them from the abstract duty tags carried on entitlements. The rules are
 * expressed over `sodTags` (from `entitlements.ts`), never over concrete grant
 * names, so a rule keeps working as the catalog grows.
 *
 * Detection is pure and deterministic: given a set of held entitlements it returns
 * the specific pairs of grants that violate a rule, which is exactly what the
 * `sod.violation` event and the pool's `sodConflicts` accessor need.
 */

import type { Entitlement, RiskLevel } from '../types/index.js';
import { SOD_TAG } from './entitlements.js';

/**
 * A segregation-of-duties rule: holding any tag from `tagsA` together with any tag
 * from `tagsB` (on two DIFFERENT grants) is a toxic combination. Keeping the two
 * sides as tag sets lets one rule cover many concrete grant combinations.
 */
export interface SodRule {
  id: string;
  name: string;
  description: string;
  severity: RiskLevel;
  tagsA: readonly string[];
  tagsB: readonly string[];
}

/** The bank's toxic-combination rule set. Each rule maps to a real control. */
export const SOD_RULES: readonly SodRule[] = [
  {
    id: 'SOD-PAY-01',
    name: 'Payment initiation and approval',
    description: 'The same identity can both initiate and approve or release a payment.',
    severity: 'critical',
    tagsA: [SOD_TAG.PAYMENT_INITIATE],
    tagsB: [SOD_TAG.PAYMENT_APPROVE, SOD_TAG.PAYMENT_RELEASE],
  },
  {
    id: 'SOD-TRD-01',
    name: 'Trade execution and settlement',
    description: 'The same identity can both execute and settle a trade (front-to-back).',
    severity: 'high',
    tagsA: [SOD_TAG.TRADE_EXECUTE],
    tagsB: [SOD_TAG.TRADE_SETTLE],
  },
  {
    id: 'SOD-TRD-02',
    name: 'Trade execution and confirmation',
    description: 'The same identity can both execute and confirm a trade.',
    severity: 'high',
    tagsA: [SOD_TAG.TRADE_EXECUTE],
    tagsB: [SOD_TAG.TRADE_CONFIRM],
  },
  {
    id: 'SOD-VND-01',
    name: 'Vendor master and payment authority',
    description: 'The same identity can create vendors and approve or release payments to them.',
    severity: 'critical',
    tagsA: [SOD_TAG.VENDOR_MAINTAIN],
    tagsB: [SOD_TAG.PAYMENT_APPROVE, SOD_TAG.PAYMENT_RELEASE],
  },
  {
    id: 'SOD-GL-01',
    name: 'Ledger posting and reconciliation',
    description: 'The same identity can both post to and reconcile the general ledger.',
    severity: 'medium',
    tagsA: [SOD_TAG.GL_POST],
    tagsB: [SOD_TAG.GL_RECONCILE],
  },
  {
    id: 'SOD-IAM-01',
    name: 'Privileged administration and audit',
    description: 'The same identity holds privileged admin rights and reviews the audit of them.',
    severity: 'high',
    tagsA: [SOD_TAG.USER_ADMIN],
    tagsB: [SOD_TAG.AUDIT_REVIEW],
  },
  {
    id: 'SOD-IAM-02',
    name: 'Access request approval concentration',
    description: 'The same identity can approve access and holds standing privileged admin.',
    severity: 'medium',
    tagsA: [SOD_TAG.ACCESS_APPROVE],
    tagsB: [SOD_TAG.USER_ADMIN],
  },
];

/** A detected conflict: the two grants and the rule they violate. */
export interface SodConflict {
  rule: SodRule;
  pair: [Entitlement, Entitlement];
}

function hasAnyTag(entitlement: Entitlement, tags: readonly string[]): boolean {
  for (const tag of tags) {
    if (entitlement.sodTags.includes(tag)) {
      return true;
    }
  }
  return false;
}

/**
 * Find every toxic combination among a set of held entitlements. For each rule, any
 * grant carrying a `tagsA` duty paired with a DIFFERENT grant carrying a `tagsB`
 * duty is a conflict. Pairs are de-duplicated by grant-id so the same two grants are
 * never reported twice even when they satisfy a rule symmetrically.
 *
 * @param entitlements The identity's held grants.
 * @param rules The rule set to evaluate (defaults to the bank rule set).
 * @returns The conflicts, each with its rule and the offending pair.
 */
export function detectSodConflictsDetailed(
  entitlements: readonly Entitlement[],
  rules: readonly SodRule[] = SOD_RULES,
): SodConflict[] {
  const conflicts: SodConflict[] = [];
  const seenPairs = new Set<string>();

  for (const rule of rules) {
    const sideA = entitlements.filter((e) => hasAnyTag(e, rule.tagsA));
    if (sideA.length === 0) {
      continue;
    }
    const sideB = entitlements.filter((e) => hasAnyTag(e, rule.tagsB));
    if (sideB.length === 0) {
      continue;
    }
    for (const a of sideA) {
      for (const b of sideB) {
        if (a.id === b.id) {
          continue; // A single grant holding both duties is not a two-grant conflict.
        }
        const pairKey = a.id < b.id ? `${rule.id}:${a.id}:${b.id}` : `${rule.id}:${b.id}:${a.id}`;
        if (seenPairs.has(pairKey)) {
          continue;
        }
        seenPairs.add(pairKey);
        // Report in a stable order (lower id first) for deterministic output.
        const pair: [Entitlement, Entitlement] = a.id < b.id ? [a, b] : [b, a];
        conflicts.push({ rule, pair });
      }
    }
  }
  return conflicts;
}

/**
 * Convenience wrapper returning just the conflicting entitlement pairs, matching the
 * `IdentityPool.sodConflicts` return shape.
 *
 * @param entitlements The identity's held grants.
 * @param rules The rule set to evaluate (defaults to the bank rule set).
 * @returns The conflicting pairs.
 */
export function detectSodConflicts(
  entitlements: readonly Entitlement[],
  rules: readonly SodRule[] = SOD_RULES,
): Array<[Entitlement, Entitlement]> {
  return detectSodConflictsDetailed(entitlements, rules).map((c) => c.pair);
}
