import { describe, expect, it } from 'vitest';
import { SOD_TAG } from '../domain/entitlements.js';
import { classifyDuties, detectConflicts } from './sod-detector.js';
import type { HeldEntitlement } from './types.js';

function held(id: string, name: string): HeldEntitlement {
  return { id, name, sodTags: classifyDuties(name) };
}

describe('classifyDuties', () => {
  it('classifies a known grant by its catalog label', () => {
    expect(classifyDuties('SAP Payment Posting')).toEqual([SOD_TAG.PAYMENT_INITIATE]);
    expect(classifyDuties('SAP Payment Release')).toContain(SOD_TAG.PAYMENT_RELEASE);
  });

  it('strips a location suffix before matching', () => {
    expect(classifyDuties('Murex Trader - Frankfurt')).toEqual([SOD_TAG.TRADE_EXECUTE]);
  });

  it('infers firefighter duties from the target system', () => {
    expect(classifyDuties('SAP_FF_PAY (SAP)', 'SAP', 'firefighter')).toEqual([SOD_TAG.PAYMENT_RELEASE]);
  });

  it('returns no duties for an unclassifiable grant', () => {
    expect(classifyDuties('Corporate Mailbox')).toEqual([]);
    expect(classifyDuties(undefined)).toEqual([]);
  });
});

describe('detectConflicts', () => {
  it('flags the payment initiate + release toxic combination', () => {
    const conflicts = detectConflicts([
      held('e1', 'SAP Payment Posting'),
      held('e2', 'SAP Payment Release'),
    ]);
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    expect(conflicts.some((c) => c.rule.id === 'SOD-PAY-01')).toBe(true);
  });

  it('flags trade execute + settle', () => {
    const conflicts = detectConflicts([
      held('e1', 'Murex Trader'),
      held('e2', 'Settlement Processing'),
    ]);
    expect(conflicts.some((c) => c.rule.id === 'SOD-TRD-01')).toBe(true);
  });

  it('finds no conflict in an SoD-clean set', () => {
    expect(detectConflicts([held('e1', 'SAP Payment Posting'), held('e2', 'Bloomberg Terminal')])).toEqual([]);
    expect(detectConflicts([held('e1', 'Murex Trader')])).toEqual([]);
  });
});
