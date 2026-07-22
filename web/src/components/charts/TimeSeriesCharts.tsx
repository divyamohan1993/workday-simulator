import { useId } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { FramePoint } from '@/store/telemetry-store';
import { CHART, LATENCY_COLORS, STATUS_COLORS } from '@/lib/palette';
import { formatClockTime, formatMs, formatRps } from '@/lib/format';
import {
  axisTick,
  baselineStroke,
  ChartFrame,
  ChartTooltip,
  gridStroke,
  LegendKeys,
  localZone,
} from '@/components/charts/chart-kit';

const CHART_HEIGHT = 200;

function last(points: FramePoint[]): FramePoint | undefined {
  return points.length > 0 ? points[points.length - 1] : undefined;
}

function timeLabel(label: string | number): string {
  const ms = Number(label);
  if (!Number.isFinite(ms)) return String(label);
  return formatClockTime(new Date(ms).toISOString(), localZone());
}

const sharedXAxis = {
  dataKey: 'wallMs' as const,
  type: 'number' as const,
  domain: ['dataMin', 'dataMax'] as [string, string],
  scale: 'time' as const,
  tick: axisTick,
  tickLine: false,
  axisLine: { stroke: baselineStroke },
  tickFormatter: timeLabel,
  minTickGap: 48,
};

/* --- Requests per second: current vs target -------------------------------- */

export function RpsChart({ points }: { points: FramePoint[] }): React.JSX.Element {
  const gradientId = useId().replace(/:/g, '');
  const latest = last(points);
  const summary = latest
    ? `Current ${formatRps(latest.rpsCurrent)} requests per second against a target of ${formatRps(latest.rpsTarget)}.`
    : 'Awaiting the first telemetry frame.';

  return (
    <ChartFrame
      title="Throughput (RPS)"
      icon="gauge"
      height={CHART_HEIGHT}
      summary={summary}
      legend={
        <LegendKeys
          items={[
            { label: 'Current', color: CHART.accentCyan },
            { label: 'Target', color: CHART.reference, dashed: true },
          ]}
        />
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART.accentCyan} stopOpacity={0.35} />
              <stop offset="100%" stopColor={CHART.accentCyan} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={gridStroke} vertical={false} />
          <XAxis {...sharedXAxis} />
          <YAxis
            tick={axisTick}
            tickLine={false}
            axisLine={false}
            width={44}
            tickFormatter={(v: number) => formatRps(v)}
          />
          <Tooltip
            cursor={{ stroke: gridStroke }}
            content={<ChartTooltip format={(v) => formatRps(v)} labelFormat={timeLabel} />}
          />
          <Line
            type="monotone"
            dataKey="rpsTarget"
            name="Target"
            stroke={CHART.reference}
            strokeWidth={2}
            strokeDasharray="5 5"
            dot={false}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="rpsCurrent"
            name="Current"
            stroke={CHART.accentCyan}
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/* --- Delivery latency percentiles ------------------------------------------ */

export function LatencyChart({ points }: { points: FramePoint[] }): React.JSX.Element {
  const latest = last(points);
  const summary = latest
    ? `p50 ${formatMs(latest.p50)}, p95 ${formatMs(latest.p95)}, p99 ${formatMs(latest.p99)}.`
    : 'Awaiting the first telemetry frame.';

  return (
    <ChartFrame
      title="Delivery latency"
      icon="activity"
      height={CHART_HEIGHT}
      summary={summary}
      legend={
        <LegendKeys
          items={[
            { label: 'p50', color: LATENCY_COLORS.p50 },
            { label: 'p95', color: LATENCY_COLORS.p95 },
            { label: 'p99', color: LATENCY_COLORS.p99 },
          ]}
        />
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
          <CartesianGrid stroke={gridStroke} vertical={false} />
          <XAxis {...sharedXAxis} />
          <YAxis
            tick={axisTick}
            tickLine={false}
            axisLine={false}
            width={52}
            tickFormatter={(v: number) => formatMs(v)}
          />
          <Tooltip
            cursor={{ stroke: gridStroke }}
            content={<ChartTooltip format={(v) => formatMs(v)} labelFormat={timeLabel} />}
          />
          <Line type="monotone" dataKey="p50" name="p50" stroke={LATENCY_COLORS.p50} strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="p95" name="p95" stroke={LATENCY_COLORS.p95} strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="p99" name="p99" stroke={LATENCY_COLORS.p99} strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/* --- Error rate ------------------------------------------------------------ */

export function ErrorRateChart({
  points,
  thresholdPct = 1,
}: {
  points: FramePoint[];
  thresholdPct?: number;
}): React.JSX.Element {
  const gradientId = useId().replace(/:/g, '');
  const latest = last(points);
  const current = latest?.errorRatePct ?? 0;
  const tone = current >= thresholdPct * 5 ? 'critical' : current >= thresholdPct ? 'warning' : 'good';
  const color = STATUS_COLORS[tone];
  const summary = latest
    ? `Error rate ${current.toFixed(2)} percent; alert threshold ${thresholdPct} percent.`
    : 'Awaiting the first telemetry frame.';

  return (
    <ChartFrame
      title="Delivery error rate"
      icon="alert"
      height={CHART_HEIGHT}
      summary={summary}
      legend={
        <LegendKeys
          items={[
            { label: 'Errors', color },
            { label: `${thresholdPct}% threshold`, color: STATUS_COLORS.warning, dashed: true },
          ]}
        />
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.4} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={gridStroke} vertical={false} />
          <XAxis {...sharedXAxis} />
          <YAxis
            tick={axisTick}
            tickLine={false}
            axisLine={false}
            width={44}
            tickFormatter={(v: number) => `${v.toFixed(0)}%`}
          />
          <Tooltip
            cursor={{ stroke: gridStroke }}
            content={<ChartTooltip format={(v) => `${v.toFixed(2)}%`} labelFormat={timeLabel} />}
          />
          <ReferenceLine y={thresholdPct} stroke={STATUS_COLORS.warning} strokeDasharray="4 4" strokeWidth={1.5} />
          <Area
            type="monotone"
            dataKey="errorRatePct"
            name="Error rate"
            stroke={color}
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
