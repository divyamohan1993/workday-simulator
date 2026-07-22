import type { ReceiverStats } from '@/types/api';
import { compactNumber, formatInt, formatMs, relativeTime } from '@/lib/format';
import { Panel, StatTile } from '@/components/ui/primitives';
import { ConnectorFunnel } from '@/components/charts/DistributionCharts';

/**
 * The reference OneIM receiver's view: provisioning throughput, per-connector
 * funnel, and the access-governance findings (SoD conflicts, orphan and dormant
 * accounts) that an Identity Manager surfaces under load.
 */
export function ReceiverPanel({ receiver }: { receiver: ReceiverStats }): React.JSX.Element {
  return (
    <Panel title="Reference OneIM receiver" icon="server" accent>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Queue depth" value={compactNumber(receiver.queueDepth)} icon="database" tone={receiver.queueDepth > 5000 ? 'warning' : 'neutral'} />
        <StatTile label="Provisioned" value={compactNumber(receiver.provisioned)} icon="check" tone="good" />
        <StatTile label="Failed" value={compactNumber(receiver.failed)} icon="x" tone={receiver.failed > 0 ? 'serious' : 'neutral'} />
        <StatTile label="Avg provision" value={formatMs(receiver.avgProvisionMs)} icon="clock" />
      </div>

      <div className="mt-3 grid grid-cols-3 gap-3">
        <StatTile label="SoD violations" value={formatInt(receiver.sodViolations)} icon="split" tone={receiver.sodViolations > 0 ? 'critical' : 'good'} hint={receiver.sodViolations > 0 ? 'toxic combinations' : 'clear'} />
        <StatTile label="Orphan accounts" value={formatInt(receiver.orphans)} icon="ghost" tone={receiver.orphans > 0 ? 'warning' : 'good'} hint={receiver.orphans > 0 ? 'no owner' : 'clear'} />
        <StatTile label="Dormant accounts" value={formatInt(receiver.dormant)} icon="moon" tone={receiver.dormant > 0 ? 'warning' : 'good'} hint={receiver.dormant > 0 ? 'inactive' : 'clear'} />
      </div>

      <div className="mt-4">
        <ConnectorFunnel byConnector={receiver.byConnector} />
      </div>

      <p className="mt-3 flex items-center justify-between text-xs text-[var(--ink-3)]">
        <span>Total ingested: <span className="tnum text-[var(--ink-2)]">{formatInt(receiver.totalIngested)}</span></span>
        <span>Last ingest: {receiver.lastIngestAt ? relativeTime(receiver.lastIngestAt) : '—'}</span>
      </p>
    </Panel>
  );
}
