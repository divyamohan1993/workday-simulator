/**
 * Deutsche Bank organizational reference data and derived resolvers.
 *
 * WHY this module exists: the workforce model needs one authoritative, side-effect
 * free description of the bank's real-world structure (sites and their IANA zones,
 * legal entities, job families, the grade pyramid, cost centers) so that seeding,
 * lifecycle mutations, and the location-aware activity weighting used by
 * `pickActive` all agree. Nothing here reads the wall clock, config, or process
 * env; every function is deterministic given its inputs so runs are reproducible.
 *
 * Realism sources: Deutsche Bank operates from Frankfurt (HQ) plus London, New
 * York, Singapore, Hong Kong, the Indian technology hubs (Bangalore, Pune) and the
 * Jacksonville operations center, across a set of named legal entities. Timezones
 * are canonical IANA identifiers: Frankfurt shares "Europe/Berlin" because some
 * Node ICU builds reject the "Europe/Frankfurt" link name.
 */

import type {
  CostCenter,
  Division,
  EmployeeType,
  Grade,
  JobFamily,
  LegalEntity,
  Location,
  LocationCode,
} from '../types/index.js';
import { ALL_DIVISIONS } from '../types/index.js';

/**
 * Minimal deterministic RNG surface this module needs from the seeded Faker
 * instance. Declaring the surface (rather than importing the Faker type) keeps the
 * reference data decoupled from the generator library and trivially testable.
 */
export interface Rng {
  number: {
    int(options: { min: number; max: number }): number;
    float(options: { min: number; max: number }): number;
  };
  helpers: {
    arrayElement<T>(array: readonly T[]): T;
    weightedArrayElement<T>(array: ReadonlyArray<{ weight: number; value: T }>): T;
  };
}

/**
 * Fixed reference instant for all timestamps produced during `seed()`. Seeding must
 * never read the wall clock (that would make the pool non-deterministic), so every
 * seeded start date, grant date and audit timestamp is computed relative to this
 * constant. It is chosen to sit shortly before the simulator's operating window so
 * seeded employees have plausibly "already started".
 */
export const SEED_REFERENCE_EPOCH_MS = Date.UTC(2026, 5, 1, 0, 0, 0); // 2026-06-01T00:00:00Z

/** The eight modeled physical sites with canonical IANA timezones. */
export const LOCATIONS: Record<LocationCode, Location> = {
  FFT: {
    code: 'FFT',
    city: 'Frankfurt',
    country: 'DE',
    timezone: 'Europe/Berlin',
    isHeadquarters: true,
    utcOffsetMinutes: 60,
  },
  LDN: {
    code: 'LDN',
    city: 'London',
    country: 'GB',
    timezone: 'Europe/London',
    isHeadquarters: false,
    utcOffsetMinutes: 0,
  },
  NYC: {
    code: 'NYC',
    city: 'New York',
    country: 'US',
    timezone: 'America/New_York',
    isHeadquarters: false,
    utcOffsetMinutes: -300,
  },
  SIN: {
    code: 'SIN',
    city: 'Singapore',
    country: 'SG',
    timezone: 'Asia/Singapore',
    isHeadquarters: false,
    utcOffsetMinutes: 480,
  },
  HKG: {
    code: 'HKG',
    city: 'Hong Kong',
    country: 'HK',
    timezone: 'Asia/Hong_Kong',
    isHeadquarters: false,
    utcOffsetMinutes: 480,
  },
  BLR: {
    code: 'BLR',
    city: 'Bangalore',
    country: 'IN',
    timezone: 'Asia/Kolkata',
    isHeadquarters: false,
    utcOffsetMinutes: 330,
  },
  PNQ: {
    code: 'PNQ',
    city: 'Pune',
    country: 'IN',
    timezone: 'Asia/Kolkata',
    isHeadquarters: false,
    utcOffsetMinutes: 330,
  },
  JAX: {
    code: 'JAX',
    city: 'Jacksonville',
    country: 'US',
    timezone: 'America/New_York',
    isHeadquarters: false,
    utcOffsetMinutes: -300,
  },
};

/** Non-null site lookup. Codes come from the frozen union, so a miss is a bug. */
export function locationOf(code: LocationCode): Location {
  const site = LOCATIONS[code];
  if (!site) {
    throw new Error(`Unknown location code: ${String(code)}`);
  }
  return site;
}

/** Short division codes used in cost-center codes, AD OUs and entitlement names. */
export const DIVISION_CODE: Record<Division, string> = {
  'Investment Bank': 'IB',
  'Corporate Bank': 'CB',
  'Private Bank': 'PB',
  'Asset Management': 'AM',
  'Technology, Data & Innovation': 'TDI',
  Operations: 'OPS',
  Risk: 'RSK',
  Compliance: 'CMP',
  'Human Resources': 'HR',
  Finance: 'FIN',
};

/**
 * The job families that plausibly staff each division. Every listed family is a
 * member of the frozen `JobFamily` union. Used to pick a realistic family per hire.
 */
export const JOB_FAMILIES_BY_DIVISION: Record<Division, readonly JobFamily[]> = {
  'Investment Bank': ['Trading', 'Sales', 'Research', 'Quant'],
  'Corporate Bank': ['Relationship Management', 'Payments Operations', 'Credit Analysis', 'Settlements'],
  'Private Bank': ['Wealth Advisory', 'Relationship Management', 'Credit Analysis'],
  'Asset Management': ['Portfolio Management', 'Research', 'Quant', 'Sales'],
  'Technology, Data & Innovation': [
    'Software Engineering',
    'Site Reliability',
    'Data Engineering',
    'Cybersecurity',
  ],
  Operations: ['Operations Processing', 'Payments Operations', 'Settlements'],
  Risk: ['Risk Management', 'Quant'],
  Compliance: ['Compliance & AFC', 'Audit'],
  'Human Resources': ['Human Resources'],
  Finance: ['Finance & Controlling', 'Audit', 'Legal'],
};

/** Job families that machine (NHI) identities typically run under, per division. */
const NHI_JOB_FAMILY: Record<Division, JobFamily> = {
  'Investment Bank': 'Site Reliability',
  'Corporate Bank': 'Payments Operations',
  'Private Bank': 'Software Engineering',
  'Asset Management': 'Data Engineering',
  'Technology, Data & Innovation': 'Site Reliability',
  Operations: 'Operations Processing',
  Risk: 'Data Engineering',
  Compliance: 'Cybersecurity',
  'Human Resources': 'Software Engineering',
  Finance: 'Data Engineering',
};

/** Career grades a human FTE/External can hold, weighted into a realistic pyramid. */
const GRADE_PYRAMID: ReadonlyArray<{ weight: number; value: Grade }> = [
  { weight: 28, value: 'Analyst' },
  { weight: 26, value: 'Associate' },
  { weight: 18, value: 'AVP' },
  { weight: 15, value: 'VP' },
  { weight: 8, value: 'Director' },
  { weight: 3, value: 'MD' },
];

/** Employment-type mix across the workforce. Service = non-human (NHI). */
const EMPLOYEE_TYPE_MIX: ReadonlyArray<{ weight: number; value: EmployeeType }> = [
  { weight: 71, value: 'FTE' },
  { weight: 12, value: 'Contractor' },
  { weight: 5, value: 'Intern' },
  { weight: 7, value: 'External' },
  { weight: 5, value: 'Service' },
];

/** Relative headcount weight per division (Technology and Operations dominate). */
const DIVISION_MIX: ReadonlyArray<{ weight: number; value: Division }> = [
  { weight: 18, value: 'Technology, Data & Innovation' },
  { weight: 16, value: 'Operations' },
  { weight: 14, value: 'Investment Bank' },
  { weight: 12, value: 'Corporate Bank' },
  { weight: 9, value: 'Private Bank' },
  { weight: 8, value: 'Asset Management' },
  { weight: 8, value: 'Risk' },
  { weight: 6, value: 'Finance' },
  { weight: 5, value: 'Compliance' },
  { weight: 4, value: 'Human Resources' },
];

/** Relative headcount weight per site (Frankfurt HQ and the India hubs are large). */
const LOCATION_MIX: ReadonlyArray<{ weight: number; value: LocationCode }> = [
  { weight: 22, value: 'FFT' },
  { weight: 16, value: 'LDN' },
  { weight: 14, value: 'NYC' },
  { weight: 16, value: 'BLR' },
  { weight: 10, value: 'PNQ' },
  { weight: 8, value: 'JAX' },
  { weight: 8, value: 'SIN' },
  { weight: 6, value: 'HKG' },
];

/** All modeled legal entities, for iteration and validation. */
export const LEGAL_ENTITIES: readonly LegalEntity[] = [
  'Deutsche Bank AG',
  'DB Privat- und Firmenkundenbank AG',
  'Deutsche Bank Trust Company Americas',
  'DWS Group GmbH & Co. KGaA',
  'Deutsche Bank Luxembourg S.A.',
  'Deutsche Bank AG, London Branch',
  'Deutsche India Private Limited',
  'Deutsche Bank (Singapore) Ltd',
  'Deutsche Bank AG, Hong Kong Branch',
];

/**
 * Resolve the booking legal entity for a (division, location). Location dominates
 * because branches and subsidiaries are jurisdiction-bound; Frankfurt splits by
 * division (DWS for Asset Management, the retail bank for Private Bank). The caller
 * may pass `preferFundEntity` to route a fraction of Asset Management identities to
 * the Luxembourg fund entity, which is otherwise unreachable by location.
 *
 * @param division The employee's division.
 * @param location The employee's site.
 * @param preferFundEntity When true and division is Asset Management, use the
 *   Luxembourg fund entity instead of DWS Group.
 * @returns The resolved legal entity.
 */
export function resolveLegalEntity(
  division: Division,
  location: LocationCode,
  preferFundEntity = false,
): LegalEntity {
  if (division === 'Asset Management') {
    return preferFundEntity ? 'Deutsche Bank Luxembourg S.A.' : 'DWS Group GmbH & Co. KGaA';
  }
  switch (location) {
    case 'LDN':
      return 'Deutsche Bank AG, London Branch';
    case 'NYC':
    case 'JAX':
      return 'Deutsche Bank Trust Company Americas';
    case 'SIN':
      return 'Deutsche Bank (Singapore) Ltd';
    case 'HKG':
      return 'Deutsche Bank AG, Hong Kong Branch';
    case 'BLR':
    case 'PNQ':
      return 'Deutsche India Private Limited';
    case 'FFT':
      return division === 'Private Bank'
        ? 'DB Privat- und Firmenkundenbank AG'
        : 'Deutsche Bank AG';
    default:
      return 'Deutsche Bank AG';
  }
}

/** Draw a division weighted by realistic headcount. */
export function pickDivision(rng: Rng): Division {
  return rng.helpers.weightedArrayElement(DIVISION_MIX);
}

/** Draw a site weighted by realistic headcount. */
export function pickLocation(rng: Rng): LocationCode {
  return rng.helpers.weightedArrayElement(LOCATION_MIX);
}

/** Draw an employment type weighted by the workforce mix. */
export function pickEmployeeType(rng: Rng): EmployeeType {
  return rng.helpers.weightedArrayElement(EMPLOYEE_TYPE_MIX);
}

/**
 * Pick a grade consistent with an employment type. Interns and Contractors map to
 * their eponymous grades; machine identities carry a nominal Analyst grade (their
 * true signal is `isNonHuman`); FTE/External draw from the career pyramid.
 */
export function pickGrade(rng: Rng, type: EmployeeType): Grade {
  switch (type) {
    case 'Intern':
      return 'Intern';
    case 'Contractor':
      return 'Contractor';
    case 'Service':
      return 'Analyst';
    default:
      return rng.helpers.weightedArrayElement(GRADE_PYRAMID);
  }
}

/** Pick a job family valid for the division; machine identities get a tech family. */
export function pickJobFamily(rng: Rng, division: Division, isNonHuman: boolean): JobFamily {
  if (isNonHuman) {
    const family = NHI_JOB_FAMILY[division];
    return family;
  }
  const families = JOB_FAMILIES_BY_DIVISION[division];
  return rng.helpers.arrayElement(families);
}

/** Human-readable job title from family and grade, e.g. "VP, Trading". */
export function titleFor(jobFamily: JobFamily, grade: Grade): string {
  return `${grade}, ${jobFamily}`;
}

/* ============================================================================
 * Cost centers
 * ========================================================================== */

/**
 * Build a deterministic catalog of cost centers, a handful per division, each bound
 * to that division's primary Frankfurt legal entity for chargeback realism. The
 * catalog is stable for a given rng stream so transfers can re-pick from it.
 *
 * @param rng Seeded RNG.
 * @param perDivision How many cost centers to mint per division.
 * @returns A flat, deterministic list of cost centers.
 */
export function buildCostCenterCatalog(rng: Rng, perDivision: number): CostCenter[] {
  const catalog: CostCenter[] = [];
  for (const division of ALL_DIVISIONS) {
    const code = DIVISION_CODE[division];
    for (let i = 0; i < perDivision; i += 1) {
      const serial = rng.number.int({ min: 1000, max: 9999 });
      catalog.push({
        code: `CC-${code}-${serial}`,
        name: `${division} Cost Center ${i + 1}`,
        division,
        legalEntity: resolveLegalEntity(division, 'FFT'),
      });
    }
  }
  return catalog;
}

/** Index a cost-center catalog by division for O(1) division-scoped draws. */
export function indexCostCentersByDivision(
  catalog: readonly CostCenter[],
): Record<Division, CostCenter[]> {
  const index = Object.fromEntries(ALL_DIVISIONS.map((d) => [d, [] as CostCenter[]])) as Record<
    Division,
    CostCenter[]
  >;
  for (const cc of catalog) {
    index[cc.division].push(cc);
  }
  return index;
}

/* ============================================================================
 * Location activity weighting (drives pickActive)
 * ========================================================================== */

/** Cache of IANA-zone formatters; construction is the expensive part of Intl. */
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timezone: string): Intl.DateTimeFormat {
  let fmt = zoneFormatters.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
      weekday: 'short',
    });
    zoneFormatters.set(timezone, fmt);
  }
  return fmt;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Local hour (0..23) and weekday (0=Sun..6=Sat) at a site for a given instant.
 * Uses cached Intl formatters so it is correct across DST without any offset math.
 */
export function localTimeAt(
  simEpochMs: number,
  code: LocationCode,
): { hour: number; weekday: number } {
  const parts = zoneFormatter(locationOf(code).timezone).formatToParts(new Date(simEpochMs));
  let hour = 0;
  let weekday = 1;
  for (const part of parts) {
    if (part.type === 'hour') {
      // Intl may render midnight as "24" in hour12:false mode; normalize to 0..23.
      hour = Number.parseInt(part.value, 10) % 24;
    } else if (part.type === 'weekday') {
      weekday = WEEKDAY_INDEX[part.value] ?? 1;
    }
  }
  return { hour, weekday };
}

/**
 * Per-hour weekday office-presence curve (0..1). Peaks across the morning and
 * afternoon core, dips at lunch, and collapses overnight. This shapes where logins
 * and interactive activity cluster so `pickActive` favors regions that are at work.
 */
const WEEKDAY_HOURLY_WEIGHT: readonly number[] = [
  0.05, 0.04, 0.03, 0.03, 0.04, 0.06, // 00-05
  0.14, 0.32, 0.62, 0.9, 1.0, 1.0, // 06-11
  0.72, 0.95, 1.0, 0.98, 0.9, 0.72, // 12-17
  0.5, 0.34, 0.24, 0.16, 0.1, 0.07, // 18-23
];

/**
 * Activity weight in [0,1] for a site at a simulated instant. Weekends collapse to
 * a small on-call floor (settlement windows, SRE, follow-the-sun support). This is
 * the single source of the location weighting used by `IdentityPool.pickActive`.
 *
 * @param simEpochMs Simulated epoch milliseconds.
 * @param code Site to weight.
 * @returns A non-negative activity weight; higher means "more people at work now".
 */
export function businessActivityWeight(simEpochMs: number, code: LocationCode): number {
  const { hour, weekday } = localTimeAt(simEpochMs, code);
  const base = WEEKDAY_HOURLY_WEIGHT[hour] ?? 0.1;
  if (weekday === 0 || weekday === 6) {
    // Weekend: a thin, hour-shaped on-call presence.
    return 0.06 * base + 0.01;
  }
  return base;
}

/** Convert an epoch-ms instant to an ISO 8601 string. */
export function isoFromEpoch(ms: number): string {
  return new Date(ms).toISOString();
}
