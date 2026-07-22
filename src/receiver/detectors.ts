/**
 * Orphan and dormant account detection over the SCIM store.
 *
 * WHY these two, modeled this way: they are the classic identity-governance
 * findings an identity manager surfaces, and both fall out of state the receiver
 * already holds.
 * - An ORPHAN is a group membership pointing at an account that no longer exists
 *   (or was deprovisioned): a dangling entitlement with no live owner. Scanning
 *   group memberships for references to non-live users finds them deterministically.
 * - A DORMANT account is one that is still enabled but has seen no activity within
 *   a window. The window is measured in SIMULATED time (the last activity is stamped
 *   from event timestamps), so it actually trips inside an accelerated run instead
 *   of never tripping against wall-clock.
 *
 * Both functions are pure reads over the store, so they are trivially testable and
 * safe to run on a cadence from the pump.
 */

import type { ScimStore } from './scim-store.js';
import type { AccountFinding } from './types.js';

/**
 * Find dangling group memberships (orphaned entitlements) in the store.
 *
 * @param store The SCIM store.
 * @param nowMs Wall-clock ms, stamped onto each finding.
 * @returns One finding per distinct (group, missing-member) pair.
 */
export function detectOrphans(store: ScimStore, nowMs: number): AccountFinding[] {
  const findings: AccountFinding[] = [];
  const at = new Date(nowMs).toISOString();
  for (const group of store.allGroups()) {
    for (const member of group.members) {
      if (!store.hasLiveUser(member.value)) {
        findings.push({
          kind: 'orphan',
          accountId: member.value,
          detail: `Membership in group ${group.id} references a non-existent account`,
          at,
        });
      }
    }
  }
  return findings;
}

/**
 * Find enabled accounts that have been inactive beyond the dormancy window.
 *
 * @param store The SCIM store.
 * @param nowSimMs Current simulated time in ms.
 * @param thresholdMs Dormancy window in simulated ms.
 * @param nowMs Wall-clock ms, stamped onto each finding.
 * @returns One finding per dormant account.
 */
export function detectDormant(
  store: ScimStore,
  nowSimMs: number,
  thresholdMs: number,
  nowMs: number,
): AccountFinding[] {
  const findings: AccountFinding[] = [];
  const at = new Date(nowMs).toISOString();
  for (const user of store.liveUsers()) {
    if (!user.active) continue;
    const activity = store.userActivity(user.id);
    if (!activity || activity.lastActivitySimMs <= 0) continue;
    const idleMs = nowSimMs - activity.lastActivitySimMs;
    if (idleMs > thresholdMs) {
      findings.push({
        kind: 'dormant',
        accountId: user.id,
        detail: `No activity for ${Math.floor(idleMs / 86_400_000)} simulated days`,
        at,
      });
    }
  }
  return findings;
}
