import { describe, expect, it } from 'vitest';
import { Faker, base, en } from '@faker-js/faker';
import type { Division, EmployeeType, Entitlement, Grade } from '../types/index.js';
import { ALL_DIVISIONS } from '../types/index.js';
import {
  baselineTemplatesFor,
  mintEntitlement,
  type EntitlementProfile,
} from './entitlements.js';
import { JOB_FAMILIES_BY_DIVISION } from './org.js';
import { detectSodConflicts } from './sod.js';

function rng(seed = 1) {
  const f = new Faker({ locale: [en, base] });
  f.seed(seed);
  return f;
}

const GRADES: Grade[] = ['Intern', 'Contractor', 'Analyst', 'Associate', 'AVP', 'VP', 'Director', 'MD'];

function mintBaseline(profile: EntitlementProfile): Entitlement[] {
  const f = rng();
  return baselineTemplatesFor(profile).map((t) =>
    mintEntitlement(f, t, profile, { grantedAtMs: Date.UTC(2026, 0, 1) }),
  );
}

describe('baseline planners', () => {
  it('are pure: identical profiles yield identical template keys', () => {
    const profile: EntitlementProfile = {
      division: 'Investment Bank',
      grade: 'VP',
      type: 'FTE',
      location: 'LDN',
      jobFamily: 'Research',
      isNonHuman: false,
    };
    const a = baselineTemplatesFor(profile).map((t) => t.key);
    const b = baselineTemplatesFor(profile).map((t) => t.key);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('produce SoD-clean baselines for every division, grade and job family', () => {
    for (const division of ALL_DIVISIONS as readonly Division[]) {
      for (const jobFamily of JOB_FAMILIES_BY_DIVISION[division]) {
        for (const grade of GRADES) {
          const profile: EntitlementProfile = {
            division,
            grade,
            type: 'FTE',
            location: 'FFT',
            jobFamily,
            isNonHuman: false,
          };
          const conflicts = detectSodConflicts(mintBaseline(profile));
          expect(
            conflicts,
            `unexpected baseline SoD conflict for ${division}/${jobFamily}/${grade}`,
          ).toHaveLength(0);
        }
      }
    }
  });

  it('grants payment initiation only to hands-on payment families', () => {
    const rmProfile: EntitlementProfile = {
      division: 'Corporate Bank',
      grade: 'Analyst',
      type: 'FTE',
      location: 'FFT',
      jobFamily: 'Relationship Management',
      isNonHuman: false,
    };
    const payProfile: EntitlementProfile = { ...rmProfile, jobFamily: 'Payments Operations' };
    const rmKeys = baselineTemplatesFor(rmProfile).map((t) => t.key);
    const payKeys = baselineTemplatesFor(payProfile).map((t) => t.key);
    expect(rmKeys).not.toContain('SAP-PAY-POST');
    expect(payKeys).toContain('SAP-PAY-POST');
  });

  it('gives machine identities a minimal service footprint', () => {
    const svc: EntitlementProfile = {
      division: 'Technology, Data & Innovation',
      grade: 'Analyst',
      type: 'Service',
      location: 'FFT',
      jobFamily: 'Site Reliability',
      isNonHuman: true,
    };
    const keys = baselineTemplatesFor(svc).map((t) => t.key);
    expect(keys).toContain('SVC-API-KEY');
    expect(keys).not.toContain('VPN'); // no interactive remote access
  });
});

describe('mintEntitlement', () => {
  it('produces a well-formed entitlement with a location-scoped name', () => {
    const profile: EntitlementProfile = {
      division: 'Investment Bank',
      grade: 'VP',
      type: 'FTE',
      location: 'NYC',
      jobFamily: 'Trading',
      isNonHuman: false,
    };
    const template = baselineTemplatesFor(profile).find((t) => t.scope === 'location');
    expect(template).toBeDefined();
    if (!template) return;
    const ent = mintEntitlement(rng(), template, profile, { grantedAtMs: Date.UTC(2026, 0, 1) });
    expect(ent.id).toMatch(/^ent_/);
    expect(ent.name).toContain('New York');
    expect(ent.grantedAt).toBe(new Date(Date.UTC(2026, 0, 1)).toISOString());
    expect(ent.expiresAt).toBeUndefined();
  });

  it('sets expiry for time-boxed grants', () => {
    const profile: EntitlementProfile = {
      division: 'Finance',
      grade: 'AVP',
      type: 'FTE',
      location: 'FFT',
      jobFamily: 'Finance & Controlling',
      isNonHuman: false,
    };
    const template = baselineTemplatesFor(profile)[0];
    expect(template).toBeDefined();
    if (!template) return;
    const ent = mintEntitlement(rng(), template, profile, {
      grantedAtMs: Date.UTC(2026, 0, 1),
      expiresAtMs: Date.UTC(2026, 1, 1),
    });
    expect(ent.expiresAt).toBe(new Date(Date.UTC(2026, 1, 1)).toISOString());
  });

  it('mints unique ids across repeated calls', () => {
    const f = rng(7);
    const profile: EntitlementProfile = {
      division: 'Risk',
      grade: 'VP',
      type: 'FTE' as EmployeeType,
      location: 'FFT',
      jobFamily: 'Risk Management',
      isNonHuman: false,
    };
    const template = baselineTemplatesFor(profile)[0]!;
    const ids = new Set(
      Array.from({ length: 50 }, () =>
        mintEntitlement(f, template, profile, { grantedAtMs: 0 }).id,
      ),
    );
    expect(ids.size).toBe(50);
  });
});
