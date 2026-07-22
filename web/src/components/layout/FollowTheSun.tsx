import { useEffect, useRef, useState } from 'react';
import { LOCATION_ORDER, LOCATIONS } from '@/lib/constants';
import { clamp } from '@/lib/format';

/**
 * Follow-the-sun region strip. For each of the eight sites it shows the local
 * time at the current SIMULATED instant and an activity intensity derived from a
 * simple diurnal curve (peak mid-morning to late afternoon). It answers "which
 * desks are live right now" at a glance, the way a global bank's ops wall does.
 */

/** Local hour (0..23, fractional) at a given instant in an IANA zone. */
function localHour(epochMs: number, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone,
    }).formatToParts(new Date(epochMs));
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    const hour = h === 24 ? 0 : h;
    return hour + m / 60;
  } catch {
    return 0;
  }
}

/** Bell-ish business intensity in [0,1] peaking at ~13:00 local. */
function intensityAt(hour: number): number {
  const peak = 13;
  const width = 5.5;
  const val = Math.exp(-((hour - peak) ** 2) / (2 * width * width));
  // Floor overnight activity so night desks are not fully dark (banks run 24x7).
  return clamp(val, 0.08, 1);
}

export function FollowTheSun({ simEpochMs }: { simEpochMs: number | null }): React.JSX.Element {
  // Advance smoothly between frames so the strip is never stale.
  const anchor = useRef<{ sim: number; base: number } | null>(null);
  const [now, setNow] = useState<number | null>(simEpochMs);

  useEffect(() => {
    if (simEpochMs === null) {
      anchor.current = null;
      setNow(null);
      return;
    }
    anchor.current = { sim: simEpochMs, base: Date.now() };
    setNow(simEpochMs);
  }, [simEpochMs]);

  useEffect(() => {
    if (simEpochMs === null) return;
    const id = setInterval(() => {
      const a = anchor.current;
      if (a) setNow(a.sim + (Date.now() - a.base) * 60);
    }, 1000);
    return () => clearInterval(id);
  }, [simEpochMs]);

  return (
    <ul className="flex items-stretch gap-1" aria-label="Follow the sun: local time and activity by site">
      {LOCATION_ORDER.map((code) => {
        const meta = LOCATIONS[code];
        const hour = now !== null ? localHour(now, meta.timezone) : 0;
        const intensity = now !== null ? intensityAt(hour) : 0.15;
        const isDay = hour >= 6 && hour < 20;
        const time =
          now !== null
            ? new Intl.DateTimeFormat('en-GB', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
                timeZone: meta.timezone,
              }).format(new Date(now))
            : '--:--';
        return (
          <li
            key={code}
            className="flex min-w-[3.1rem] flex-col items-center rounded-md border border-[var(--border-faint)] px-1.5 py-1"
            style={{ background: `color-mix(in srgb, var(--accent-cyan) ${Math.round(intensity * 16)}%, var(--surface-1))` }}
            title={`${meta.city} · ${time} local · ${Math.round(intensity * 100)}% activity`}
          >
            <span className="flex items-center gap-1 text-[0.6rem] font-semibold tracking-wide text-[var(--ink-2)]">
              <span aria-hidden="true" style={{ opacity: isDay ? 1 : 0.4 }}>{isDay ? '●' : '○'}</span>
              {code}
            </span>
            <span className="mono text-[0.62rem] tnum text-[var(--ink-3)]">{time}</span>
          </li>
        );
      })}
    </ul>
  );
}
