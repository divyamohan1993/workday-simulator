/**
 * Timezone helpers for the diurnal arrival model and the workday clock.
 *
 * WHY this exists: the arrival intensity and the clock's business phase both need
 * the LOCAL wall-clock hour and weekday at each modeled site, computed correctly
 * across daylight-saving transitions. The only DST-correct primitive available with
 * zero dependencies is `Intl.DateTimeFormat`, but constructing a formatter and
 * calling `formatToParts` is far too expensive to run on the hot path (arrival
 * sampling happens thousands of times per second).
 *
 * The trick: a timezone's UTC offset is constant except at the two DST switches per
 * year, so we memoize the offset per timezone in coarse (30 minute) buckets of the
 * instant. After the first Intl call for a bucket, every local-time query is plain
 * integer arithmetic on the cached offset. A 30 minute bucket means the offset can
 * be at most 30 minutes stale for the single instant a DST switch occurs, which is
 * negligible for shaping a smooth traffic curve and never affects correctness away
 * from that instant.
 */

/** Local wall-clock breakdown of an instant in a specific IANA timezone. */
export interface LocalTimeInfo {
  /** Hour of day as a fraction in [0, 24), e.g. 8.5 is 08:30. */
  hourFrac: number;
  /** Day of week, 0 = Sunday through 6 = Saturday (matches ClockState.weekday). */
  weekday: number;
  /** Day of month, 1 to 31. */
  day: number;
  /** Month of year, 1 to 12. */
  month: number;
  /** Full year, e.g. 2026. */
  year: number;
  /** Integer hour, 0 to 23. */
  hour: number;
  /** Integer minute, 0 to 59. */
  minute: number;
}

const BUCKET_MS = 30 * 60 * 1000;
const OFFSET_CACHE_LIMIT = 512;

/** Reusable formatters, one per timezone. Construction is the expensive part. */
const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Timezones this runtime's ICU build cannot resolve. Not every ICU build ships every
 * IANA alias (this is why the engine uses the canonical Europe/Berlin for Frankfurt),
 * so an unknown zone must degrade to UTC rather than throw on the hot path and crash
 * a run. A zone is recorded here the first time its formatter fails to construct.
 */
const unsupportedZones = new Set<string>();

/** Memoized offsets keyed by `${timezone}|${bucket}`, bounded in size. */
const offsetCache = new Map<string, number>();

function formatterFor(timezone: string): Intl.DateTimeFormat | null {
  if (unsupportedZones.has(timezone)) return null;
  let fmt = formatters.get(timezone);
  if (fmt === undefined) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      unsupportedZones.add(timezone);
      return null;
    }
    formatters.set(timezone, fmt);
  }
  return fmt;
}

/**
 * Compute the timezone's UTC offset in minutes at an instant. Positive means ahead
 * of UTC (for example Berlin in winter is +60). Works by formatting the instant as
 * local wall-clock parts, reinterpreting those parts as if they were UTC, and
 * measuring the gap back to the true instant. Falls back to 0 (UTC) for a timezone
 * the runtime's ICU build does not support.
 */
function computeOffsetMinutes(timezone: string, epochMs: number): number {
  const formatter = formatterFor(timezone);
  if (formatter === null) return 0;
  const parts = formatter.formatToParts(new Date(epochMs));
  let year = 1970;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of parts) {
    switch (part.type) {
      case 'year':
        year = Number(part.value);
        break;
      case 'month':
        month = Number(part.value);
        break;
      case 'day':
        day = Number(part.value);
        break;
      case 'hour':
        // hourCycle h23 yields 00 to 23, but guard the historical '24' quirk.
        hour = Number(part.value) % 24;
        break;
      case 'minute':
        minute = Number(part.value);
        break;
      case 'second':
        second = Number(part.value);
        break;
      default:
        break;
    }
  }
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return Math.round((asIfUtc - epochMs) / 60000);
}

/**
 * The timezone's UTC offset in minutes at an instant, memoized per 30 minute
 * bucket. The first call for a bucket does the Intl work; subsequent calls are a
 * map lookup.
 */
export function offsetMinutes(timezone: string, epochMs: number): number {
  const bucket = Math.floor(epochMs / BUCKET_MS);
  const key = `${timezone}|${bucket}`;
  const hit = offsetCache.get(key);
  if (hit !== undefined) return hit;
  const offset = computeOffsetMinutes(timezone, epochMs);
  // Bound memory: the working set is tiny (a handful of timezones over a run's span
  // of buckets), so a hard clear on overflow is simpler and cheaper than an LRU.
  if (offsetCache.size >= OFFSET_CACHE_LIMIT) offsetCache.clear();
  offsetCache.set(key, offset);
  return offset;
}

/**
 * Local wall-clock breakdown of `epochMs` in `timezone`. Hot-path safe: after the
 * per-bucket offset is cached this is pure arithmetic on a UTC Date whose fields we
 * read with getUTC* accessors (the offset has already been folded in).
 */
export function localTimeInfo(timezone: string, epochMs: number): LocalTimeInfo {
  const offset = offsetMinutes(timezone, epochMs);
  const localMs = epochMs + offset * 60000;
  const d = new Date(localMs);
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  const second = d.getUTCSeconds();
  return {
    hourFrac: hour + minute / 60 + second / 3600,
    weekday: d.getUTCDay(),
    day: d.getUTCDate(),
    month: d.getUTCMonth() + 1,
    year: d.getUTCFullYear(),
    hour,
    minute,
  };
}

/**
 * IANA zone for the Frankfurt headquarters, the reference calendar for the sim.
 *
 * WHY Europe/Berlin and not Europe/Frankfurt: Frankfurt observes Central European
 * Time identically to Berlin, but some ICU builds (including common minimal Linux
 * and Node distributions) do not ship the Europe/Frankfurt alias and throw
 * "Invalid time zone" for it. Europe/Berlin is the canonical zone and is present
 * everywhere, so the sim uses it for all Frankfurt time math.
 */
export const FRANKFURT_TZ = 'Europe/Berlin';
