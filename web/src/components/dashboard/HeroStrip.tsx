import type { RunState, TelemetryFrame } from '@/types/api';
import { CIRCUIT_TONE, RUN_STATUS_TONE } from '@/lib/palette';
import { compactNumber, formatPct, formatRps, humanizeKind } from '@/lib/format';
import { Badge, MeterBar, StatTile } from '@/components/ui/primitives';

/**
 * The dashboard's headline: the single number that matters (current throughput)
 * plus the run's cumulative counters. Exactly one hero figure per view.
 */
export function HeroStrip({
  frame,
  run,
}: {
  frame: TelemetryFrame;
  run: RunState | null;
}): React.JSX.Element {
  const meterMax = Math.max(frame.targetRps, frame.currentRps, 1);
  const errorTone = frame.errorRate >= 0.05 ? 'critical' : frame.errorRate >= 0.01 ? 'warning' : 'good';
  const generated = run?.counters.generated ?? 0;

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,2fr)]">
      <section className="panel panel-accent above p-5" aria-label="Current throughput">
        <div className="flex items-start justify-between">
          <div>
            <p className="stat-label">Current throughput</p>
            <p className="mt-1 flex items-baseline gap-2">
              <span className="text-5xl font-bold leading-none tracking-tight tnum">
                {formatRps(frame.currentRps)}
              </span>
              <span className="text-sm text-[var(--ink-3)]">events / sec</span>
            </p>
          </div>
          {run && (
            <Badge tone={RUN_STATUS_TONE[run.status]}>{humanizeKind(run.status)}</Badge>
          )}
        </div>
        <div className="mt-4">
          <MeterBar
            value={frame.currentRps}
            max={meterMax}
            tone={frame.currentRps > frame.targetRps * 1.02 ? 'warning' : 'good'}
            label="vs target"
            valueLabel={`${formatRps(frame.currentRps)} / ${formatRps(frame.targetRps)} rps`}
          />
        </div>
      </section>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile label="Generated" value={compactNumber(generated)} icon="zap" hint="events this run" />
        <StatTile label="Delivered" value={compactNumber(frame.delivery.deliveredTotal)} icon="check" tone="good" />
        <StatTile label="Failed" value={compactNumber(frame.delivery.failedTotal)} icon="x" tone={frame.delivery.failedTotal > 0 ? 'serious' : 'neutral'} />
        <StatTile label="Dropped" value={compactNumber(frame.delivery.droppedTotal)} icon="alert" tone={frame.delivery.droppedTotal > 0 ? 'warning' : 'neutral'} />
        <StatTile label="Error rate" value={formatPct(frame.errorRate)} icon="activity" tone={errorTone} />
        <StatTile
          label="Circuit"
          value={humanizeKind(frame.delivery.circuit)}
          icon="plug"
          tone={CIRCUIT_TONE[frame.delivery.circuit]}
        />
      </div>
    </div>
  );
}
