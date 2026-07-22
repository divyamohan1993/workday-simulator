import { useState } from 'react';
import type { RunState } from '@/types/api';
import { api } from '@/lib/services';
import { ApiError } from '@/lib/api-client';
import { useAsync } from '@/hooks/use-async';
import { RUN_STATUS_TONE } from '@/lib/palette';
import { compactNumber, formatDateTime, formatDuration, formatMs, formatPct, humanizeKind } from '@/lib/format';
import { Badge, Button, EmptyState, ErrorState, LoadingRows, Panel, StatTile } from '@/components/ui/primitives';
import { EventMixDonut } from '@/components/charts/DistributionCharts';
import { DeliveryPanel } from '@/components/dashboard/DeliveryPanel';
import { ReceiverPanel } from '@/components/dashboard/ReceiverPanel';
import { Icon } from '@/components/ui/Icon';
import { cn } from '@/lib/cn';

/** A compact ranked bar list (byKind breakdown). Color is redundant to the label. */
function MiniBarList({ items }: { items: Array<{ label: string; value: number }> }): React.JSX.Element {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="space-y-1.5">
      {items.map((it) => (
        <li key={it.label} className="grid grid-cols-[9rem_1fr_auto] items-center gap-2 text-xs">
          <span className="clip-text text-[var(--ink-2)]" title={it.label}>{it.label}</span>
          <span className="h-2 rounded-full bg-[var(--surface-3)]">
            <span className="block h-full rounded-full" style={{ width: `${(it.value / max) * 100}%`, background: 'var(--accent)' }} />
          </span>
          <span className="tnum text-[var(--ink-3)]">{compactNumber(it.value)}</span>
        </li>
      ))}
    </ul>
  );
}

function RunSummaryDetail({ run }: { run: RunState }): React.JSX.Element {
  const { data: summary, error, initialLoading, refetch } = useAsync(
    (signal) => api.getRunSummary(run.id, signal),
    [run.id],
  );

  if (initialLoading) return <Panel title="Run summary" icon="history"><LoadingRows rows={4} /></Panel>;

  // A run that has not finished has no summary yet (409).
  if (error) {
    const notFinished = error instanceof ApiError && error.status === 409;
    return (
      <Panel title="Run summary" icon="history">
        {notFinished ? (
          <EmptyState icon="activity" title="Run in progress" message="A summary is available once the run completes. Watch it live in Live Ops." />
        ) : (
          <ErrorState error={error} onRetry={refetch} />
        )}
      </Panel>
    );
  }
  if (!summary) return <Panel title="Run summary" icon="history"><EmptyState icon="history" title="No summary" /></Panel>;

  const byKind = Object.entries(summary.byKind)
    .map(([kind, value]) => ({ label: humanizeKind(kind), value: value ?? 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 12);

  return (
    <div className="space-y-4">
      <Panel title="Run summary" icon="history" accent
        actions={<Badge tone={RUN_STATUS_TONE[summary.status]}>{humanizeKind(summary.status)}</Badge>}
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Duration" value={formatDuration(summary.durationSec)} icon="clock" />
          <StatTile label="Generated" value={compactNumber(summary.totals.generated)} icon="zap" />
          <StatTile label="Delivered" value={compactNumber(summary.totals.delivered)} icon="check" tone="good" />
          <StatTile label="Error rate" value={formatPct(summary.errorRate)} icon="alert" tone={summary.errorRate >= 0.05 ? 'critical' : summary.errorRate >= 0.01 ? 'warning' : 'good'} />
        </div>
        <div className="mt-3 grid grid-cols-3 gap-3">
          <StatTile label="Latency p50" value={formatMs(summary.latency.p50)} />
          <StatTile label="Latency p95" value={formatMs(summary.latency.p95)} />
          <StatTile label="Latency p99" value={formatMs(summary.latency.p99)} tone={summary.latency.p99 > 1000 ? 'warning' : 'neutral'} />
        </div>
        <p className="mono mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--ink-3)]">
          <span>seed: <span className="text-[var(--ink-2)]">{summary.seed}</span></span>
          <span>started: {formatDateTime(summary.startedAt)}</span>
          <span>ended: {formatDateTime(summary.endedAt)}</span>
        </p>
        {summary.chaosFired.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {summary.chaosFired.map((c) => (
              <Badge key={c.kind} tone="serious" icon="zap">{humanizeKind(c.kind)} · {compactNumber(c.eventsInjected)}</Badge>
            ))}
          </div>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Event mix" icon="split"><EventMixDonut byCategory={summary.totals.byCategory} /></Panel>
        <Panel title="Top event kinds" icon="activity">
          {byKind.length > 0 ? <MiniBarList items={byKind} /> : <EmptyState icon="activity" title="No events" />}
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <ReceiverPanel receiver={summary.receiver} />
        <DeliveryPanel delivery={summary.delivery} />
      </div>
    </div>
  );
}

/**
 * Past runs and their summaries. The list is the master; selecting a run loads
 * its full summary (or reports it is still in progress).
 */
export default function RunHistory(): React.JSX.Element {
  const { data, error, initialLoading, refetch } = useAsync(
    (signal) => api.listRuns({ limit: 100 }, signal),
    [],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const runs = data?.items ?? [];
  const selected = runs.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Run history</h1>
          <p className="text-sm text-[var(--ink-3)]">Past and active runs with their end-of-run summaries.</p>
        </div>
        <Button variant="ghost" size="sm" iconLeft="refresh" onClick={refetch}>Refresh</Button>
      </div>

      {initialLoading ? (
        <Panel><LoadingRows rows={5} /></Panel>
      ) : error ? (
        <Panel><ErrorState error={error} onRetry={refetch} /></Panel>
      ) : runs.length === 0 ? (
        <Panel><EmptyState icon="history" title="No runs yet" message="Start a run from the Scenario Builder; it will appear here with a full summary when it finishes." /></Panel>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_1fr]">
          <Panel title={`Runs (${data?.total ?? runs.length})`} icon="history" bodyClassName="!p-0">
            <ul className="max-h-[70vh] divide-y divide-[var(--border-faint)] overflow-y-auto">
              {runs.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(r.id)}
                    aria-current={selectedId === r.id ? 'true' : undefined}
                    className={cn(
                      'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)]',
                      selectedId === r.id && 'bg-[var(--surface-2)]',
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="mono clip-text block text-xs text-[var(--ink-2)]">{r.id}</span>
                      <span className="mt-0.5 block text-xs text-[var(--ink-3)]">
                        {r.startedAt ? formatDateTime(r.startedAt) : 'not started'} · {compactNumber(r.counters.generated)} events
                      </span>
                    </span>
                    <Badge tone={RUN_STATUS_TONE[r.status]}>{humanizeKind(r.status)}</Badge>
                    <Icon name="chevronRight" size={14} className="text-[var(--ink-3)]" />
                  </button>
                </li>
              ))}
            </ul>
          </Panel>

          <div>
            {selected ? (
              <RunSummaryDetail run={selected} />
            ) : (
              <Panel><EmptyState icon="history" title="Select a run" message="Pick a run on the left to see its summary and charts." /></Panel>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
