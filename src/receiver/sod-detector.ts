/**
 * Segregation-of-duties evaluation as an identity manager sees it.
 *
 * WHY the receiver re-derives duties instead of trusting inbound tags: a real
 * OneIM enforces SoD over the entitlements it observes, classifying each grant to
 * an abstract duty from its own catalog knowledge. The wire does not carry
 * `sodTags` (a SCIM group membership PATCH carries only ids), so the receiver
 * classifies a grant's duty from its name/system using the shared Deutsche Bank
 * catalog, then applies the frozen `SOD_RULES` via the frozen detector. Reusing
 * the domain rule set and detector guarantees the receiver flags exactly the toxic
 * combinations the rest of the simulator understands, with no parallel rule table
 * to drift.
 *
 * Limitation, by design: a grant delivered purely over SCIM whose group was never
 * created with a display name is unclassifiable (opaque id, user-display-only
 * PATCH), so SoD is driven primarily by the ingest event stream, whose entitlement
 * references carry name+system+type. This mirrors reality: an IM can only enforce
 * SoD on entitlements it actually knows.
 */

import { ALL_ENTITLEMENT_TEMPLATES, SOD_TAG } from '../domain/entitlements.js';
import { detectSodConflictsDetailed, SOD_RULES, type SodConflict, type SodRule } from '../domain/sod.js';
import type { Entitlement, EntitlementType } from '../types/index.js';
import type { HeldEntitlement } from './types.js';

/** Concrete-grant label -> the abstract SoD duties that grant confers. */
const LABEL_TO_TAGS: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, readonly string[]>();
  for (const template of ALL_ENTITLEMENT_TEMPLATES) {
    if (template.sodTags.length > 0) map.set(template.label, template.sodTags);
  }
  return map;
})();

/** Firefighter/emergency-access duties inferred from the target system. */
function firefighterTags(system?: string): string[] {
  const s = (system ?? '').toLowerCase();
  if (s.includes('sap')) return [SOD_TAG.PAYMENT_RELEASE];
  if (s.includes('swift')) return [SOD_TAG.PAYMENT_INITIATE];
  return [];
}

/**
 * Classify the SoD duties a grant confers from its human attributes. Scoped grant
 * names are suffixed (" - Frankfurt"); the base label before the suffix is matched
 * against the catalog, so "Murex Trader - Frankfurt" classifies like "Murex
 * Trader". Firefighter grants are inferred from their system.
 *
 * @param name The grant's display name, if known.
 * @param system The target system, if known.
 * @param type The entitlement type, if known.
 * @returns The abstract SoD duty tags (possibly empty).
 */
export function classifyDuties(name?: string, system?: string, type?: EntitlementType): string[] {
  if (name) {
    const base = (name.split(' - ')[0] ?? name).trim();
    const tags = LABEL_TO_TAGS.get(base);
    if (tags && tags.length > 0) return [...tags];
    if (/firefighter|emergency/i.test(name)) return firefighterTags(system);
  }
  if (type === 'firefighter') return firefighterTags(system);
  return [];
}

/** Synthesize a minimal `Entitlement` for the frozen detector (reads id + sodTags). */
function synth(held: HeldEntitlement): Entitlement {
  return {
    id: held.id,
    system: held.system ?? 'unknown',
    name: held.name ?? held.id,
    type: held.type ?? 'role',
    risk: 'medium',
    sensitive: held.sodTags.length > 0,
    grantedAt: '',
    sodTags: held.sodTags,
  };
}

/**
 * Detect every toxic combination among a user's held entitlements using the frozen
 * bank rule set (overridable for a configurable policy).
 *
 * @param held The user's classified held entitlements.
 * @param rules The SoD rule set to evaluate (defaults to `SOD_RULES`).
 * @returns The detected conflicts, each with its rule and offending pair.
 */
export function detectConflicts(
  held: readonly HeldEntitlement[],
  rules: readonly SodRule[] = SOD_RULES,
): SodConflict[] {
  if (held.length < 2) return [];
  return detectSodConflictsDetailed(held.map(synth), rules);
}
