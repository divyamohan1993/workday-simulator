import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { GRADE_SENIORITY } from '../types/index.js';
import type { Employee } from '../types/index.js';
import {
  applyConversion,
  applyHire,
  applyLoa,
  applyPromotion,
  applyRehire,
  applyTermination,
  applyTransfer,
  createIdentityPool,
} from './index.js';

const logger = pino({ level: 'silent' });

function seededPool(size = 500, seed = 'test-seed') {
  const pool = createIdentityPool({ logger });
  pool.seed(size, seed);
  return pool;
}

function edgeOf(employee: Employee): string {
  const value = employee.attributes.edgeCase;
  return typeof value === 'string' ? value : '';
}

describe('IdentityPool seeding determinism', () => {
  it('produces byte-identical populations for the same (size, seed)', () => {
    const a = seededPool(600, 'db-workday-2026').all();
    const b = seededPool(600, 'db-workday-2026').all();
    expect(a).toEqual(b);
    expect(a).toHaveLength(600);
  });

  it('produces different populations for different seeds', () => {
    const a = seededPool(300, 'seed-a').all();
    const b = seededPool(300, 'seed-b').all();
    expect(a).not.toEqual(b);
  });

  it('is idempotent: reseeding with the same args rebuilds an identical pool', () => {
    const pool = createIdentityPool({ logger });
    pool.seed(400, 's');
    const first = JSON.stringify(pool.all());
    pool.hire({ division: 'Risk', type: 'FTE' }); // mutate
    pool.seed(400, 's'); // reseed must fully reset
    expect(pool.size()).toBe(400);
    expect(JSON.stringify(pool.all())).toBe(first);
  });

  it('rejects a non-positive size', () => {
    const pool = createIdentityPool({ logger });
    expect(() => pool.seed(0, 's')).toThrow();
    expect(() => pool.seed(-5, 's')).toThrow();
  });
});

describe('manager chains', () => {
  it('are acyclic and always point to a strictly more senior manager', () => {
    const pool = seededPool(1200, 'chains');
    const all = pool.all();
    const byId = new Map(all.map((e) => [e.id, e]));

    for (const emp of all) {
      const visited = new Set<string>([emp.id]);
      let cursor = emp.managerId;
      let previousSeniority = GRADE_SENIORITY[emp.grade];
      while (cursor) {
        expect(visited.has(cursor)).toBe(false); // no cycle
        visited.add(cursor);
        const manager = byId.get(cursor);
        expect(manager).toBeDefined();
        if (!manager) break;
        // Each hop is strictly more senior, which also forbids cycles.
        expect(GRADE_SENIORITY[manager.grade]).toBeGreaterThan(previousSeniority);
        previousSeniority = GRADE_SENIORITY[manager.grade];
        cursor = manager.managerId;
      }
    }
  });

  it('gives every non-MD human a manager except the marked edge cases', () => {
    const pool = seededPool(1500, 'invariant');
    const all = pool.all();
    let unmarkedMissing = 0;
    let markedMissing = 0;
    for (const emp of all) {
      if (emp.isNonHuman || emp.grade === 'MD') continue;
      if (emp.managerId === null) {
        if (edgeOf(emp).includes('missing_manager') || edgeOf(emp).includes('root_no_senior')) {
          markedMissing += 1;
        } else {
          unmarkedMissing += 1;
        }
      }
    }
    expect(unmarkedMissing).toBe(0);
    expect(markedMissing).toBeGreaterThan(0);
  });

  it('gives every machine identity a human owner as manager', () => {
    const pool = seededPool(1500, 'nhi');
    const nhi = pool.all().filter((e) => e.isNonHuman);
    expect(nhi.length).toBeGreaterThan(0);
    for (const svc of nhi) {
      expect(svc.managerId).not.toBeNull();
    }
  });
});

describe('deliberate edge cases', () => {
  it('seeds unicode, long, duplicate, orphan, dormant, and SoD edge cases', () => {
    const pool = seededPool(1500, 'edges');
    const edges = pool.all().flatMap((e) => edgeOf(e).split(',').filter(Boolean));
    const set = new Set(edges);
    for (const expected of [
      'unicode_name',
      'long_name',
      'duplicate_name',
      'orphan',
      'dormant',
      'sod_conflict',
      'missing_manager',
    ]) {
      expect(set.has(expected)).toBe(true);
    }
  });

  it('produces email collisions resolved to unique addresses', () => {
    const pool = seededPool(1500, 'collisions');
    const emails = pool.all().map((e) => e.email);
    const unique = new Set(emails);
    expect(unique.size).toBe(emails.length); // every email unique despite collisions
    // At least some addresses carry a disambiguating suffix.
    expect(emails.some((e) => /(?:\d|\.[a-z]\.|\.(?:fft|ldn|nyc|sin|hkg|blr|pnq|jax))@db\.com$/.test(e))).toBe(
      true,
    );
  });
});

describe('lifecycle mutations and entitlement deltas', () => {
  it('hire inserts an active identity with birthright access and a manager', () => {
    const pool = seededPool(400, 'hire');
    const before = pool.size();
    const outcome = applyHire(pool, {
      division: 'Corporate Bank',
      grade: 'Associate',
      type: 'FTE',
      location: 'LDN',
      status: 'active',
    });
    expect(pool.size()).toBe(before + 1);
    expect(outcome.granted.length).toBeGreaterThan(0);
    expect(outcome.employee.entitlements.length).toBe(outcome.granted.length);
    expect(outcome.employee.managerId).not.toBeNull();
    expect(pool.get(outcome.employee.id)).toBeDefined();
  });

  it('transfer revokes division-bound access and grants the new division baseline', () => {
    const pool = seededPool(800, 'transfer');
    const mover = pool
      .all()
      .find((e) => !e.isNonHuman && e.status === 'active' && e.division === 'Investment Bank');
    expect(mover).toBeDefined();
    if (!mover) return;
    const outcome = applyTransfer(pool, mover.id, {
      division: 'Human Resources',
      location: 'BLR',
    });
    expect(outcome).toBeDefined();
    expect(outcome?.employee.division).toBe('Human Resources');
    expect(outcome?.employee.location).toBe('BLR');
    // The Investment Bank tools must be gone and an HR baseline present.
    expect(outcome?.revoked.length).toBeGreaterThan(0);
    expect(outcome?.granted.length).toBeGreaterThan(0);
    const systems = new Set(outcome?.employee.entitlements.map((e) => e.system));
    expect(systems.has('Bloomberg')).toBe(false);
  });

  it('promotion grants grade privileges without revoking existing access', () => {
    const pool = seededPool(800, 'promote');
    const analyst = pool
      .all()
      .find((e) => !e.isNonHuman && e.grade === 'Analyst' && e.status === 'active' && e.division === 'Finance');
    expect(analyst).toBeDefined();
    if (!analyst) return;
    const outcome = applyPromotion(pool, analyst.id, 'VP');
    expect(outcome?.employee.grade).toBe('VP');
    expect(outcome?.revoked.length).toBe(0);
    expect(outcome?.granted.length).toBeGreaterThan(0);
  });

  it('termination revokes every entitlement and disables the account', () => {
    const pool = seededPool(600, 'terminate');
    const leaver = pool
      .all()
      .find((e) => !e.isNonHuman && e.status === 'active' && e.entitlements.length > 0);
    expect(leaver).toBeDefined();
    if (!leaver) return;
    const count = leaver.entitlements.length;
    const outcome = applyTermination(pool, leaver.id, {});
    expect(outcome?.employee.status).toBe('terminated');
    expect(outcome?.revoked.length).toBe(count);
    expect(outcome?.employee.entitlements.length).toBe(0);
    expect(outcome?.employee.endDate).toBeDefined();
  });

  it('leave of absence retains access and flips status to on_leave', () => {
    const pool = seededPool(400, 'loa');
    const emp = pool.all().find((e) => !e.isNonHuman && e.status === 'active' && e.entitlements.length > 0);
    if (!emp) return;
    const count = emp.entitlements.length;
    const outcome = applyLoa(pool, emp.id);
    expect(outcome?.employee.status).toBe('on_leave');
    expect(outcome?.revoked.length).toBe(0);
    expect(outcome?.retained.length).toBe(count);
  });

  it('rehire reactivates a terminated identity and restores its baseline', () => {
    const pool = seededPool(400, 'rehire');
    const emp = pool.all().find((e) => !e.isNonHuman && e.status === 'active' && e.entitlements.length > 0);
    if (!emp) return;
    applyTermination(pool, emp.id, {});
    expect(pool.get(emp.id)?.entitlements.length).toBe(0);
    const outcome = applyRehire(pool, emp.id);
    expect(outcome?.employee.status).toBe('active');
    expect(outcome?.granted.length).toBeGreaterThan(0);
    expect(outcome?.employee.entitlements.length).toBeGreaterThan(0);
  });

  it('conversion disables the old identity and hires a new one of the new type', () => {
    const pool = seededPool(400, 'convert');
    const contractor = pool.all().find((e) => e.type === 'Contractor' && e.status === 'active');
    if (!contractor) return;
    const beforeSize = pool.size();
    const outcome = applyConversion(pool, contractor.id, 'FTE');
    expect(outcome?.employee.type).toBe('FTE');
    expect(outcome?.employee.id).not.toBe(contractor.id);
    expect(pool.size()).toBe(beforeSize + 1);
    expect(pool.get(contractor.id)?.status).toBe('disabled');
    expect(outcome?.revoked.length).toBeGreaterThanOrEqual(0);
    expect(outcome?.granted.length).toBeGreaterThan(0);
  });

  it('changeManager rejects an edit that would create a cycle', () => {
    const pool = seededPool(600, 'cycle');
    const report = pool.all().find((e) => e.managerId !== null && !e.isNonHuman);
    expect(report).toBeDefined();
    if (!report || !report.managerId) return;
    const manager = report.managerId;
    // Trying to make the manager report to its own report closes a loop.
    const result = pool.changeManager(manager, report.id);
    expect(result).toBeDefined();
    expect(result?.managerId).not.toBe(report.id); // unchanged
  });
});

describe('sampling and reads', () => {
  it('pickActive returns an active human weighted by the simulated instant', () => {
    const pool = seededPool(800, 'active');
    const instant = Date.UTC(2026, 6, 22, 9, 0, 0); // Wednesday, European core hours
    for (let i = 0; i < 100; i += 1) {
      const picked = pool.pickActive(instant);
      expect(picked).toBeDefined();
      expect(picked?.isNonHuman).toBe(false);
      expect(picked?.status).toBe('active');
    }
  });

  it('pickActive returns undefined when nothing is seeded', () => {
    const pool = createIdentityPool({ logger });
    expect(pool.pickActive(Date.now())).toBeUndefined();
  });

  it('pick with a predicate finds a machine identity', () => {
    const pool = seededPool(600, 'svc');
    const svc = pool.pick((e) => e.isNonHuman);
    expect(svc?.isNonHuman).toBe(true);
  });

  it('ref returns a compact identity reference', () => {
    const pool = seededPool(200, 'ref');
    const emp = pool.all()[0];
    expect(emp).toBeDefined();
    if (!emp) return;
    const ref = pool.ref(emp.id);
    expect(ref).toMatchObject({ id: emp.id, employeeId: emp.employeeId, email: emp.email });
    expect(pool.ref('missing')).toBeUndefined();
  });
});

describe('stats and SoD', () => {
  it('reports a complete, summable distribution', () => {
    const pool = seededPool(1000, 'stats');
    const stats = pool.stats();
    expect(stats.total).toBe(1000);
    const statusSum = Object.values(stats.byStatus).reduce((a, b) => a + b, 0);
    expect(statusSum).toBe(1000);
    const typeSum = Object.values(stats.byType).reduce((a, b) => a + b, 0);
    expect(typeSum).toBe(1000);
    expect(stats.nonHuman).toBeGreaterThan(0);
    expect(stats.withSodConflicts).toBeGreaterThan(0);
  });

  it('detects a known toxic pair on a seeded conflicted identity', () => {
    const pool = seededPool(1200, 'sod');
    const conflicted = pool.all().find((e) => pool.sodConflicts(e.id).length > 0);
    expect(conflicted).toBeDefined();
    if (!conflicted) return;
    const conflicts = pool.sodConflicts(conflicted.id);
    expect(conflicts.length).toBeGreaterThan(0);
    const [a, b] = conflicts[0]!;
    expect(a.id).not.toBe(b.id);
  });

  it('returns no conflicts for an unknown id', () => {
    const pool = seededPool(100, 'sod2');
    expect(pool.sodConflicts('nope')).toEqual([]);
  });
});

describe('degenerate sizes', () => {
  it('seeds a single identity as an MD root with no manager', () => {
    const pool = seededPool(1, 'tiny');
    expect(pool.size()).toBe(1);
    const only = pool.all()[0];
    expect(only?.managerId).toBeNull();
    expect(only?.grade).toBe('MD');
  });
});
