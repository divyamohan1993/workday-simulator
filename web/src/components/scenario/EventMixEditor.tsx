import type { EventCategory, EventMixWeights } from '@/types/api';
import { CATEGORY_COLORS } from '@/lib/palette';
import { ALL_CATEGORIES, CATEGORY_EXAMPLES, CATEGORY_LABEL } from '@/lib/constants';
import { formatPct } from '@/lib/format';
import { SliderField } from '@/components/ui/fields';

/**
 * Relative event-mix weights by category. The generator normalizes across
 * enabled categories, so the slider values are weights, not percentages; the
 * live "share" readout shows the resulting normalized proportion.
 */
export function EventMixEditor({
  value,
  onChange,
}: {
  value: EventMixWeights;
  onChange: (next: EventMixWeights) => void;
}): React.JSX.Element {
  const total = ALL_CATEGORIES.reduce((sum, c) => sum + (value.byCategory[c] ?? 0), 0);

  function set(cat: EventCategory, weight: number) {
    onChange({ ...value, byCategory: { ...value.byCategory, [cat]: weight } });
  }

  return (
    <div className="space-y-4">
      {ALL_CATEGORIES.map((cat) => {
        const weight = value.byCategory[cat] ?? 0;
        const share = total > 0 ? weight / total : 0;
        return (
          <div key={cat}>
            <SliderField
              label={CATEGORY_LABEL[cat]}
              value={weight}
              min={0}
              max={3}
              step={0.05}
              onChange={(v) => set(cat, v)}
              format={(v) => `${v.toFixed(2)} · ${formatPct(share, 0)}`}
              hint={CATEGORY_EXAMPLES[cat]}
            />
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--surface-3)]">
              <div
                className="h-full rounded-full transition-[width] duration-300"
                style={{ width: `${share * 100}%`, background: CATEGORY_COLORS[cat] }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
