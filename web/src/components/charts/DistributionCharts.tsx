import { Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ConnectorStat, EventCategory } from '@/types/api';
import { CATEGORY_COLORS, CHART, STATUS_COLORS } from '@/lib/palette';
import { ALL_CATEGORIES, CATEGORY_LABEL, CATEGORY_SHORT } from '@/lib/constants';
import { compactNumber, formatInt, formatPct } from '@/lib/format';
import { axisTick, ChartFrame, ChartTooltip, gridStroke } from '@/components/charts/chart-kit';
import { EmptyState } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';

/* --- Event mix donut ------------------------------------------------------- */

export function EventMixDonut({
  byCategory,
}: {
  byCategory: Record<EventCategory, number>;
}): React.JSX.Element {
  const data = ALL_CATEGORIES.map((cat) => ({
    key: cat,
    name: CATEGORY_SHORT[cat],
    full: CATEGORY_LABEL[cat],
    value: byCategory[cat] ?? 0,
    color: CATEGORY_COLORS[cat],
  }));
  const total = data.reduce((sum, d) => sum + d.value, 0);

  const summary =
    total > 0
      ? `${formatInt(total)} events: ` +
        data
          .filter((d) => d.value > 0)
          .map((d) => `${d.full} ${formatPct(d.value / total, 0)}`)
          .join(', ')
      : 'No events generated yet.';

  const table = {
    columns: ['Category', 'Events', 'Share'],
    rows: data.map((d) => [d.full, formatInt(d.value), total > 0 ? formatPct(d.value / total, 1) : '-']),
  };

  return (
    <ChartFrame title="Event mix" icon="split" height={188} summary={summary} table={table}>
      {total === 0 ? (
        <EmptyState icon="activity" title="No events yet" message="The mix appears once a run is generating events." />
      ) : (
        <div className="flex h-full items-center gap-4">
          <div className="relative h-full w-[46%] min-w-[140px]">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data}
                  dataKey="value"
                  nameKey="full"
                  cx="50%"
                  cy="50%"
                  innerRadius="62%"
                  outerRadius="92%"
                  paddingAngle={2}
                  stroke={CHART.surface}
                  strokeWidth={2}
                  isAnimationActive={false}
                >
                  {data.map((d) => (
                    <Cell key={d.key} fill={d.color} />
                  ))}
                </Pie>
                <Tooltip content={<ChartTooltip format={(v) => formatInt(v)} />} />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-xl font-bold tnum leading-none">{compactNumber(total)}</span>
              <span className="text-[0.6rem] uppercase tracking-widest text-[var(--ink-3)]">events</span>
            </div>
          </div>
          <ul className="flex-1 space-y-1.5">
            {data.map((d) => (
              <li key={d.key} className="flex items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2 text-[var(--ink-2)]">
                  <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: 3, background: d.color, flex: 'none' }} />
                  <span className="clip-text">{d.full}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="tnum text-[var(--ink)]">{compactNumber(d.value)}</span>
                  <span className="tnum w-10 text-right text-xs text-[var(--ink-3)]">
                    {total > 0 ? formatPct(d.value / total, 0) : '-'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ChartFrame>
  );
}

/* --- Provisioning funnel by connector -------------------------------------- */

export function ConnectorFunnel({
  byConnector,
}: {
  byConnector: Record<string, ConnectorStat>;
}): React.JSX.Element {
  const connectors = Object.values(byConnector).sort(
    (a, b) => b.provisioned + b.failed - (a.provisioned + a.failed),
  );

  const summary =
    connectors.length > 0
      ? connectors
          .map((c) => `${c.connector}: ${formatInt(c.provisioned)} provisioned, ${formatInt(c.failed)} failed`)
          .join('; ')
      : 'No connector activity yet.';

  const table = {
    columns: ['Connector', 'Provisioned', 'Failed', 'Avg ms', 'Queue'],
    rows: connectors.map((c) => [
      c.connector,
      formatInt(c.provisioned),
      formatInt(c.failed),
      Math.round(c.avgProvisionMs),
      formatInt(c.queueDepth),
    ]),
  };

  const height = Math.max(160, connectors.length * 34 + 24);

  return (
    <ChartFrame
      title="Provisioning by connector"
      icon="server"
      height={connectors.length > 0 ? height : 160}
      summary={summary}
      legend={
        <div className="flex items-center gap-3 text-[0.7rem] text-[var(--ink-2)]">
          <span className="flex items-center gap-1">
            <Icon name="check" size={12} style={{ color: STATUS_COLORS.good }} /> Provisioned
          </span>
          <span className="flex items-center gap-1">
            <Icon name="x" size={12} style={{ color: STATUS_COLORS.critical }} /> Failed
          </span>
        </div>
      }
      table={table}
    >
      {connectors.length === 0 ? (
        <EmptyState icon="server" title="No connector traffic" message="Connector throughput appears as the receiver provisions." />
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            layout="vertical"
            data={connectors}
            margin={{ top: 4, right: 12, bottom: 4, left: 4 }}
            barCategoryGap={10}
          >
            <XAxis type="number" tick={axisTick} tickLine={false} axisLine={false} tickFormatter={(v: number) => compactNumber(v)} />
            <YAxis
              type="category"
              dataKey="connector"
              tick={axisTick}
              tickLine={false}
              axisLine={false}
              width={92}
            />
            <Tooltip cursor={{ fill: gridStroke }} content={<ChartTooltip format={(v) => formatInt(v)} />} />
            <Bar dataKey="provisioned" name="Provisioned" stackId="a" fill={STATUS_COLORS.good} maxBarSize={20} radius={[3, 0, 0, 3]} isAnimationActive={false} />
            <Bar dataKey="failed" name="Failed" stackId="a" fill={STATUS_COLORS.critical} stroke={CHART.surface} strokeWidth={2} maxBarSize={20} radius={[0, 3, 3, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartFrame>
  );
}
