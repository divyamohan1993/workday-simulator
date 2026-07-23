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
 * in `index.css`. Every value was checked against the WHITE panel surface for
 * >= 4.5:1 text / >= 3:1 graphical contrast and CVD separation as a set. Colours
 * lean on Deutsche Bank's own palette (navy/blue/teal/magenta) deepened for the
 * light surface, with a warm orange and ochre added purely for CVD separation.
 *
 * WHY hard-coded here and mirrored in CSS: recharts renders SVG from JS and
 * cannot read CSS variables reliably across its internal canvas measurement, so
 * the series colors must exist as literals. The two lists are kept short and
 * side-by-side in review to prevent drift.
 */

/** Validated categorical slots (white surface), assigned to event categories. */
export const CATEGORY_COLORS: Record<EventCategory, string> = {
  AUTH: '#0b57c2', // DB blue
  JML: '#c2410c', // orange
  ACCESS: '#0f766e', // teal
  TXN: '#9a6a00', // ochre
  COMPLIANCE: '#be185d', // DB magenta
};

/**
 * Latency percentile colors. This trio (teal/blue/orange) is the only
 * all-pairs-safe choice for three overlapping lines; a green->amber->red
 * "traffic light" fails CVD separation, so identity leans on the legend and
 * direct end-labels, not on a hot/cold hue instinct.
 */
export const LATENCY_COLORS = {
  p50: '#0f766e', // teal - calm
  p95: '#0b57c2', // DB blue
  p99: '#c2410c', // orange - most prominent
} as const;

/** Fixed status palette (light surface). Always shipped with an icon + label. */
export const STATUS_COLORS = {
  good: '#0f7d33',
  warning: '#b7791f',
  serious: '#c2410c',
  critical: '#c8102e',
  neutral: '#5b6570',
} as const;

export type StatusTone = keyof typeof STATUS_COLORS;

/** Chart chrome for recharts axes/grids on the white surface. */
export const CHART = {
  grid: 'rgba(30, 42, 120, 0.08)',
  axis: '#5b6570',
  baseline: 'rgba(30, 42, 120, 0.18)',
  accent: '#0550d1',
  accentCyan: '#0f8a8a', // DB teal, deepened for on-white legibility
  reference: '#94a3b8', // target/threshold reference lines (muted, dashed)
  surface: '#ffffff',
  tooltipBg: '#ffffff',
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

/** Workday phase -> accent color for the follow-the-sun / clock chrome (on white). */
export const PHASE_COLOR: Record<WorkdayPhase, string> = {
  overnight: '#64748b',
  pre_market: '#5b6bb0',
  market_open: '#0550d1',
  core_hours: '#0b57c2',
  lunch: '#9a6a00',
  market_close: '#c2410c',
  evening: '#6d5bc0',
};

/** Resolve a status tone to its hex. */
export function toneColor(tone: StatusTone): string {
  return STATUS_COLORS[tone];
}
