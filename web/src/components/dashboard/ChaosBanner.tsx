import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { ActiveChaos } from '@/types/api';
import { STATUS_COLORS } from '@/lib/palette';
import { formatInt, humanizeKind, relativeTime } from '@/lib/format';
import { Icon } from '@/components/ui/Icon';

/**
 * Prominent banner for active chaos injectors. Rendered only while at least one
 * injector is firing, so it reads as an exceptional condition, not chrome. It is
 * an aria-live region so the onset of a chaos scenario is announced.
 */
export function ChaosBanner({ chaos }: { chaos: ActiveChaos[] }): React.JSX.Element {
  const reduce = useReducedMotion();
  const color = STATUS_COLORS.serious;

  return (
    <div aria-live="polite">
      <AnimatePresence>
        {chaos.length > 0 && (
          <motion.div
            initial={reduce ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div
              className="flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3"
              style={{
                borderColor: `color-mix(in srgb, ${color} 45%, transparent)`,
                background: `linear-gradient(90deg, color-mix(in srgb, ${color} 16%, var(--surface-1)), var(--surface-1))`,
              }}
              role="status"
            >
              <span className="flex items-center gap-2 font-semibold" style={{ color }}>
                <Icon name="zap" size={18} />
                Chaos active
              </span>
              <ul className="flex flex-1 flex-wrap items-center gap-2">
                {chaos.map((c) => (
                  <li
                    key={c.kind}
                    className="chip"
                    style={{ borderColor: `color-mix(in srgb, ${color} 40%, transparent)` }}
                    title={`Started ${relativeTime(c.startedAt)}${c.endsAt ? `, ends ${relativeTime(c.endsAt)}` : ''}`}
                  >
                    <span className="font-medium text-[var(--ink)]">{humanizeKind(c.kind)}</span>
                    <span className="text-xs text-[var(--ink-3)]">
                      {Math.round(c.intensity * 100)}% · {formatInt(c.eventsInjected)} injected
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
