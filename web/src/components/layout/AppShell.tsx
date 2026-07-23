import type { ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useUiStore } from '@/store/ui-store';
import { TopBar } from '@/components/layout/TopBar';
import { NavRail } from '@/components/layout/NavRail';
import { Icon } from '@/components/ui/Icon';

/**
 * The application frame: a sticky command bar, a persistent navigation rail on
 * large screens, and a slide-over drawer on small ones. The main region is the
 * only scroll container, so the page body never scrolls horizontally.
 */
export function AppShell({ children }: { children: ReactNode }): React.JSX.Element {
  const mobileNavOpen = useUiStore((s) => s.mobileNavOpen);
  const setMobileNavOpen = useUiStore((s) => s.setMobileNavOpen);
  const reduce = useReducedMotion();

  return (
    <div className="flex h-full flex-col">
      <TopBar />

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r border-[var(--border)] p-3 lg:flex">
          <NavRail />
          <div className="mt-auto rounded-lg border border-[var(--border-faint)] bg-[var(--surface-1)] p-3 text-[0.7rem] text-[var(--ink-3)]">
            <p className="flex items-center gap-1.5 font-semibold text-[var(--ink-2)]">
              <Icon name="info" size={13} /> Reference OneIM
            </p>
            <p className="mt-1 leading-relaxed">
              A built-in receiver ships with the simulator, so runs are demonstrable end-to-end with no external Identity Manager.
            </p>
          </div>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto" id="main-content" tabIndex={-1}>
          <div className="mx-auto max-w-[2400px] p-3 sm:p-4 lg:p-6 2xl:p-8">{children}</div>
        </main>
      </div>

      {/* Mobile drawer */}
      <AnimatePresence>
        {mobileNavOpen && (
          <motion.div
            className="fixed inset-0 z-40 lg:hidden"
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduce ? undefined : { opacity: 0 }}
          >
            <div className="absolute inset-0 bg-[var(--surface-scrim)] backdrop-blur-sm" onClick={() => setMobileNavOpen(false)} aria-hidden="true" />
            <motion.div
              className="absolute left-0 top-0 h-full w-72 border-r border-[var(--border)] bg-[var(--surface-0)] p-3"
              initial={reduce ? false : { x: -280 }}
              animate={{ x: 0 }}
              exit={reduce ? undefined : { x: -280 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              role="dialog"
              aria-label="Navigation"
            >
              <div className="mb-3 flex items-center justify-between">
                <span className="panel-title">Navigate</span>
                <button className="btn btn-icon btn-ghost" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)}>
                  <Icon name="x" size={18} />
                </button>
              </div>
              <NavRail />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
