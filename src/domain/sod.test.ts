import { describe, expect, it } from 'vitest';
import type { Entitlement } from '../types/index.js';
import { SOD_TAG } from './entitlements.js';
import { detectSodConflicts, detectSodConflictsDetailed, SOD_RULES } from './sod.js';

function ent(id: string, sodTags: string[], sensitive = true): Entitlement {
  return {
    id,
    system: 'Test',
    name: `Grant ${id}`,
    type: 'role',
    risk: 'high',
    sensitive,
    grantedAt: new Date(0).toISOString(),
    sodTags,
  };
}

describe('detectSodConflicts', () => {
  it('flags a payment initiate + approve toxic pair', () => {
    const grants = [
      ent('a', [SOD_TAG.PAYMENT_INITIATE]),
      ent('b', [SOD_TAG.PAYMENT_APPROVE]),
    ];
    const conflicts = detectSodConflicts(grants);
    expect(conflicts).toHaveLength(1);
    const pair = conflicts[0]!;
    expect(new Set(pair.map((e) => e.id))).toEqual(new Set(['a', 'b']));
  });

  it('returns no conflicts for a clean set', () => {
    const grants = [
      ent('a', [SOD_TAG.PAYMENT_INITIATE]),
      ent('b', ['reporting.view']),
      ent('c', []),
    ];
    expect(detectSodConflicts(grants)).toHaveLength(0);
  });

  it('does not flag a single grant that holds both duties', () => {
    // SAP payment release carries both approve and release; alone it is not a
    // two-grant separation-of-duties conflict.
    const grants = [ent('a', [SOD_TAG.PAYMENT_APPROVE, SOD_TAG.PAYMENT_RELEASE])];
    expect(detectSodConflicts(grants)).toHaveLength(0);
  });

  it('deduplicates a pair even when a rule matches it symmetrically', () => {
    const grants = [
      ent('a', [SOD_TAG.GL_POST]),
      ent('b', [SOD_TAG.GL_RECONCILE]),
    ];
    const detailed = detectSodConflictsDetailed(grants);
    expect(detailed).toHaveLength(1);
    expect(detailed[0]?.rule.id).toBe('SOD-GL-01');
  });

  it('reports the offending pair in a stable id order', () => {
    const grants = [
      ent('zzz', [SOD_TAG.TRADE_EXECUTE]),
      ent('aaa', [SOD_TAG.TRADE_SETTLE]),
    ];
    const [pair] = detectSodConflicts(grants);
    expect(pair?.[0]?.id).toBe('aaa'); // lower id first
    expect(pair?.[1]?.id).toBe('zzz');
  });

  it('covers vendor-master and payment authority as a critical rule', () => {
    const grants = [
      ent('v', [SOD_TAG.VENDOR_MAINTAIN]),
      ent('p', [SOD_TAG.PAYMENT_RELEASE]),
    ];
    const detailed = detectSodConflictsDetailed(grants);
    expect(detailed[0]?.rule.id).toBe('SOD-VND-01');
    expect(detailed[0]?.rule.severity).toBe('critical');
  });

  it('exposes a non-empty, well-formed rule set', () => {
    expect(SOD_RULES.length).toBeGreaterThan(0);
    for (const rule of SOD_RULES) {
      expect(rule.tagsA.length).toBeGreaterThan(0);
      expect(rule.tagsB.length).toBeGreaterThan(0);
    }
  });
});
