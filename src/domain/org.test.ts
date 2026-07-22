import { describe, expect, it } from 'vitest';
import { Faker, base, en } from '@faker-js/faker';
import {
  buildCostCenterCatalog,
  businessActivityWeight,
  indexCostCentersByDivision,
  localTimeAt,
  LOCATIONS,
  resolveLegalEntity,
} from './org.js';

function rng(seed = 1) {
  const f = new Faker({ locale: [en, base] });
  f.seed(seed);
  return f;
}

describe('LOCATIONS', () => {
  it('uses canonical IANA timezones the runtime can format', () => {
    for (const site of Object.values(LOCATIONS)) {
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: site.timezone }).format(0)).not.toThrow();
    }
    expect(LOCATIONS.FFT.isHeadquarters).toBe(true);
  });
});

describe('businessActivityWeight', () => {
  it('is higher during local core hours than overnight', () => {
    // 2026-07-22 is a Wednesday. Berlin (CEST, UTC+2): 08:00 UTC = 10:00 local (core),
    // 01:00 UTC = 03:00 local (overnight).
    const core = businessActivityWeight(Date.UTC(2026, 6, 22, 8, 0, 0), 'FFT');
    const overnight = businessActivityWeight(Date.UTC(2026, 6, 22, 1, 0, 0), 'FFT');
    expect(core).toBeGreaterThan(overnight);
    expect(core).toBeGreaterThan(0.5);
    expect(overnight).toBeLessThan(0.2);
  });

  it('collapses to a low floor on weekends', () => {
    // 2026-07-25 is a Saturday.
    const weekend = businessActivityWeight(Date.UTC(2026, 6, 25, 8, 0, 0), 'FFT');
    const weekday = businessActivityWeight(Date.UTC(2026, 6, 22, 8, 0, 0), 'FFT');
    expect(weekend).toBeLessThan(weekday);
  });
});

describe('localTimeAt', () => {
  it('resolves the local hour and weekday for a site', () => {
    const { hour, weekday } = localTimeAt(Date.UTC(2026, 6, 22, 8, 0, 0), 'FFT');
    expect(hour).toBe(10); // 08:00 UTC + 2h CEST
    expect(weekday).toBe(3); // Wednesday
  });
});

describe('resolveLegalEntity', () => {
  it('routes by location and by Frankfurt division', () => {
    expect(resolveLegalEntity('Investment Bank', 'LDN')).toBe('Deutsche Bank AG, London Branch');
    expect(resolveLegalEntity('Operations', 'NYC')).toBe('Deutsche Bank Trust Company Americas');
    expect(resolveLegalEntity('Corporate Bank', 'SIN')).toBe('Deutsche Bank (Singapore) Ltd');
    expect(resolveLegalEntity('Risk', 'BLR')).toBe('Deutsche India Private Limited');
    expect(resolveLegalEntity('Private Bank', 'FFT')).toBe('DB Privat- und Firmenkundenbank AG');
    expect(resolveLegalEntity('Investment Bank', 'FFT')).toBe('Deutsche Bank AG');
  });

  it('routes Asset Management to DWS, or Luxembourg for fund entities', () => {
    expect(resolveLegalEntity('Asset Management', 'FFT')).toBe('DWS Group GmbH & Co. KGaA');
    expect(resolveLegalEntity('Asset Management', 'FFT', true)).toBe('Deutsche Bank Luxembourg S.A.');
  });
});

describe('cost center catalog', () => {
  it('builds a deterministic catalog and indexes it by division', () => {
    const a = buildCostCenterCatalog(rng(3), 5);
    const b = buildCostCenterCatalog(rng(3), 5);
    expect(a).toEqual(b); // deterministic
    expect(a).toHaveLength(10 * 5); // ten divisions
    expect(a.every((cc) => cc.code.startsWith('CC-'))).toBe(true);
    const index = indexCostCentersByDivision(a);
    expect(index['Investment Bank']).toHaveLength(5);
  });
});
