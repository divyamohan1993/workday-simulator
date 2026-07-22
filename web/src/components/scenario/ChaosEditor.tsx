import type { ChaosInjectorConfig, ChaosInjectorKind } from '@/types/api';
import type { ChaosInjectorDef, ChaosParamDef } from '@/lib/api-types';
import { humanizeKind } from '@/lib/format';
import { NumberField, TextField, ToggleField } from '@/components/ui/fields';
import { SliderField } from '@/components/ui/fields';
import { Icon } from '@/components/ui/Icon';

/**
 * Toggle and tune chaos injectors. Each injector's tunable parameters are
 * discovered from the backend (GET /api/chaos/injectors), so the UI never
 * hard-codes the knob list; adding a param server-side surfaces it here
 * automatically. A config exists in the array only while the injector is
 * enabled.
 */

function defaultConfig(def: ChaosInjectorDef): ChaosInjectorConfig {
  const params: Record<string, number | string | boolean> = {};
  for (const p of def.params) params[p.name] = p.default;
  return { kind: def.kind, enabled: true, intensity: 0.5, params };
}

function ParamControl({
  def,
  value,
  onChange,
}: {
  def: ChaosParamDef;
  value: number | string | boolean | undefined;
  onChange: (v: number | string | boolean) => void;
}): React.JSX.Element {
  if (def.type === 'boolean') {
    return <ToggleField label={humanizeKind(def.name)} checked={Boolean(value)} onChange={onChange} />;
  }
  if (def.type === 'number') {
    return (
      <NumberField
        label={humanizeKind(def.name)}
        value={typeof value === 'number' ? value : Number(value ?? 0)}
        onChange={(v) => onChange(v ?? 0)}
      />
    );
  }
  return <TextField label={humanizeKind(def.name)} value={String(value ?? '')} onChange={onChange} />;
}

export function ChaosEditor({
  defs,
  value,
  onChange,
}: {
  defs: ChaosInjectorDef[];
  value: ChaosInjectorConfig[];
  onChange: (next: ChaosInjectorConfig[]) => void;
}): React.JSX.Element {
  function configFor(kind: ChaosInjectorKind): ChaosInjectorConfig | undefined {
    return value.find((c) => c.kind === kind);
  }

  function toggle(def: ChaosInjectorDef, on: boolean) {
    if (on) {
      onChange([...value.filter((c) => c.kind !== def.kind), defaultConfig(def)]);
    } else {
      onChange(value.filter((c) => c.kind !== def.kind));
    }
  }

  function patch(kind: ChaosInjectorKind, next: Partial<ChaosInjectorConfig>) {
    onChange(value.map((c) => (c.kind === kind ? { ...c, ...next } : c)));
  }

  function setParam(kind: ChaosInjectorKind, name: string, val: number | string | boolean) {
    const cfg = configFor(kind);
    if (!cfg) return;
    patch(kind, { params: { ...cfg.params, [name]: val } });
  }

  if (defs.length === 0) {
    return <p className="text-sm text-[var(--ink-3)]">No chaos injectors are advertised by the server.</p>;
  }

  return (
    <div className="space-y-3">
      {defs.map((def) => {
        const cfg = configFor(def.kind);
        const enabled = cfg?.enabled ?? false;
        return (
          <div
            key={def.kind}
            className="rounded-lg border p-3"
            style={{ borderColor: enabled ? 'color-mix(in srgb, var(--status-serious) 45%, transparent)' : 'var(--border-faint)' }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-2 font-medium">
                  <Icon name="zap" size={15} style={{ color: enabled ? 'var(--status-serious)' : 'var(--ink-3)' }} />
                  {humanizeKind(def.kind)}
                </p>
                <p className="mt-0.5 text-xs text-[var(--ink-3)]">{def.description}</p>
              </div>
              <ToggleField label="" checked={enabled} onChange={(on) => toggle(def, on)} />
            </div>

            {enabled && cfg && (
              <div className="mt-3 space-y-3 border-t border-[var(--border-faint)] pt-3">
                <SliderField
                  label="Intensity"
                  value={cfg.intensity}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(v) => patch(def.kind, { intensity: v })}
                  format={(v) => `${Math.round(v * 100)}%`}
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <NumberField
                    label="Start at (optional)"
                    value={cfg.startAtSec}
                    onChange={(v) => patch(def.kind, { startAtSec: v })}
                    min={0}
                    suffix="sec"
                    hint="Seconds from run start; blank = immediate"
                  />
                  <NumberField
                    label="Duration (optional)"
                    value={cfg.durationSec}
                    onChange={(v) => patch(def.kind, { durationSec: v })}
                    min={0}
                    suffix="sec"
                    hint="Blank = until run ends"
                  />
                </div>
                {def.params.length > 0 && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {def.params.map((p) => (
                      <ParamControl
                        key={p.name}
                        def={p}
                        value={cfg.params[p.name]}
                        onChange={(v) => setParam(def.kind, p.name, v)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
