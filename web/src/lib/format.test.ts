import { describe, expect, it } from 'vitest';
import {
  clamp,
  compactNumber,
  formatDuration,
  formatInt,
  formatMs,
  formatPct,
  formatRps,
  humanizeKind,
  relativeTime,
} from '@/lib/format';

describe('formatInt', () => {
  it('groups thousands and guards bad numbers', () => {
    expect(formatInt(1284)).toBe('1,284');
    expect(formatInt(0)).toBe('0');
    expect(formatInt(NaN)).toBe('-');
    expect(formatInt(undefined)).toBe('-');
  });
});

describe('compactNumber', () => {
  it('keeps full digits below 10k and compacts above', () => {
    expect(compactNumber(999)).toBe('999');
    expect(compactNumber(1000)).toBe('1,000');
    expect(compactNumber(9999)).toBe('9,999');
    expect(compactNumber(12_934)).toBe('12.9K');
    expect(compactNumber(3_400_000)).toBe('3.4M');
    expect(compactNumber(1_200_000_000)).toBe('1.2B');
  });

  it('handles negatives and NaN', () => {
    expect(compactNumber(-12_934)).toBe('-12.9K');
    expect(compactNumber(Number.POSITIVE_INFINITY)).toBe('-');
  });
});

describe('formatRps', () => {
  it('shows a decimal below 100 and whole numbers above', () => {
    expect(formatRps(42.37)).toBe('42.4');
    expect(formatRps(1500)).toBe('1,500');
  });
});

describe('formatMs', () => {
  it('switches to seconds past 1000ms', () => {
    expect(formatMs(842)).toMatch(/^842/);
    expect(formatMs(1500)).toMatch(/^1\.50/);
  });
});

describe('formatPct', () => {
  it('renders a fraction as a percentage', () => {
    expect(formatPct(0.0241)).toBe('2.41%');
    expect(formatPct(0, 0)).toBe('0%');
  });
});

describe('formatDuration', () => {
  it('formats h/m/s', () => {
    expect(formatDuration(3852)).toBe('1h 04m 12s');
    expect(formatDuration(252)).toBe('4m 12s');
    expect(formatDuration(42)).toBe('42s');
    expect(formatDuration(-1)).toBe('-');
  });
});

describe('relativeTime', () => {
  it('describes recency from a fixed now', () => {
    const now = Date.parse('2026-07-22T12:00:00.000Z');
    expect(relativeTime('2026-07-22T12:00:00.000Z', now)).toBe('just now');
    expect(relativeTime('2026-07-22T11:59:57.000Z', now)).toBe('3s ago');
    expect(relativeTime('2026-07-22T11:55:00.000Z', now)).toBe('5m ago');
    expect(relativeTime(undefined, now)).toBe('-');
  });
});

describe('humanizeKind', () => {
  it('applies acronym overrides and sentence case', () => {
    expect(humanizeKind('login.success')).toBe('Login success');
    expect(humanizeKind('sod.violation')).toBe('SoD violation');
    expect(humanizeKind('mover.manager_change')).toBe('Mover manager change');
    expect(humanizeKind('nhi.activity')).toBe('NHI activity');
    expect(humanizeKind('mfa.challenge')).toBe('MFA challenge');
  });
});

describe('clamp', () => {
  it('bounds a value', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });
});
