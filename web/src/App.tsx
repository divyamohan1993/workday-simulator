import { lazy, Suspense, useEffect, useState } from 'react';
import { useAuthStore } from '@/store/auth-store';
import { useUiStore } from '@/store/ui-store';
import { bootstrapSession } from '@/lib/services';
import { AppShell } from '@/components/layout/AppShell';
import { AuthGate } from '@/components/auth/AuthGate';
import { Toasts } from '@/components/ui/Toasts';
import { Spinner } from '@/components/ui/primitives';

/**
 * Root component. Owns three things: session bootstrap (re-validate a token
 * carried over in this tab), hash-based view routing (so refresh and deep-links
 * work), and code-split view loading so the initial bundle stays lean and the
 * chart-heavy views load on demand.
 */

const LiveDashboard = lazy(() => import('@/components/dashboard/LiveDashboard'));
const ScenarioBuilder = lazy(() => import('@/components/scenario/ScenarioBuilder'));
const TargetsView = lazy(() => import('@/components/targets/TargetsView'));
const RunHistory = lazy(() => import('@/components/history/RunHistory'));

function ViewFallback(): React.JSX.Element {
  return (
    <div className="flex items-center justify-center gap-2 py-24 text-sm text-[var(--ink-3)]">
      <Spinner /> Loading view…
    </div>
  );
}

function Splash(): React.JSX.Element {
  return (
    <div className="grid min-h-full place-items-center">
      <div className="flex flex-col items-center gap-3 text-[var(--ink-3)]">
        <Spinner size={28} />
        <p className="text-sm">Restoring session…</p>
      </div>
    </div>
  );
}

function CurrentView(): React.JSX.Element {
  const view = useUiStore((s) => s.view);
  return (
    <Suspense fallback={<ViewFallback />}>
      {view === 'dashboard' && <LiveDashboard />}
      {view === 'scenarios' && <ScenarioBuilder />}
      {view === 'targets' && <TargetsView />}
      {view === 'history' && <RunHistory />}
    </Suspense>
  );
}

export function App(): React.JSX.Element {
  const status = useAuthStore((s) => s.status);
  const syncViewFromHash = useUiStore((s) => s.syncViewFromHash);
  const [booting, setBooting] = useState(true);

  // Revalidate any token from a prior tab session, once.
  useEffect(() => {
    void bootstrapSession().finally(() => setBooting(false));
  }, []);

  // Keep the active view in sync with browser back/forward and manual hash edits.
  useEffect(() => {
    window.addEventListener('hashchange', syncViewFromHash);
    return () => window.removeEventListener('hashchange', syncViewFromHash);
  }, [syncViewFromHash]);

  const authed = status === 'authed';

  return (
    <>
      <a
        href="#main-content"
        className="sr-only rounded bg-[var(--surface-2)] px-3 py-2 text-sm focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[70]"
      >
        Skip to content
      </a>
      {booting ? <Splash /> : authed ? (
        <AppShell>
          <CurrentView />
        </AppShell>
      ) : (
        <AuthGate />
      )}
      <Toasts />
    </>
  );
}
