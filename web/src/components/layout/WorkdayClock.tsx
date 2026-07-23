import { useEffect, useRef, useState } from 'react';
import type { ClockState } from '@/types/api';
import { PHASE_COLOR } from '@/lib/palette';
import { formatClockTime, humanizeKind } from '@/lib/format';

/**
 * The accelerated workday clock. Frames arrive once per second but sim time
 * advances `accel`x faster, so between frames we interpolate locally from the
 * last known sim epoch. This makes the clock tick smoothly instead of jumping a
 * minute at a time. Sim time is shown in Frankfurt local time because the
 * workday phase is defined against Frankfurt (contract).
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function WorkdayClock({
  clock,
  accelFallback,
}: {
  clock: ClockState | null;
  accelFallback: number;
}): React.JSX.Element {
  const anchor = useRef<{ simEpochMs: number; accel: number; base: number } | null>(null);
  const [displayMs, setDisplayMs] = useState<number | null>(null);

  // Re-anchor whenever a fresh frame moves sim time.
  useEffect(() => {
    if (!clock) {
      anchor.current = null;
      setDisplayMs(null);
      return;
    }
    anchor.current = { simEpochMs: clock.simEpochMs, accel: clock.accel, base: Date.now() };
    setDisplayMs(clock.simEpochMs);
  }, [clock]);

  // Tick the interpolated display ~5x/sec.
  useEffect(() => {
    if (!clock) return;
    const id = setInterval(() => {
      const a = anchor.current;
      if (!a) return;
      setDisplayMs(a.simEpochMs + (Date.now() - a.base) * a.accel);
    }, 200);
    return () => clearInterval(id);
  }, [clock]);

  const phase = clock?.phase;
  const phaseColor = phase ? PHASE_COLOR[phase] : 'var(--ink-3)';
  const iso = displayMs !== null ? new Date(displayMs).toISOString() : null;
  const timeStr = iso ? formatClockTime(iso, 'Europe/Berlin') : '--:--:--';
  const accel = clock?.accel ?? accelFallback;

  return (
    <div className="flex items-center gap-3">
      <div className="flex flex-col leading-none">
        <div className="flex items-baseline gap-1.5">
          <span className="mono text-lg font-semibold tracking-tight tnum">{timeStr}</span>
          <span className="text-[0.6rem] font-semibold uppercase tracking-widest text-[var(--ink-3)]">FFT</span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5">
          <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: phaseColor }} />
          <span className="text-[0.68rem] text-[var(--ink-2)]">
            {phase ? humanizeKind(phase) : 'Idle'}
          </span>
          {clock && (
            <span className="text-[0.68rem] text-[var(--ink-3)]">
              · {WEEKDAYS[clock.weekday] ?? '--'}
              {!clock.isBusinessDay && ' · weekend'}
            </span>
          )}
        </div>
      </div>
      <span className="badge tnum" style={{ borderColor: 'var(--border-strong)' }} title="Simulated seconds per real second">
        {accel}× accel
      </span>
    </div>
  );
}
