import type { LocationCode, TimezoneWeights } from '@/types/api';
import { LOCATION_ORDER, LOCATIONS } from '@/lib/constants';
import { SliderField } from '@/components/ui/fields';

/**
 * Per-site activity weights that shape the multi-timezone diurnal curve. Sites
 * are grouped by region and ordered west-to-east so the follow-the-sun intent is
 * visible while tuning.
 */
export function TimezoneEditor({
  value,
  onChange,
}: {
  value: TimezoneWeights;
  onChange: (next: TimezoneWeights) => void;
}): React.JSX.Element {
  function set(code: LocationCode, weight: number) {
    onChange({ ...value, byLocation: { ...value.byLocation, [code]: weight } });
  }

  return (
    <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
      {LOCATION_ORDER.map((code) => {
        const meta = LOCATIONS[code];
        return (
          <SliderField
            key={code}
            label={`${meta.city} (${code}) · ${meta.region}`}
            value={value.byLocation[code] ?? 0}
            min={0}
            max={2}
            step={0.05}
            onChange={(v) => set(code, v)}
            format={(v) => v.toFixed(2)}
          />
        );
      })}
    </div>
  );
}
