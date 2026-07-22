import { useEffect, useState } from 'react';
import type { SocketStatus } from '@/lib/ws-client';
import type { StatusTone } from '@/lib/palette';
import { STATUS_COLORS } from '@/lib/palette';
import { useTelemetryStore } from '@/store/telemetry-store';
import { StatusDot } from '@/components/ui/primitives';

/**
 * Live telemetry-stream connection indicator. Colour is backed by an explicit
 * text label and (for the live state) a pulsing dot, so the state is never
 * conveyed by colour alone.
 */

const STATUS_META: Record<SocketStatus, { tone: StatusTone; label: string; pulse: boolean }> = {
  idle: { tone: 'neutral', label: 'Idle', pulse: false },
  connecting: { tone: 'warning', label: 'Connecting', pulse: false },
  open: { tone: 'good', label: 'Live', pulse: true },
  reconnecting: { tone: 'warning', label: 'Reconnecting', pulse: false },
  auth_error: { tone: 'critical', label: 'Auth failed', pulse: false },
  closed: { tone: 'neutral', label: 'Offline', pulse: false },
};

export function ConnectionStatus(): React.JSX.Element {
  const status = useTelemetryStore((s) => s.status);
  const lastFrameAt = useTelemetryStore((s) => s.lastFrameAt);
  const [, forceTick] = useState(0);

  // Refresh the "age" readout once a second while live.
  useEffect(() => {
    if (status !== 'open' || !lastFrameAt) return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [status, lastFrameAt]);

  const meta = STATUS_META[status];
  const ageSec = lastFrameAt ? Math.max(0, Math.round((Date.now() - lastFrameAt) / 1000)) : null;

  return (
    <span
      className="badge"
      style={{
        color: STATUS_COLORS[meta.tone],
        borderColor: `color-mix(in srgb, ${STATUS_COLORS[meta.tone]} 40%, transparent)`,
        background: `color-mix(in srgb, ${STATUS_COLORS[meta.tone]} 12%, transparent)`,
      }}
      role="status"
      aria-label={`Telemetry stream ${meta.label}`}
    >
      <StatusDot tone={meta.tone} pulse={meta.pulse} />
      {meta.label}
      {status === 'open' && ageSec !== null && (
        <span className="tnum text-[var(--ink-3)]">· {ageSec}s</span>
      )}
    </span>
  );
}
