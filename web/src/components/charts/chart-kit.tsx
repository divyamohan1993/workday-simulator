import type { ReactNode } from 'react';
import { CHART } from '@/lib/palette';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/ui/Icon';

/**
 * Shared chart chrome. Two things every chart here needs:
 *
 * 1. An explicit pixel height on the plot wrapper. recharts' ResponsiveContainer
 *    measures its parent, and inside a CSS grid/flex cell with no resolved height
 *    it measures 0 and renders nothing. Every chart passes a fixed `height`.
 * 2. A non-visual data path. The plot div is role="img" with a text summary, and
 *    an optional <details> discloses the exact numbers as a table, so the chart
 *    is never color- or vision-only.
 */

export interface ChartTableSpec {
  columns: string[];
  rows: Array<Array<string | number>>;
}

export interface ChartFrameProps {
  title: string;
  icon?: IconName;
  /** Plot height in px (required: see note above). */
  height: number;
  /** Concise text description used as the plot's accessible name. */
  summary: string;
  legend?: ReactNode;
  actions?: ReactNode;
  table?: ChartTableSpec;
  className?: string;
  children: ReactNode;
}

export function ChartFrame({
  title,
  icon,
  height,
  summary,
  legend,
  actions,
  table,
  className,
  children,
}: ChartFrameProps): React.JSX.Element {
  return (
    <figure className={cn('m-0', className)}>
      <figcaption className="mb-2 flex items-center justify-between gap-2">
        <span className="panel-title !text-[0.7rem]">
          {icon && <Icon name={icon} size={14} />}
          {title}
        </span>
        <div className="flex items-center gap-3">
          {legend}
          {actions}
        </div>
      </figcaption>
      <div role="img" aria-label={`${title}. ${summary}`} style={{ height }} className="w-full">
        {children}
      </div>
      {table && (
        <details className="mt-2 text-xs text-[var(--ink-3)]">
          <summary className="cursor-pointer select-none hover:text-[var(--ink-2)]">
            Data table
          </summary>
          <div className="mt-2 max-h-52 overflow-auto rounded-lg border border-[var(--border-faint)]">
            <table className="w-full border-collapse text-left tnum">
              <thead>
                <tr>
                  {table.columns.map((c) => (
                    <th
                      key={c}
                      className="sticky top-0 bg-[var(--surface-2)] px-2 py-1 font-semibold text-[var(--ink-2)]"
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, ri) => (
                  <tr key={ri} className="border-t border-[var(--border-faint)]">
                    {row.map((cell, ci) => (
                      <td key={ci} className="px-2 py-1 text-[var(--ink-2)]">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </figure>
  );
}

/* --- Legend key ------------------------------------------------------------ */

export interface LegendItem {
  label: string;
  color: string;
  /** Optional dashed swatch for reference series. */
  dashed?: boolean;
}

export function LegendKeys({ items }: { items: LegendItem[] }): React.JSX.Element {
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5 text-[0.7rem] text-[var(--ink-2)]">
          <span
            aria-hidden="true"
            style={{
              width: 14,
              height: it.dashed ? 0 : 8,
              borderTop: it.dashed ? `2px dashed ${it.color}` : undefined,
              background: it.dashed ? undefined : it.color,
              borderRadius: it.dashed ? 0 : 999,
              display: 'inline-block',
            }}
          />
          {it.label}
        </li>
      ))}
    </ul>
  );
}

/* --- Custom tooltip -------------------------------------------------------- */

export interface ChartTooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: Array<{
    name?: string;
    value?: number | string;
    color?: string;
    dataKey?: string | number;
  }>;
  /** Formats a numeric value for display. */
  format?: (v: number) => string;
  /** Formats the axis label (e.g. epoch ms -> clock time). */
  labelFormat?: (label: string | number) => string;
}

/** Passed to recharts `<Tooltip content={<ChartTooltip .../>} />` as an element. */
export function ChartTooltip({
  active,
  label,
  payload,
  format,
  labelFormat,
}: ChartTooltipProps): React.JSX.Element | null {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div
      className="rounded-lg border px-3 py-2 text-xs shadow-lg"
      style={{ background: CHART.tooltipBg, borderColor: 'var(--border-strong)' }}
    >
      {label !== undefined && (
        <p className="mb-1 font-semibold text-[var(--ink-2)]">
          {labelFormat ? labelFormat(label) : label}
        </p>
      )}
      <ul className="space-y-0.5">
        {payload.map((item, i) => {
          const num = typeof item.value === 'number' ? item.value : Number(item.value);
          const shown = Number.isFinite(num) && format ? format(num) : String(item.value ?? '-');
          return (
            <li key={i} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-[var(--ink-3)]">
                <span
                  aria-hidden="true"
                  style={{ width: 8, height: 8, borderRadius: 999, background: item.color }}
                />
                {item.name}
              </span>
              <span className="tnum font-semibold text-[var(--ink)]">{shown}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Common axis + grid styling for recharts, matching the dataviz chrome tokens. */
export const axisTick = { fill: CHART.axis, fontSize: 11 } as const;
export const gridStroke = CHART.grid;
export const baselineStroke = CHART.baseline;

/** Local IANA zone for rendering live time ticks. */
export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}
