import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { STATUS_COLORS, type StatusTone } from '@/lib/palette';
import { Icon, type IconName } from '@/components/ui/Icon';

/* --- Panel ----------------------------------------------------------------- */

export interface PanelProps {
  title?: ReactNode;
  icon?: IconName;
  actions?: ReactNode;
  accent?: boolean;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
  /** Panel labelled region for screen readers. */
  ariaLabel?: string;
}

export function Panel({
  title,
  icon,
  actions,
  accent,
  className,
  bodyClassName,
  children,
  ariaLabel,
}: PanelProps): React.JSX.Element {
  return (
    <section
      className={cn('panel above', accent && 'panel-accent', className)}
      aria-label={ariaLabel ?? (typeof title === 'string' ? title : undefined)}
    >
      {(title || actions) && (
        <header className="panel-hd">
          <div className="panel-title">
            {icon && <Icon name={icon} size={15} />}
            {title}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

/* --- Button ---------------------------------------------------------------- */

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'icon';
  iconLeft?: IconName;
  iconRight?: IconName;
  loading?: boolean;
}

export function Button({
  variant = 'default',
  size = 'md',
  iconLeft,
  iconRight,
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      className={cn(
        'btn',
        variant === 'primary' && 'btn-primary',
        variant === 'danger' && 'btn-danger',
        variant === 'ghost' && 'btn-ghost',
        size === 'sm' && 'btn-sm',
        size === 'icon' && 'btn-icon',
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <Icon name="refresh" size={size === 'sm' ? 14 : 16} className="spin" />
      ) : (
        iconLeft && <Icon name={iconLeft} size={size === 'sm' ? 14 : 16} />
      )}
      {children}
      {iconRight && !loading && <Icon name={iconRight} size={size === 'sm' ? 14 : 16} />}
    </button>
  );
}

/* --- Status primitives ----------------------------------------------------- */

export interface StatusDotProps {
  tone: StatusTone;
  pulse?: boolean;
  size?: number;
  className?: string;
}

export function StatusDot({ tone, pulse, size = 8, className }: StatusDotProps): React.JSX.Element {
  const color = STATUS_COLORS[tone];
  return (
    <span
      className={cn(pulse && 'live-dot', className)}
      style={{ color, background: color, width: size, height: size, borderRadius: '50%', display: 'inline-block', flex: 'none' }}
      aria-hidden="true"
    />
  );
}

export interface BadgeProps {
  tone?: StatusTone;
  icon?: IconName;
  children: ReactNode;
  className?: string;
}

/** A colored pill. Color is never the only signal: it always carries a text label. */
export function Badge({ tone = 'neutral', icon, children, className }: BadgeProps): React.JSX.Element {
  const color = STATUS_COLORS[tone];
  return (
    <span
      className={cn('badge', className)}
      style={{
        color,
        background: `color-mix(in srgb, ${color} 15%, transparent)`,
        borderColor: `color-mix(in srgb, ${color} 40%, transparent)`,
      }}
    >
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}

/* --- Stat tile ------------------------------------------------------------- */

export interface StatTileProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: IconName;
  tone?: StatusTone;
  className?: string;
}

export function StatTile({ label, value, hint, icon, tone, className }: StatTileProps): React.JSX.Element {
  const color = tone ? STATUS_COLORS[tone] : undefined;
  return (
    <div className={cn('stat', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="stat-label">{label}</span>
        {icon && <Icon name={icon} size={15} style={{ color: color ?? 'var(--ink-3)' }} />}
      </div>
      <div className="stat-value tnum" style={color ? { color } : undefined}>
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-[var(--ink-3)]">{hint}</div>}
    </div>
  );
}

/* --- Meter ----------------------------------------------------------------- */

export interface MeterBarProps {
  value: number;
  max: number;
  tone?: StatusTone;
  label?: string;
  valueLabel?: string;
  className?: string;
}

/** A single-bar gauge; the track is a faint step of the same hue. */
export function MeterBar({ value, max, tone = 'good', label, valueLabel, className }: MeterBarProps): React.JSX.Element {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const color = STATUS_COLORS[tone];
  return (
    <div className={className}>
      {(label || valueLabel) && (
        <div className="mb-1 flex items-center justify-between text-xs">
          {label && <span className="text-[var(--ink-3)]">{label}</span>}
          {valueLabel && <span className="tnum text-[var(--ink-2)]">{valueLabel}</span>}
        </div>
      )}
      <div
        className="h-2 w-full overflow-hidden rounded-full"
        style={{ background: `color-mix(in srgb, ${color} 16%, var(--surface-3))` }}
        role="meter"
        aria-valuenow={Math.round(value)}
        aria-valuemin={0}
        aria-valuemax={Math.round(max)}
        aria-label={label}
      >
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
    </div>
  );
}

/* --- Loading / empty / error ---------------------------------------------- */

export function Spinner({ size = 18, className }: { size?: number; className?: string }): React.JSX.Element {
  return <Icon name="refresh" size={size} className={cn('spin', className)} aria-hidden="true" />;
}

export function LoadingRows({ rows = 3, className }: { rows?: number; className?: string }): React.JSX.Element {
  return (
    <div className={cn('space-y-2', className)} aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton h-10 w-full" />
      ))}
    </div>
  );
}

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  message?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon = 'info', title, message, action, className }: EmptyStateProps): React.JSX.Element {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 px-6 py-12 text-center', className)}>
      <span className="grid h-12 w-12 place-items-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] text-[var(--ink-3)]">
        <Icon name={icon} size={22} />
      </span>
      <div>
        <p className="font-semibold text-[var(--ink)]">{title}</p>
        {message && <p className="mt-1 max-w-md text-sm text-[var(--ink-3)]">{message}</p>}
      </div>
      {action}
    </div>
  );
}

export interface ErrorStateProps {
  error: Error | string;
  onRetry?: () => void;
  className?: string;
  compact?: boolean;
}

export function ErrorState({ error, onRetry, className, compact }: ErrorStateProps): React.JSX.Element {
  const message = typeof error === 'string' ? error : error.message;
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-3 text-center',
        compact ? 'px-4 py-6' : 'px-6 py-12',
        className,
      )}
    >
      <span
        className="grid h-11 w-11 place-items-center rounded-full"
        style={{ color: STATUS_COLORS.critical, background: `color-mix(in srgb, ${STATUS_COLORS.critical} 14%, transparent)` }}
      >
        <Icon name="alert" size={20} />
      </span>
      <div>
        <p className="font-semibold text-[var(--ink)]">Something went wrong</p>
        <p className="mt-1 max-w-md text-sm text-[var(--ink-3)]">{message}</p>
      </div>
      {onRetry && (
        <Button size="sm" iconLeft="refresh" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/* --- Small helpers --------------------------------------------------------- */

export function SectionLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <p className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-[var(--ink-3)]">
      {children}
    </p>
  );
}

export function FieldError({ children }: { children: ReactNode }): React.JSX.Element | null {
  if (!children) return null;
  return (
    <p className="mt-1 flex items-center gap-1 text-xs" style={{ color: STATUS_COLORS.critical }} role="alert">
      <Icon name="alert" size={12} />
      {children}
    </p>
  );
}
