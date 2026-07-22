import { VIEWS, type ViewId } from '@/lib/constants';
import { useUiStore } from '@/store/ui-store';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/ui/Icon';

const VIEW_ICON: Record<ViewId, IconName> = {
  dashboard: 'activity',
  scenarios: 'sliders',
  targets: 'target',
  history: 'history',
};

/**
 * Primary navigation. Implemented as a labelled list of buttons with
 * `aria-current="page"` on the active view, so it is fully keyboard operable and
 * announced correctly. Used both as the desktop rail and inside the mobile drawer.
 */
export function NavRail({ showHints = true }: { showHints?: boolean }): React.JSX.Element {
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);

  return (
    <nav aria-label="Primary" className="flex flex-col gap-1">
      {VIEWS.map((item) => {
        const active = view === item.id;
        return (
          <button
            key={item.id}
            type="button"
            className={cn('nav-item')}
            aria-current={active ? 'page' : undefined}
            onClick={() => setView(item.id)}
          >
            <Icon name={VIEW_ICON[item.id]} size={18} className="nav-ic" />
            <span className="flex flex-col">
              <span>{item.label}</span>
              {showHints && (
                <span className="text-[0.68rem] font-normal text-[var(--ink-3)]">{item.hint}</span>
              )}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
