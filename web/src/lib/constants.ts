import type {
  DeliveryKind,
  Division,
  EmployeeType,
  EventCategory,
  Grade,
  LocationCode,
  Severity,
} from '@/types/api';

/**
 * Presentational domain metadata for the dashboard. These are NOT the authoritative
 * backend model (that lives in `src/types`, which the separately-bundled web app
 * cannot import). They are display helpers: labels, the follow-the-sun timezone map,
 * and enum option lists for forms. Where a value must match the backend (timezone
 * math), it is derived at runtime via `Intl` from the IANA zone so it stays correct
 * through DST rather than trusting a static offset.
 */

/** Site metadata for the follow-the-sun strip and timezone-weight editor. */
export interface LocationMeta {
  code: LocationCode;
  city: string;
  country: string;
  /** IANA zone; the single source for accurate local-time rendering. */
  timezone: string;
  /** Nominal offset in minutes: a coarse hint for ordering only, never for math. */
  nominalOffsetMin: number;
  region: 'EMEA' | 'AMER' | 'APAC';
}

export const LOCATIONS: Record<LocationCode, LocationMeta> = {
  FFT: { code: 'FFT', city: 'Frankfurt', country: 'DE', timezone: 'Europe/Frankfurt', nominalOffsetMin: 60, region: 'EMEA' },
  LDN: { code: 'LDN', city: 'London', country: 'GB', timezone: 'Europe/London', nominalOffsetMin: 0, region: 'EMEA' },
  NYC: { code: 'NYC', city: 'New York', country: 'US', timezone: 'America/New_York', nominalOffsetMin: -300, region: 'AMER' },
  JAX: { code: 'JAX', city: 'Jacksonville', country: 'US', timezone: 'America/New_York', nominalOffsetMin: -300, region: 'AMER' },
  SIN: { code: 'SIN', city: 'Singapore', country: 'SG', timezone: 'Asia/Singapore', nominalOffsetMin: 480, region: 'APAC' },
  HKG: { code: 'HKG', city: 'Hong Kong', country: 'HK', timezone: 'Asia/Hong_Kong', nominalOffsetMin: 480, region: 'APAC' },
  BLR: { code: 'BLR', city: 'Bengaluru', country: 'IN', timezone: 'Asia/Kolkata', nominalOffsetMin: 330, region: 'APAC' },
  PNQ: { code: 'PNQ', city: 'Pune', country: 'IN', timezone: 'Asia/Kolkata', nominalOffsetMin: 330, region: 'APAC' },
};

/** West-to-east order for the follow-the-sun strip. */
export const LOCATION_ORDER: LocationCode[] = ['NYC', 'JAX', 'LDN', 'FFT', 'BLR', 'PNQ', 'HKG', 'SIN'];

export const ALL_LOCATIONS: LocationCode[] = ['FFT', 'LDN', 'NYC', 'SIN', 'HKG', 'BLR', 'PNQ', 'JAX'];

export const ALL_CATEGORIES: EventCategory[] = ['AUTH', 'JML', 'ACCESS', 'TXN', 'COMPLIANCE'];

export const CATEGORY_LABEL: Record<EventCategory, string> = {
  AUTH: 'Authentication',
  JML: 'Joiner / Mover / Leaver',
  ACCESS: 'Access governance',
  TXN: 'Banking transactions',
  COMPLIANCE: 'Compliance & risk',
};

export const CATEGORY_SHORT: Record<EventCategory, string> = {
  AUTH: 'Auth',
  JML: 'JML',
  ACCESS: 'Access',
  TXN: 'Txn',
  COMPLIANCE: 'Compliance',
};

/**
 * Representative kinds per category, for the event-mix editor's helper text.
 * Deliberately not exhaustive: this is a UI hint, not the authoritative list.
 */
export const CATEGORY_EXAMPLES: Record<EventCategory, string> = {
  AUTH: 'logins, MFA, lockouts, impossible travel',
  JML: 'hires, transfers, promotions, terminations',
  ACCESS: 'requests, approvals, SoD, firefighter, orphan/dormant',
  TXN: 'SEPA, SWIFT, trades, card, wire, limit breach',
  COMPLIANCE: 'GDPR, audit pulls, NHI, break-glass',
};

export const ALL_DELIVERY_KINDS: DeliveryKind[] = ['scim', 'webhook', 'rest', 'nats', 'batch'];

export const DELIVERY_KIND_LABEL: Record<DeliveryKind, string> = {
  scim: 'SCIM 2.0',
  webhook: 'Webhook',
  rest: 'REST batch',
  nats: 'NATS',
  batch: 'Batch HR feed',
};

export const DELIVERY_KIND_HINT: Record<DeliveryKind, string> = {
  scim: 'Maps events to SCIM User/Group operations',
  webhook: 'POSTs each event, optional HMAC body signature',
  rest: 'POSTs events in REST batches',
  nats: 'Publishes events to a NATS subject',
  batch: 'Accumulates events into HR feed batches',
};

export const ALL_DIVISIONS: Division[] = [
  'Investment Bank',
  'Corporate Bank',
  'Private Bank',
  'Asset Management',
  'Technology, Data & Innovation',
  'Operations',
  'Risk',
  'Compliance',
  'Human Resources',
  'Finance',
];

export const ALL_GRADES: Grade[] = [
  'Intern',
  'Contractor',
  'Analyst',
  'Associate',
  'AVP',
  'VP',
  'Director',
  'MD',
];

export const ALL_EMPLOYEE_TYPES: EmployeeType[] = ['FTE', 'Contractor', 'Intern', 'External', 'Service'];

export const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  notice: 1,
  warning: 2,
  error: 3,
  critical: 4,
};

/** Rolling-window sizes for live telemetry (bounded memory). */
export const TELEMETRY_LIMITS = {
  /** Frames retained for time-series charts (~2 min at 1 frame/sec). */
  maxFrames: 150,
  /** Events retained for the live ticker (newest-first ring). */
  maxTickerEvents: 60,
} as const;

/** Where the admin token is kept between reloads. sessionStorage clears on tab close. */
export const TOKEN_STORAGE_KEY = 'wds.admin.token';

/** The four primary views. */
export type ViewId = 'dashboard' | 'scenarios' | 'targets' | 'history';

export const VIEWS: Array<{ id: ViewId; label: string; hint: string }> = [
  { id: 'dashboard', label: 'Live Ops', hint: 'Accelerated workday, live telemetry' },
  { id: 'scenarios', label: 'Scenario Builder', hint: 'Compose load, chaos, start a run' },
  { id: 'targets', label: 'Targets', hint: 'Delivery destinations & auth' },
  { id: 'history', label: 'Run History', hint: 'Past runs & summaries' },
];
