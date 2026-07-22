import type {
  CircuitState,
  EventCategory,
  RunStatus,
  Severity,
  WorkdayPhase,
} from '@/types/api';

/**
 * The chart + status color source of truth for JS (recharts needs hex values,
 * so CSS custom properties alone will not do). These mirror the tokens declared
 * in `index.css`. Every value was checked with the dataviz validator against the
 * panel surface (#0d1220-ish) for >= 3:1 contrast and CVD separation.
 *
 * WHY hard-coded here and mirrored in CSS: recharts renders SVG from JS and
 * cannot read CSS variables reliably across its internal canvas measurement, so
 * the series colors must exist as literals. The two lists are kept short and
 * side-by-side in review to prevent drift.
 */

/** Validated categorical slots (dark surface), assigned to event categories. */
export const CATEGORY_COLORS: Record<EventCategory, string> = {
  AUTH: '#3987e5', // slot 1 - blue
  JML: '#d95926', // slot 2 - orange
  ACCESS: '#199e70', // slot 3 - aqua
  TXN: '#c98500', // slot 4 - yellow
  COMPLIANCE: '#d55181', // slot 5 - magenta
};

/**
 * Latency percentile colors. This trio (aqua/blue/orange) is the only
 * all-pairs-safe choice for three overlapping lines; a green->amber->red
 * "traffic light" fails CVD separation, so identity leans on the legend and
 * direct end-labels, not on a hot/cold hue instinct.
 */
export const LATENCY_COLORS = {
  p50: '#199e70', // aqua - calm
  p95: '#3987e5', // blue
  p99: '#d95926', // orange - most prominent
} as const;

/** Fixed status palette (never themed). Always shipped with an icon + label. */
export const STATUS_COLORS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
  neutral: '#6b7796',
} as const;

export type StatusTone = keyof typeof STATUS_COLORS;

/** Chart chrome for recharts axes/grids on the dark surface. */
export const CHART = {
  grid: 'rgba(148, 163, 210, 0.09)',
  axis: '#6b7796',
  baseline: 'rgba(148, 163, 210, 0.2)',
  accent: '#3b82f6',
  accentCyan: '#22d3ee',
  reference: '#6b7796', // target/threshold reference lines (muted, dashed)
  surface: '#0b1020',
  tooltipBg: '#10162e',
} as const;

/** Event severity -> status tone (for ticker dots and severity chips). */
export const SEVERITY_TONE: Record<Severity, StatusTone> = {
  info: 'neutral',
  notice: 'good',
  warning: 'warning',
  error: 'serious',
  critical: 'critical',
};

/** Delivery circuit-breaker state -> status tone. */
export const CIRCUIT_TONE: Record<CircuitState, StatusTone> = {
  closed: 'good',
  half_open: 'warning',
  open: 'critical',
};

/** Run lifecycle status -> status tone. */
export const RUN_STATUS_TONE: Record<RunStatus, StatusTone> = {
  idle: 'neutral',
  starting: 'warning',
  running: 'good',
  paused: 'warning',
  stopping: 'serious',
  completed: 'neutral',
  failed: 'critical',
};

/** Workday phase -> accent color for the follow-the-sun / clock chrome. */
export const PHASE_COLOR: Record<WorkdayPhase, string> = {
  overnight: '#4a5578',
  pre_market: '#6d7fb8',
  market_open: '#22d3ee',
  core_hours: '#3987e5',
  lunch: '#c98500',
  market_close: '#d95926',
  evening: '#8a6bd0',
};

/** Resolve a status tone to its hex. */
export function toneColor(tone: StatusTone): string {
  return STATUS_COLORS[tone];
}
