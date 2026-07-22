import { useAuthStore } from '@/store/auth-store';
import { useTelemetryStore } from '@/store/telemetry-store';
import { useUiStore } from '@/store/ui-store';
import { signOut } from '@/lib/services';
import { RUN_STATUS_TONE, STATUS_COLORS } from '@/lib/palette';
import { formatRps, humanizeKind } from '@/lib/format';
import { Icon } from '@/components/ui/Icon';
import { StatusDot } from '@/components/ui/primitives';
import { WorkdayClock } from '@/components/layout/WorkdayClock';
import { FollowTheSun } from '@/components/layout/FollowTheSun';
import { ConnectionStatus } from '@/components/layout/ConnectionStatus';

function BrandMark(): React.JSX.Element {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className="grid h-9 w-9 place-items-center rounded-lg font-bold text-white"
        style={{ background: 'linear-gradient(135deg, var(--db-blue), #0b2a6b)', boxShadow: '0 6px 16px -8px rgba(47,107,214,0.8)' }}
        aria-hidden="true"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
          <path d="M4 4h16v16H4z" opacity="0.35" />
          <path d="M8 8l8 8M16 8l-8 8" />
        </svg>
      </span>
      <div className="hidden leading-none sm:block">
        <p className="text-sm font-semibold tracking-tight">Workday Simulator</p>
        <p className="text-[0.66rem] uppercase tracking-[0.18em] text-[var(--ink-3)]">
          Bank Ops Control Room
        </p>
      </div>
    </div>
  );
}

export function TopBar(): React.JSX.Element {
  const clock = useTelemetryStore((s) => s.frame?.clock ?? null);
  const simEpochMs = useTelemetryStore((s) => s.frame?.clock.simEpochMs ?? null);
  const run = useTelemetryStore((s) => s.run);
  const config = useAuthStore((s) => s.config);
  const setMobileNavOpen = useUiStore((s) => s.setMobileNavOpen);
  const setView = useUiStore((s) => s.setView);

  const runActive = run && (run.status === 'running' || run.status === 'paused' || run.status === 'starting');

  return (
    <header className="glass sticky top-0 z-30 flex items-center gap-3 border-b border-[var(--border)] px-3 py-2.5">
      <button
        type="button"
        className="btn btn-icon btn-ghost lg:hidden"
        aria-label="Open navigation"
        onClick={() => setMobileNavOpen(true)}
      >
        <Icon name="menu" size={20} />
      </button>

      <BrandMark />

      <div className="mx-1 hidden h-8 w-px bg-[var(--border)] sm:block" />

      <div className="hidden sm:block">
        <WorkdayClock clock={clock} accelFallback={config?.workdayAccel ?? 60} />
      </div>

      <div className="ml-2 hidden xl:block">
        <FollowTheSun simEpochMs={simEpochMs} />
      </div>

      <div className="ml-auto flex items-center gap-2">
        {runActive && run && (
          <button
            type="button"
            onClick={() => setView('dashboard')}
            className="badge hidden md:inline-flex"
            style={{
              color: STATUS_COLORS[RUN_STATUS_TONE[run.status]],
              borderColor: `color-mix(in srgb, ${STATUS_COLORS[RUN_STATUS_TONE[run.status]]} 40%, transparent)`,
            }}
            title="Go to live operations"
          >
            <StatusDot tone={RUN_STATUS_TONE[run.status]} pulse={run.status === 'running'} />
            {humanizeKind(run.status)} · {formatRps(run.currentRps)} rps
          </button>
        )}

        <ConnectionStatus />

        <div className="mx-0.5 hidden h-6 w-px bg-[var(--border)] sm:block" />

        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => signOut()}
          title="Sign out and clear the admin token"
        >
          <Icon name="signOut" size={15} />
          <span className="hidden sm:inline">Sign out</span>
        </button>
      </div>
    </header>
  );
}
