import { useState } from 'react';
import type { DeliveryTarget, ScenarioConfig } from '@/types/api';
import type { ChaosInjectorDef, ScenarioInput } from '@/lib/api-types';
import { DELIVERY_KIND_LABEL } from '@/lib/constants';
import { NumberField, SelectField, SliderField, TextArea, TextField } from '@/components/ui/fields';
import { EventMixEditor } from '@/components/scenario/EventMixEditor';
import { TimezoneEditor } from '@/components/scenario/TimezoneEditor';
import { ChaosEditor } from '@/components/scenario/ChaosEditor';
import { Icon } from '@/components/ui/Icon';

const DEFAULT_MIX = { AUTH: 1, JML: 0.2, ACCESS: 0.6, TXN: 1, COMPLIANCE: 0.15 };
const DEFAULT_TZ = { FFT: 1, LDN: 0.9, NYC: 0.9, SIN: 0.5, HKG: 0.5, BLR: 0.7, PNQ: 0.5, JAX: 0.4 };

function defaultInput(targetId: string): ScenarioInput {
  return {
    name: '',
    description: '',
    baselineRps: 50,
    maxRps: 500,
    workdayAccel: 60,
    timezoneWeights: { byLocation: { ...DEFAULT_TZ } },
    eventMix: { byCategory: { ...DEFAULT_MIX } },
    chaos: [],
    targetId,
  };
}

function fromScenario(s: ScenarioConfig): ScenarioInput {
  return {
    name: s.name,
    description: s.description,
    baselineRps: s.baselineRps,
    maxRps: s.maxRps,
    workdayAccel: s.workdayAccel,
    startSimTime: s.startSimTime,
    timezoneWeights: { byLocation: { ...s.timezoneWeights.byLocation } },
    eventMix: { byCategory: { ...s.eventMix.byCategory }, byKind: s.eventMix.byKind },
    chaos: s.chaos.map((c) => ({ ...c, params: { ...c.params } })),
    targetId: s.targetId,
    durationSec: s.durationSec,
    seed: s.seed,
  };
}

function isoToLocalInput(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function Section({ title, defaultOpen, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <details open={defaultOpen} className="rounded-lg border border-[var(--border-faint)] bg-[var(--surface-1)] p-3">
      <summary className="flex cursor-pointer select-none items-center gap-2 text-sm font-medium text-[var(--ink-2)]">
        <Icon name="chevronRight" size={14} /> {title}
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

export function ScenarioForm({
  formId,
  initial,
  targets,
  chaosDefs,
  maxRpsCeiling,
  onSubmit,
}: {
  formId: string;
  initial: ScenarioConfig | null;
  targets: DeliveryTarget[];
  chaosDefs: ChaosInjectorDef[];
  maxRpsCeiling: number;
  onSubmit: (input: ScenarioInput) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<ScenarioInput>(() =>
    initial ? fromScenario(initial) : defaultInput(targets[0]?.id ?? ''),
  );
  const [errors, setErrors] = useState<{ name?: string; targetId?: string }>({});

  function set<K extends keyof ScenarioInput>(key: K, val: ScenarioInput[K]) {
    setDraft((d) => ({ ...d, [key]: val }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const next: { name?: string; targetId?: string } = {};
    if (!draft.name.trim()) next.name = 'A scenario name is required.';
    if (!draft.targetId) next.targetId = 'Select a delivery target.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    onSubmit({
      ...draft,
      name: draft.name.trim(),
      description: draft.description?.trim() ?? '',
      seed: draft.seed?.trim() || undefined,
      startSimTime: draft.startSimTime || undefined,
    });
  }

  return (
    <form id={formId} onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Name" required value={draft.name} onChange={(v) => set('name', v)} error={errors.name} placeholder="Frankfurt open + audit surge" />
        <SelectField
          label="Delivery target"
          required
          value={draft.targetId}
          onChange={(v) => set('targetId', v)}
          options={
            targets.length > 0
              ? targets.map((t) => ({ value: t.id, label: `${t.name} · ${DELIVERY_KIND_LABEL[t.kind]}` }))
              : [{ value: '', label: 'No targets available' }]
          }
          error={errors.targetId}
          hint={targets.length === 0 ? 'Create a delivery target first.' : undefined}
        />
      </div>

      <TextArea label="Description" value={draft.description ?? ''} onChange={(v) => set('description', v)} rows={2} placeholder="What does this run exercise?" />

      <div className="grid gap-3 sm:grid-cols-3">
        <NumberField label="Baseline RPS" required value={draft.baselineRps} onChange={(v) => set('baselineRps', v ?? 0)} min={0} suffix="rps" hint="Before diurnal shaping" />
        <NumberField label="Max RPS" required value={draft.maxRps} onChange={(v) => set('maxRps', v ?? 1)} min={1} max={maxRpsCeiling} suffix="rps" hint={`Server ceiling ${maxRpsCeiling}`} />
        <NumberField label="Duration" value={draft.durationSec} onChange={(v) => set('durationSec', v)} min={1} suffix="sec" hint="Blank = until stopped" />
      </div>

      <SliderField label="Workday acceleration" value={draft.workdayAccel ?? 60} min={1} max={600} step={1} onChange={(v) => set('workdayAccel', v)} format={(v) => `${v}× real time`} hint="Simulated seconds per real second" />

      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Seed (optional)" mono value={draft.seed ?? ''} onChange={(v) => set('seed', v)} placeholder="falls back to global SEED" hint="Deterministic replay" />
        <div>
          <label className="field-label" htmlFor={`${formId}-simtime`}>Start sim time (optional)</label>
          <input
            id={`${formId}-simtime`}
            className="input"
            type="datetime-local"
            value={isoToLocalInput(draft.startSimTime)}
            onChange={(e) => set('startSimTime', e.target.value ? new Date(e.target.value).toISOString() : undefined)}
          />
          <p className="mt-1 text-xs text-[var(--ink-3)]">Blank = start &ldquo;now&rdquo;</p>
        </div>
      </div>

      <Section title="Event mix weights" defaultOpen>
        <EventMixEditor value={draft.eventMix ?? { byCategory: { ...DEFAULT_MIX } }} onChange={(v) => set('eventMix', v)} />
      </Section>

      <Section title="Timezone activity weights">
        <TimezoneEditor value={draft.timezoneWeights ?? { byLocation: { ...DEFAULT_TZ } }} onChange={(v) => set('timezoneWeights', v)} />
      </Section>

      <Section title={`Chaos injectors${draft.chaos && draft.chaos.length > 0 ? ` (${draft.chaos.length} active)` : ''}`}>
        <ChaosEditor defs={chaosDefs} value={draft.chaos ?? []} onChange={(v) => set('chaos', v)} />
      </Section>
    </form>
  );
}
