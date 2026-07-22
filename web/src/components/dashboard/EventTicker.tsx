import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { ActorRef, WorkdayEvent } from '@/types/api';
import { CATEGORY_COLORS, SEVERITY_TONE, STATUS_COLORS } from '@/lib/palette';
import { CATEGORY_SHORT } from '@/lib/constants';
import { formatClockTime, humanizeKind } from '@/lib/format';
import { localZone } from '@/components/charts/chart-kit';
import { EmptyState } from '@/components/ui/primitives';

/** Actor is an employee, a service (NHI), or the platform itself. */
function actorName(actor: ActorRef): string {
  return actor.kind === 'system' ? actor.component : actor.displayName;
}

function actorKindLabel(actor: ActorRef): string {
  if (actor.kind === 'system') return 'system';
  if (actor.kind === 'service') return 'service';
  return 'user';
}

function EventRow({ event, animate }: { event: WorkdayEvent; animate: boolean }): React.JSX.Element {
  const tone = SEVERITY_TONE[event.severity];
  const catColor = CATEGORY_COLORS[event.category];
  const subject = event.subject?.displayName;

  return (
    <motion.li
      layout={animate}
      initial={animate ? { opacity: 0, y: -8 } : false}
      animate={{ opacity: 1, y: 0 }}
      exit={animate ? { opacity: 0 } : undefined}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className="flex items-center gap-2.5 border-b border-[var(--border-faint)] px-3 py-2 text-sm last:border-b-0"
    >
      <span
        aria-hidden="true"
        style={{ width: 8, height: 8, borderRadius: 999, background: STATUS_COLORS[tone], flex: 'none' }}
        title={event.severity}
      />
      <span
        className="hidden shrink-0 rounded px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide sm:inline"
        style={{ color: catColor, background: `color-mix(in srgb, ${catColor} 14%, transparent)` }}
      >
        {CATEGORY_SHORT[event.category]}
      </span>
      <span className="min-w-0 flex-1">
        <span className="font-medium text-[var(--ink)]">{humanizeKind(event.kind)}</span>
        <span className="ml-2 text-xs text-[var(--ink-3)]">
          {actorName(event.actor)}
          <span className="ml-1 opacity-60">· {actorKindLabel(event.actor)}</span>
          {subject && <span className="text-[var(--ink-3)]"> → {subject}</span>}
        </span>
      </span>
      <span className="shrink-0 text-[0.65rem] uppercase tracking-wide text-[var(--ink-3)]">{event.location}</span>
      <span className="mono shrink-0 text-[0.65rem] tnum text-[var(--ink-3)]" title={event.timestamp}>
        {formatClockTime(event.emittedAtWall, localZone(), true)}
      </span>
    </motion.li>
  );
}

export function EventTicker({ events }: { events: WorkdayEvent[] }): React.JSX.Element {
  const reduce = useReducedMotion();
  const shown = events.slice(0, 40);

  return (
    <div className="panel above flex h-full min-h-0 flex-col" aria-label="Live event stream">
      <div className="panel-hd">
        <span className="panel-title">
          <span className="live-dot" style={{ color: STATUS_COLORS.good }} />
          Live event stream
        </span>
        <span className="text-[0.68rem] text-[var(--ink-3)]">{events.length} recent</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" role="log" aria-live="off" aria-label="Recent simulated events">
        {shown.length === 0 ? (
          <EmptyState icon="activity" title="Stream idle" message="Events appear here the moment a run starts generating." />
        ) : (
          <ul>
            <AnimatePresence initial={false}>
              {shown.map((event) => (
                <EventRow key={event.id} event={event} animate={!reduce} />
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </div>
  );
}
