import { useState } from 'react';
import type { ChaosInjectorConfig } from '@/types/api';
import type { ChaosInjectorDef } from '@/lib/api-types';
import { api } from '@/lib/services';
import { ApiError } from '@/lib/api-client';
import { useTelemetryStore } from '@/store/telemetry-store';
import { useUiStore } from '@/store/ui-store';
import { RUN_STATUS_TONE } from '@/lib/palette';
import { compactNumber, formatDuration, formatRps, humanizeKind } from '@/lib/format';
import { Badge, Button, Panel, StatTile, StatusDot } from '@/components/ui/primitives';
import { SelectField, SliderField } from '@/components/ui/fields';

const ACTIVE_STATES = new Set(['starting', 'running', 'paused', 'stopping']);

/**
 * Live controls for the one active run: pause/resume/stop and on-the-fly chaos
 * injection. Run state is read from the telemetry store (fed by the WebSocket),
 * so the controls reflect transitions the moment the server reports them.
 */
export function RunControls({ chaosDefs }: { chaosDefs: ChaosInjectorDef[] }): React.JSX.Element | null {
  const run = useTelemetryStore((s) => s.run);
  const pushToast = useUiStore((s) => s.pushToast);
  const setView = useUiStore((s) => s.setView);
  const [busy, setBusy] = useState<string | null>(null);
  const [chaosKind, setChaosKind] = useState<string>(chaosDefs[0]?.kind ?? '');
  const [intensity, setIntensity] = useState(0.5);

  if (!run || !ACTIVE_STATES.has(run.status)) return null;

  async function act(kind: string, fn: () => Promise<unknown>, okTitle: string) {
    setBusy(kind);
    try {
      await fn();
      pushToast({ tone: 'good', title: okTitle });
    } catch (err) {
      pushToast({ tone: 'critical', title: 'Action failed', message: err instanceof ApiError ? err.message : 'Unexpected error' });
    } finally {
      setBusy(null);
    }
  }

  const activeRun = run;

  async function injectChaos() {
    const def = chaosDefs.find((d) => d.kind === chaosKind);
    if (!def) return;
    const params: Record<string, number | string | boolean> = {};
    for (const p of def.params) params[p.name] = p.default;
    const config: ChaosInjectorConfig = { kind: def.kind, enabled: true, intensity, params };
    await act('chaos', () => api.injectChaos(activeRun.id, config), `Injected ${humanizeKind(def.kind)}`);
  }

  return (
    <Panel accent title="Active run" icon="activity"
      actions={
        <Badge tone={RUN_STATUS_TONE[run.status]}>
          <StatusDot tone={RUN_STATUS_TONE[run.status]} pulse={run.status === 'running'} />
          {humanizeKind(run.status)}
        </Badge>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Elapsed" value={formatDuration(run.elapsedSec)} icon="clock" />
        <StatTile label="Throughput" value={`${formatRps(run.currentRps)}`} hint={`target ${formatRps(run.targetRps)} rps`} icon="gauge" />
        <StatTile label="Generated" value={compactNumber(run.counters.generated)} icon="zap" />
        <StatTile label="Delivered" value={compactNumber(run.counters.delivered)} icon="check" tone="good" />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {run.status === 'running' && (
          <Button iconLeft="pause" loading={busy === 'pause'} onClick={() => act('pause', () => api.pauseRun(activeRun.id), 'Run paused')}>Pause</Button>
        )}
        {run.status === 'paused' && (
          <Button iconLeft="play" variant="primary" loading={busy === 'resume'} onClick={() => act('resume', () => api.resumeRun(activeRun.id), 'Run resumed')}>Resume</Button>
        )}
        <Button
          variant="danger"
          iconLeft="stop"
          loading={busy === 'stop'}
          onClick={() =>
            act('stop', () => api.stopRun(activeRun.id), 'Run stopped').then(() => setView('history'))
          }
        >
          Stop run
        </Button>
        <Button variant="ghost" iconRight="arrowRight" onClick={() => setView('dashboard')}>View live ops</Button>
      </div>

      {chaosDefs.length > 0 && (
        <div className="mt-4 rounded-lg border border-[var(--border-faint)] bg-[var(--surface-1)] p-3">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-medium">
            <span className="text-[var(--status-serious)]">⚡</span> Inject chaos now
          </p>
          <div className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <SelectField
              label="Injector"
              value={chaosKind}
              onChange={setChaosKind}
              options={chaosDefs.map((d) => ({ value: d.kind, label: humanizeKind(d.kind) }))}
            />
            <SliderField label="Intensity" value={intensity} min={0} max={1} step={0.05} onChange={setIntensity} format={(v) => `${Math.round(v * 100)}%`} />
            <Button iconLeft="zap" loading={busy === 'chaos'} onClick={injectChaos}>Inject</Button>
          </div>
        </div>
      )}
    </Panel>
  );
}
