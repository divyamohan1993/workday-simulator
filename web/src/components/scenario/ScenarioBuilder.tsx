import { useState } from 'react';
import type { ScenarioConfig } from '@/types/api';
import type { ScenarioInput } from '@/lib/api-types';
import { api } from '@/lib/services';
import { ApiError } from '@/lib/api-client';
import { useAsync } from '@/hooks/use-async';
import { useAuthStore } from '@/store/auth-store';
import { useTelemetryStore } from '@/store/telemetry-store';
import { useUiStore } from '@/store/ui-store';
import { DELIVERY_KIND_LABEL } from '@/lib/constants';
import { compactNumber, formatRps } from '@/lib/format';
import { Badge, Button, EmptyState, ErrorState, LoadingRows, Panel } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { ScenarioForm } from '@/components/scenario/ScenarioForm';
import { RunControls } from '@/components/scenario/RunControls';

const ACTIVE_STATES = new Set(['starting', 'running', 'paused', 'stopping']);

/**
 * Compose, save, and launch simulation scenarios. The heavy composition (event
 * mix, timezone weights, chaos) lives in the scenario form dialog; this view is
 * the launcher: the live run controls, the saved-scenario list, and start/stop.
 */
export default function ScenarioBuilder(): React.JSX.Element {
  const pushToast = useUiStore((s) => s.pushToast);
  const setView = useUiStore((s) => s.setView);
  const maxRpsCeiling = useAuthStore((s) => s.config?.maxRps ?? 2000);
  const run = useTelemetryStore((s) => s.run);
  const runActive = run !== null && ACTIVE_STATES.has(run.status);

  const scenariosQ = useAsync((signal) => api.listScenarios({ limit: 200 }, signal), []);
  const targetsQ = useAsync((signal) => api.listTargets({ limit: 200 }, signal), []);
  const chaosQ = useAsync((signal) => api.listChaosInjectors(signal), []);

  const scenarios = scenariosQ.data?.items ?? [];
  const targets = targetsQ.data?.items ?? [];
  const chaosDefs = chaosQ.data ?? [];

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ScenarioConfig | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [toDelete, setToDelete] = useState<ScenarioConfig | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);

  function targetName(id: string): string {
    const t = targets.find((x) => x.id === id);
    return t ? `${t.name} · ${DELIVERY_KIND_LABEL[t.kind]}` : 'Unknown target';
  }

  async function handleSubmit(input: ScenarioInput) {
    setSubmitting(true);
    try {
      if (editing) {
        await api.updateScenario(editing.id, input);
        pushToast({ tone: 'good', title: 'Scenario updated', message: input.name });
      } else {
        await api.createScenario(input);
        pushToast({ tone: 'good', title: 'Scenario created', message: input.name });
      }
      setDialogOpen(false);
      scenariosQ.refetch();
    } catch (err) {
      pushToast({ tone: 'critical', title: 'Could not save scenario', message: err instanceof ApiError ? err.message : 'Unexpected error' });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await api.deleteScenario(toDelete.id);
      pushToast({ tone: 'good', title: 'Scenario deleted', message: toDelete.name });
      setToDelete(null);
      scenariosQ.refetch();
    } catch (err) {
      pushToast({ tone: 'critical', title: 'Could not delete', message: err instanceof ApiError ? err.message : 'Unexpected error' });
    } finally {
      setDeleting(false);
    }
  }

  async function startRun(scenario: ScenarioConfig) {
    setStarting(scenario.id);
    try {
      await api.startRun({ scenarioId: scenario.id, targetId: scenario.targetId });
      pushToast({ tone: 'good', title: 'Run started', message: scenario.name });
      setView('dashboard');
    } catch (err) {
      const msg =
        err instanceof ApiError && err.status === 409
          ? 'A run is already active. Stop it before starting another.'
          : err instanceof ApiError
            ? err.message
            : 'Unexpected error';
      pushToast({ tone: 'critical', title: 'Could not start run', message: msg });
    } finally {
      setStarting(null);
    }
  }

  const loading = scenariosQ.initialLoading || targetsQ.initialLoading || chaosQ.initialLoading;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Scenario builder</h1>
          <p className="text-sm text-[var(--ink-3)]">
            Compose baseline load, workday acceleration, timezone and event-mix weights, and chaos injectors, then launch a run.
          </p>
        </div>
        <Button variant="primary" iconLeft="plus" onClick={() => { setEditing(null); setDialogOpen(true); }}>
          New scenario
        </Button>
      </div>

      <RunControls chaosDefs={chaosDefs} />

      {targetsQ.data && targets.length === 0 && (
        <Panel>
          <EmptyState
            icon="target"
            title="No delivery targets"
            message="A scenario needs a delivery target. Create one first, then compose a scenario."
            action={<Button variant="primary" iconRight="arrowRight" onClick={() => setView('targets')}>Go to Targets</Button>}
          />
        </Panel>
      )}

      {loading ? (
        <Panel><LoadingRows rows={3} /></Panel>
      ) : scenariosQ.error ? (
        <Panel><ErrorState error={scenariosQ.error} onRetry={scenariosQ.refetch} /></Panel>
      ) : scenarios.length === 0 ? (
        <Panel>
          <EmptyState icon="sliders" title="No scenarios yet" message="Compose your first scenario to model a Deutsche Bank workday." action={<Button variant="primary" iconLeft="plus" onClick={() => { setEditing(null); setDialogOpen(true); }}>New scenario</Button>} />
        </Panel>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {scenarios.map((s) => (
            <Panel key={s.id} className="flex flex-col">
              <div className="p-4 pb-2">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold clip-text">{s.name}</p>
                  {s.chaos.length > 0 && <Badge tone="serious" icon="zap">{s.chaos.length} chaos</Badge>}
                </div>
                {s.description && <p className="mt-1 line-clamp-2 text-xs text-[var(--ink-3)]">{s.description}</p>}
              </div>
              <div className="grid grid-cols-3 gap-2 px-4 py-2 text-xs">
                <span className="text-[var(--ink-3)]">Baseline<br /><span className="tnum text-[var(--ink-2)]">{formatRps(s.baselineRps)} rps</span></span>
                <span className="text-[var(--ink-3)]">Max<br /><span className="tnum text-[var(--ink-2)]">{compactNumber(s.maxRps)} rps</span></span>
                <span className="text-[var(--ink-3)]">Accel<br /><span className="tnum text-[var(--ink-2)]">{s.workdayAccel}×</span></span>
              </div>
              <p className="flex items-center gap-1.5 px-4 pb-3 text-xs text-[var(--ink-3)]">
                <Icon name="target" size={12} /> <span className="clip-text">{targetName(s.targetId)}</span>
              </p>
              <div className="mt-auto flex items-center gap-1 border-t border-[var(--border-faint)] p-2">
                <Button size="sm" variant="primary" iconLeft="play" loading={starting === s.id} disabled={runActive} onClick={() => startRun(s)} title={runActive ? 'Stop the active run first' : 'Start a run'}>
                  Start
                </Button>
                <Button size="sm" variant="ghost" iconLeft="edit" onClick={() => { setEditing(s); setDialogOpen(true); }}>Edit</Button>
                <button className="btn btn-sm btn-ghost ml-auto" aria-label={`Delete ${s.name}`} onClick={() => setToDelete(s)}>
                  <Icon name="trash" size={15} />
                </button>
              </div>
            </Panel>
          ))}
        </div>
      )}

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title={editing ? 'Edit scenario' : 'New scenario'}
        description={editing ? editing.name : 'Model a Deutsche Bank workday'}
        size="xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button variant="primary" type="submit" form="scenario-form" loading={submitting} iconLeft="check" disabled={targets.length === 0}>
              {editing ? 'Save changes' : 'Create scenario'}
            </Button>
          </>
        }
      >
        <ScenarioForm formId="scenario-form" initial={editing} targets={targets} chaosDefs={chaosDefs} maxRpsCeiling={maxRpsCeiling} onSubmit={handleSubmit} />
      </Dialog>

      <Dialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        title="Delete scenario?"
        description={toDelete?.name}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setToDelete(null)}>Cancel</Button>
            <Button variant="danger" loading={deleting} iconLeft="trash" onClick={handleDelete}>Delete</Button>
          </>
        }
      >
        <p className="text-sm text-[var(--ink-2)]">This soft-deletes the scenario. Past runs that used it remain in history.</p>
      </Dialog>
    </div>
  );
}
