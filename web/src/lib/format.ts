/**
 * Presentation formatters. Pure functions, no React, no DOM: this module is unit
 * tested in isolation. Every formatter is defensive about `null`/`undefined`/NaN
 * because it renders live telemetry that can briefly be absent between frames.
 */

const NBSP = ' ';

/** Guard: return a dash for values that should not be rendered as numbers. */
function isBadNumber(n: number | null | undefined): n is null | undefined {
  return n === null || n === undefined || Number.isNaN(n) || !Number.isFinite(n);
}

/** Integer with thousands separators, e.g. 1284 -> "1,284". */
export function formatInt(n: number | null | undefined): string {
  if (isBadNumber(n)) return '-';
  return Math.round(n).toLocaleString('en-US');
}

/**
 * Compact human number: 1284 -> "1,284", 12934 -> "12.9K", 3_400_000 -> "3.4M".
 * Below 10,000 we keep full digits (comma grouped) so operators see exact counts
 * where precision matters; above that we compact to keep tiles readable.
 */
export function compactNumber(n: number | null | undefined): string {
  if (isBadNumber(n)) return '-';
  const abs = Math.abs(n);
  if (abs < 10_000) return Math.round(n).toLocaleString('en-US');
  const units: Array<[number, string]> = [
    [1_000_000_000, 'B'],
    [1_000_000, 'M'],
    [1_000, 'K'],
  ];
  for (const [scale, suffix] of units) {
    if (abs >= scale) {
      const scaled = n / scale;
      const digits = Math.abs(scaled) >= 100 ? 0 : 1;
      return `${scaled.toFixed(digits)}${suffix}`;
    }
  }
  return Math.round(n).toLocaleString('en-US');
}

/** Requests/sec: one decimal below 100, whole numbers above. */
export function formatRps(n: number | null | undefined): string {
  if (isBadNumber(n)) return '-';
  if (n < 100) return n.toFixed(1);
  return Math.round(n).toLocaleString('en-US');
}

/** Milliseconds -> "842 ms" / "1.24 s" / "0 ms". */
export function formatMs(n: number | null | undefined): string {
  if (isBadNumber(n)) return '-';
  if (n < 1000) return `${Math.round(n)}${NBSP}ms`;
  return `${(n / 1000).toFixed(2)}${NBSP}s`;
}

/** Fraction in [0,1] -> percentage string, e.g. 0.0241 -> "2.41%". */
export function formatPct(fraction: number | null | undefined, digits = 2): string {
  if (isBadNumber(fraction)) return '-';
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** Duration in seconds -> "1h 04m 12s" / "4m 12s" / "12s". */
export function formatDuration(totalSeconds: number | null | undefined): string {
  if (isBadNumber(totalSeconds) || totalSeconds < 0) return '-';
  const s = Math.floor(totalSeconds % 60);
  const m = Math.floor((totalSeconds / 60) % 60);
  const h = Math.floor(totalSeconds / 3600);
  const pad = (x: number) => x.toString().padStart(2, '0');
  if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

/**
 * Relative time from an ISO timestamp, e.g. "3s ago", "5m ago", "just now".
 * `now` is injectable for deterministic tests.
 */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '-';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '-';
  const deltaSec = Math.max(0, Math.round((now - then) / 1000));
  if (deltaSec < 2) return 'just now';
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const min = Math.floor(deltaSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/**
 * Wall/sim clock time for a given IANA timezone, HH:MM:SS. Uses Intl so DST is
 * correct. Falls back to a plain UTC render if the zone is unknown.
 */
export function formatClockTime(iso: string, timeZone: string, withSeconds = true): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      ...(withSeconds ? { second: '2-digit' } : {}),
      hour12: false,
      timeZone,
    }).format(date);
  } catch {
    return date.toISOString().slice(11, withSeconds ? 19 : 16);
  }
}

/** Short date-time for logs and history rows: "22 Jul, 14:03". */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/** Acronyms that must not be naively title-cased. */
const TOKEN_OVERRIDES: Record<string, string> = {
  sod: 'SoD',
  mfa: 'MFA',
  sso: 'SSO',
  gdpr: 'GDPR',
  nhi: 'NHI',
  loa: 'LoA',
  sepa: 'SEPA',
  swift: 'SWIFT',
  txn: 'Txn',
  ip: 'IP',
  id: 'ID',
  api: 'API',
  hr: 'HR',
  rps: 'RPS',
};

function humanizeToken(token: string): string {
  const lower = token.toLowerCase();
  const override = TOKEN_OVERRIDES[lower];
  if (override) return override;
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * Turn a dotted/snake token string into a readable label, applying acronym
 * overrides and capitalizing only the first word:
 * "login.success" -> "Login success", "sod.violation" -> "SoD violation",
 * "mover.manager_change" -> "Mover manager change".
 */
export function humanizeKind(raw: string): string {
  const tokens = raw.split(/[._]/).filter(Boolean);
  const rendered = tokens.map((tok, i) => {
    const override = TOKEN_OVERRIDES[tok.toLowerCase()];
    if (override) return override;
    // Capitalize only the leading token; keep the rest lowercase for readability.
    return i === 0 ? humanizeToken(tok) : tok.toLowerCase();
  });
  const joined = rendered.join(' ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/** Clamp a number into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
