/**
 * The diurnal intensity model: the shape of lambda(t) that turns a flat baseline
 * event rate into a realistic, follow-the-sun banking workday.
 *
 * WHY it is built this way: real identity and banking traffic is driven by people
 * arriving at work, and Deutsche Bank staff sit in eight timezones. Rather than
 * hand-draw one global curve, we compute a per-site local-time intensity and sum
 * the sites weighted by their headcount. Because each site is evaluated in its OWN
 * local time, the overlap of Asia, Europe and the Americas emerges naturally: the
 * classic morning login surge rolls west across the day, Europe-afternoon meets
 * US-morning at the global peak, and the whole world troughs together overnight at
 * the weekend. Weekly seasonality (Monday heavy, Friday light, weekend minimal) and
 * monthly effects (payroll day, quarter-end audit surge) layer on top.
 *
 * Everything here is a pure function of the simulated instant and the scenario's
 * timezone weights, so it is fully deterministic and cheap to test.
 */

import type { LocationCode, TimezoneWeights } from '../types/index.js';
import { ALL_LOCATIONS } from '../types/index.js';
import { FRANKFURT_TZ, localTimeInfo } from './tz.js';

/**
 * IANA timezone for each modeled site. Bangalore and Pune share IST; Jacksonville
 * runs on US Eastern like New York. These drive the local-time intensity, so DST is
 * handled correctly per region. Frankfurt uses the canonical Europe/Berlin because
 * some ICU builds omit the Europe/Frankfurt alias (see tz.ts).
 */
export const LOCATION_TIMEZONE: Record<LocationCode, string> = {
  FFT: 'Europe/Berlin',
  LDN: 'Europe/London',
  NYC: 'America/New_York',
  SIN: 'Asia/Singapore',
  HKG: 'Asia/Hong_Kong',
  BLR: 'Asia/Kolkata',
  PNQ: 'Asia/Kolkata',
  JAX: 'America/New_York',
};

/** Standard normal bump, peak 1 at `mu`, width `sigma`. */
function gaussian(x: number, mu: number, sigma: number): number {
  const z = (x - mu) / sigma;
  return Math.exp(-0.5 * z * z);
}

/** Smooth 0..1 ramp between two edges (Hermite smoothstep). */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Intensity of a single site across its local hour of day, in roughly [0, 1.1].
 *
 * Composition, all in local time:
 * - a small always-on floor (0.015) for 24x7 operations and on-call staff;
 * - a daytime plateau that ramps up through the morning and down after 17:00;
 * - a sharp login surge peaking at 08:30;
 * - a lunch dip around 12:45;
 * - an end-of-day logoff spike around 17:45;
 * - a modest overnight batch-window bump around 02:00.
 *
 * The curve is strictly increasing across the morning ramp (roughly 06:00 to 08:30),
 * which the arrival-rate test relies on. No upper clamp is applied; the natural peak
 * sits near 1.05.
 */
export function businessCurve(hourFrac: number): number {
  const floor = 0.015;
  const plateau = 0.55 * (smoothstep(6.5, 8.5, hourFrac) - smoothstep(17.0, 19.5, hourFrac));
  const loginSurge = 0.45 * gaussian(hourFrac, 8.5, 0.7);
  const lunchDip = -0.22 * gaussian(hourFrac, 12.75, 0.8);
  const eodSpike = 0.32 * gaussian(hourFrac, 17.75, 0.7);
  const overnightBatch = 0.12 * gaussian(hourFrac, 2.2, 0.7);
  const value = floor + plateau + loginSurge + lunchDip + eodSpike + overnightBatch;
  return value > 0 ? value : 0;
}

/**
 * Weekly seasonality multiplier. Monday is the heaviest business day, Friday is
 * lighter, and the weekend collapses to a small fraction (batch jobs, on-call,
 * settlement tails). Indexed by weekday 0 = Sunday through 6 = Saturday.
 */
export function weekdayFactor(weekday: number): number {
  switch (weekday) {
    case 1:
      return 1.05; // Monday
    case 2:
      return 1.0; // Tuesday
    case 3:
      return 1.0; // Wednesday
    case 4:
      return 0.98; // Thursday
    case 5:
      return 0.9; // Friday
    case 6:
      return 0.08; // Saturday
    default:
      return 0.06; // Sunday
  }
}

/** Last calendar day of a given month (1-based month). */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Monthly seasonality multiplier keyed on the Frankfurt reference calendar:
 * - payroll pressure on the 25th and on the last day of the month;
 * - a quarter-end audit and reporting surge in the last three days of March, June,
 *   September and December;
 * - a lighter month-start reporting bump on the first two days.
 *
 * Effects compose multiplicatively and are capped so a single day cannot explode
 * the baseline.
 */
export function monthlyFactor(day: number, month: number, year: number): number {
  let factor = 1;
  const lastDay = lastDayOfMonth(year, month);

  if (day === 25 || day === lastDay) factor *= 1.25; // payroll
  if ((month === 3 || month === 6 || month === 9 || month === 12) && day >= lastDay - 2) {
    factor *= 1.4; // quarter-end audit surge
  }
  if (day <= 2) factor *= 1.1; // month-start reporting

  return Math.min(factor, 2.2);
}

/**
 * Reference intensity of a single site at a canonical mid-morning core-hours instant
 * (10:30 local, an ordinary weekday). Used to normalize the weighted sum so that a
 * scenario's `baselineRps` corresponds to steady-state core-hours traffic rather
 * than to some arbitrary curve height. Derived from `businessCurve` so it stays
 * correct if the curve is retuned.
 */
export const REFERENCE_INTENSITY = businessCurve(10.5);

/** Local-time intensity of one site at an instant, folding in weekly seasonality. */
function siteIntensity(location: LocationCode, epochMs: number): number {
  const timezone = LOCATION_TIMEZONE[location];
  if (!timezone) return 0;
  const info = localTimeInfo(timezone, epochMs);
  return businessCurve(info.hourFrac) * weekdayFactor(info.weekday);
}

/**
 * The dimensionless intensity multiplier applied to `baselineRps` at a simulated
 * instant. Around 1.0 during ordinary global core hours, well above during the
 * Europe-afternoon and US-morning overlap peaks, and a small fraction overnight and
 * at weekends. Never negative.
 *
 * @param epochMs Simulated instant in epoch milliseconds.
 * @param weights Per-site activity weights from the scenario; a zero weight removes
 *   a site entirely (used by tests to isolate a single timezone).
 */
export function diurnalShape(epochMs: number, weights: TimezoneWeights): number {
  let raw = 0;
  let weightSum = 0;
  for (const location of ALL_LOCATIONS) {
    const w = weights.byLocation[location] ?? 0;
    if (!(w > 0)) continue;
    raw += w * siteIntensity(location, epochMs);
    weightSum += w;
  }
  if (weightSum <= 0 || REFERENCE_INTENSITY <= 0) return 0;

  const frankfurt = localTimeInfo(FRANKFURT_TZ, epochMs);
  const monthly = monthlyFactor(frankfurt.day, frankfurt.month, frankfurt.year);

  const shape = (raw / (weightSum * REFERENCE_INTENSITY)) * monthly;
  return shape > 0 ? shape : 0;
}
