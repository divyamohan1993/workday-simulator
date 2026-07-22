import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { createPortal } from 'react-dom';
import { STATUS_COLORS } from '@/lib/palette';
import { useUiStore } from '@/store/ui-store';
import { Icon, type IconName } from '@/components/ui/Icon';
import type { StatusTone } from '@/lib/palette';

/**
 * Transient notification viewport. Toasts are polite status messages (a run
 * started, a target saved, a session expired), announced to assistive tech via
 * an aria-live region so they are not silent.
 */

const TONE_ICON: Record<StatusTone, IconName> = {
  good: 'check',
  warning: 'alert',
  serious: 'alert',
  critical: 'alert',
  neutral: 'info',
};

export function Toasts(): React.JSX.Element | null {
  const toasts = useUiStore((s) => s.toasts);
  const dismiss = useUiStore((s) => s.dismissToast);
  const reduce = useReducedMotion();

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(92vw,22rem)] flex-col gap-2"
      role="region"
      aria-label="Notifications"
    >
      <div aria-live="polite" aria-atomic="false" className="contents">
        <AnimatePresence initial={false}>
          {toasts.map((toast) => {
            const color = STATUS_COLORS[toast.tone];
            return (
              <motion.div
                key={toast.id}
                layout={!reduce}
                initial={reduce ? false : { opacity: 0, x: 24, scale: 0.98 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, x: 24, scale: 0.98 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                className="panel pointer-events-auto flex items-start gap-3 p-3"
                style={{ borderColor: `color-mix(in srgb, ${color} 45%, var(--border))` }}
              >
                <span className="mt-0.5" style={{ color }}>
                  <Icon name={TONE_ICON[toast.tone]} size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-[var(--ink)]">{toast.title}</p>
                  {toast.message && (
                    <p className="mt-0.5 text-xs text-[var(--ink-2)]">{toast.message}</p>
                  )}
                </div>
                <button
                  className="btn btn-icon btn-ghost -mr-1 -mt-1"
                  onClick={() => dismiss(toast.id)}
                  aria-label="Dismiss notification"
                >
                  <Icon name="x" size={14} />
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>,
    document.body,
  );
}
