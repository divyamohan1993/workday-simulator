import { describe, it, expect } from 'vitest';
import type { TimezoneWeights } from '../types/index.js';
import { ALL_LOCATIONS } from '../types/index.js';
import {
  businessCurve,
  diurnalShape,
  monthlyFactor,
  REFERENCE_INTENSITY,
  weekdayFactor,
} from './diurnal.js';
import { localTimeInfo } from './tz.js';

function weightsOnly(...active: string[]): TimezoneWeights {
  const byLocation = {} as TimezoneWeights['byLocation'];
  for (const loc of ALL_LOCATIONS) byLocation[loc] = active.includes(loc) ? 1 : 0;
  return { byLocation };
}

const defaultWeights: TimezoneWeights = {
  byLocation: { FFT: 1, LDN: 0.9, NYC: 0.9, SIN: 0.5, HKG: 0.5, BLR: 0.7, PNQ: 0.5, JAX: 0.4 },
};

describe('businessCurve', () => {
  it('rises monotonically through the morning login ramp', () => {
    const hours = [6, 6.5, 7, 7.5, 8, 8.5];
    for (let i = 1; i < hours.length; i += 1) {
      expect(businessCurve(hours[i]!)).toBeGreaterThan(businessCurve(hours[i - 1]!));
    }
  });

  it('shows a lunch dip below the surrounding core hours', () => {
    expect(businessCurve(12.75)).toBeLessThan(businessCurve(11));
    expect(businessCurve(12.75)).toBeLessThan(businessCurve(14));
  });

  it('shows an end-of-day spike above late afternoon', () => {
    expect(businessCurve(17.75)).toBeGreaterThan(businessCurve(16.5));
  });

  it('is near-zero deep overnight and never negative', () => {
    expect(businessCurve(3)).toBeLessThan(businessCurve(10));
    expect(businessCurve(0)).toBeGreaterThanOrEqual(0);
  });

  it('REFERENCE_INTENSITY equals the canonical core-hours value and is positive', () => {
    expect(REFERENCE_INTENSITY).toBe(businessCurve(10.5));
    expect(REFERENCE_INTENSITY).toBeGreaterThan(0);
  });
});

describe('weekdayFactor', () => {
  it('peaks on Monday, is lighter on Friday, and collapses at the weekend', () => {
    expect(weekdayFactor(1)).toBeGreaterThan(weekdayFactor(5)); // Mon > Fri
    expect(weekdayFactor(5)).toBeGreaterThan(weekdayFactor(6)); // Fri > Sat
    expect(weekdayFactor(6)).toBeLessThan(0.1); // Saturday minimal
    expect(weekdayFactor(0)).toBeLessThan(0.1); // Sunday minimal
  });
});

describe('monthlyFactor', () => {
  it('lifts the baseline on payroll day and at quarter-end', () => {
    expect(monthlyFactor(25, 6, 2026)).toBeGreaterThan(1); // payroll (25th)
    expect(monthlyFactor(30, 6, 2026)).toBeGreaterThan(1); // quarter-end (June, last 3 days)
    expect(monthlyFactor(31, 1, 2026)).toBeGreaterThan(1); // month-end payroll
  });

  it('is neutral on an ordinary mid-month day', () => {
    expect(monthlyFactor(16, 6, 2026)).toBe(1);
  });
});

describe('diurnalShape', () => {
  it('rises monotonically across the Frankfurt morning ramp (FFT only)', () => {
    const weights = weightsOnly('FFT');
    // 2026-06-16 is a Tuesday; UTC 04:00 is Berlin 06:00 (CEST, +2).
    const base = Date.UTC(2026, 5, 16, 4, 0, 0);
    const step = 30 * 60 * 1000;
    let previous = -Infinity;
    for (let k = 0; k <= 5; k += 1) {
      const rate = diurnalShape(base + k * step, weights);
      expect(rate).toBeGreaterThan(previous);
      previous = rate;
    }
  });

  it('is much lower on a weekend than on a weekday at the same local time', () => {
    const tuesday = Date.UTC(2026, 5, 16, 8, 30, 0); // Berlin 10:30 Tuesday
    const saturday = Date.UTC(2026, 5, 20, 8, 30, 0); // Berlin 10:30 Saturday
    expect(localTimeInfo('Europe/Berlin', tuesday).weekday).toBe(2);
    expect(localTimeInfo('Europe/Berlin', saturday).weekday).toBe(6);
    expect(diurnalShape(saturday, defaultWeights)).toBeLessThan(diurnalShape(tuesday, defaultWeights));
  });

  it('is approximately 1 during ordinary global core hours', () => {
    const tuesdayCore = Date.UTC(2026, 5, 16, 8, 30, 0);
    const shape = diurnalShape(tuesdayCore, defaultWeights);
    expect(shape).toBeGreaterThan(0.5);
    expect(shape).toBeLessThan(2.5);
  });

  it('returns 0 when all weights are zero', () => {
    expect(diurnalShape(Date.UTC(2026, 5, 16, 8, 30, 0), weightsOnly())).toBe(0);
  });
});
