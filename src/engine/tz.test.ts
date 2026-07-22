import { describe, it, expect } from 'vitest';
import { FRANKFURT_TZ, localTimeInfo, offsetMinutes } from './tz.js';

// 2026-06-16 08:30 UTC is a Tuesday. Berlin is CEST (+2) and New York is EDT (-4) then.
const SUMMER = Date.UTC(2026, 5, 16, 8, 30, 0);
// 2026-01-16 08:30 UTC: Berlin is CET (+1).
const WINTER = Date.UTC(2026, 0, 16, 8, 30, 0);

describe('tz helpers', () => {
  it('uses Europe/Berlin as the Frankfurt reference (Frankfurt alias is not portable)', () => {
    expect(FRANKFURT_TZ).toBe('Europe/Berlin');
  });

  it('computes correct local wall-clock for Berlin', () => {
    const info = localTimeInfo('Europe/Berlin', SUMMER);
    expect(info.hour).toBe(10);
    expect(info.minute).toBe(30);
    expect(info.hourFrac).toBeCloseTo(10.5, 6);
    expect(info.weekday).toBe(2); // Tuesday
    expect(info.day).toBe(16);
    expect(info.month).toBe(6);
    expect(info.year).toBe(2026);
  });

  it('applies each zone offset correctly, including DST', () => {
    expect(offsetMinutes('Europe/Berlin', SUMMER)).toBe(120); // CEST
    expect(offsetMinutes('Europe/Berlin', WINTER)).toBe(60); // CET
    expect(offsetMinutes('America/New_York', SUMMER)).toBe(-240); // EDT
    expect(localTimeInfo('America/New_York', SUMMER).hour).toBe(4);
  });

  it('degrades an unsupported timezone to UTC instead of throwing', () => {
    // A definitely-invalid zone (portable across every ICU build) must fall back to
    // UTC so a run degrades rather than crashing on the hot path.
    let info: ReturnType<typeof localTimeInfo> | undefined;
    expect(() => {
      info = localTimeInfo('Invalid/Zone_XYZ', SUMMER);
    }).not.toThrow();
    expect(offsetMinutes('Invalid/Zone_XYZ', SUMMER)).toBe(0);
    // With a zero offset the local hour equals the UTC hour (08:30).
    expect(info?.hour).toBe(8);
    expect(info?.minute).toBe(30);
  });
});
