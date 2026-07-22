import { useState, type FormEvent } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useAuthStore } from '@/store/auth-store';
import { signIn } from '@/lib/services';
import { STATUS_COLORS } from '@/lib/palette';
import { Button } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';

/**
 * Admin-token entry gate. The token is validated against GET /api/config (the
 * lightest authenticated endpoint, which also returns bootstrap config). Health
 * routes are public and cannot validate anything, so they are deliberately not
 * used here. A 429 surfaces the server's 3-strike IP throttle distinctly.
 */
export function AuthGate(): React.JSX.Element {
  const status = useAuthStore((s) => s.status);
  const error = useAuthStore((s) => s.error);
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const reduce = useReducedMotion();

  const checking = status === 'checking';
  const expired = status === 'expired';

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (checking) return;
    void signIn(value);
  }

  return (
    <div className="grid min-h-full place-items-center p-4">
      <motion.div
        className="w-full max-w-md"
        initial={reduce ? false : { opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="mb-6 text-center">
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.35em] text-[var(--accent-cyan)]">
            Deutsche Bank
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight">Workday Simulator</h1>
          <p className="mt-2 text-sm text-[var(--ink-3)]">
            Workforce &amp; identity traffic generator · Bank Operations Control Room
          </p>
        </div>

        <form onSubmit={onSubmit} className="panel panel-accent p-6" aria-labelledby="gate-heading">
          <div className="mb-4 flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-lg border border-[var(--border)] bg-[var(--surface-2)] text-[var(--accent-cyan)]">
              <Icon name="lock" size={18} />
            </span>
            <div>
              <h2 id="gate-heading" className="text-sm font-semibold">
                Admin access
              </h2>
              <p className="text-xs text-[var(--ink-3)]">Enter the ADMIN_TOKEN to continue</p>
            </div>
          </div>

          {expired && !error && (
            <div className="mb-3 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: `color-mix(in srgb, ${STATUS_COLORS.warning} 45%, transparent)`, color: STATUS_COLORS.warning }}>
              Your session ended. Sign in again to reconnect.
            </div>
          )}

          <label className="field-label" htmlFor="admin-token">
            Admin token
          </label>
          <div className="relative">
            <input
              id="admin-token"
              name="admin-token"
              className="input input-mono pr-10"
              type={reveal ? 'text' : 'password'}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="paste token"
              aria-invalid={status === 'error' ? true : undefined}
              aria-describedby={error ? 'gate-error' : undefined}
              disabled={checking}
            />
            <button
              type="button"
              className="btn btn-icon btn-ghost absolute right-1 top-1/2 -translate-y-1/2"
              onClick={() => setReveal((r) => !r)}
              aria-label={reveal ? 'Hide token' : 'Show token'}
              tabIndex={-1}
            >
              <Icon name={reveal ? 'eyeOff' : 'eye'} size={16} />
            </button>
          </div>

          {error && (
            <p id="gate-error" role="alert" className="mt-2 flex items-center gap-1.5 text-xs" style={{ color: STATUS_COLORS.critical }}>
              <Icon name="alert" size={13} />
              {error}
            </p>
          )}

          <Button
            type="submit"
            variant="primary"
            className="mt-4 w-full"
            loading={checking}
            iconRight={checking ? undefined : 'arrowRight'}
          >
            {checking ? 'Verifying' : 'Enter control room'}
          </Button>

          <p className="mt-4 flex items-start gap-1.5 text-[0.7rem] leading-relaxed text-[var(--ink-3)]">
            <Icon name="info" size={13} className="mt-0.5 shrink-0" />
            The token is held in this tab&apos;s session only and cleared on close. It is set via the
            <span className="kbd mx-1">ADMIN_TOKEN</span> server variable.
          </p>
        </form>
      </motion.div>
    </div>
  );
}
