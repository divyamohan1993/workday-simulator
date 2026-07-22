import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { FieldError } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';

/**
 * Accessible, controlled form controls used across the Scenario Builder and
 * Targets forms. Every control wires label/description/error with the right
 * ARIA relationships; none relies on placeholder text as a label.
 */

interface BaseFieldProps {
  label: string;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  className?: string;
}

function Describe({
  id,
  hint,
  error,
}: {
  id: string;
  hint?: ReactNode;
  error?: string;
}): React.JSX.Element | null {
  if (error) return <FieldError>{error}</FieldError>;
  if (hint) {
    return (
      <p id={`${id}-hint`} className="mt-1 text-xs text-[var(--ink-3)]">
        {hint}
      </p>
    );
  }
  return null;
}

export function TextField({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  hint,
  error,
  required,
  mono,
  autoComplete = 'off',
  className,
}: BaseFieldProps & {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  mono?: boolean;
  autoComplete?: string;
}): React.JSX.Element {
  const id = useId();
  return (
    <div className={className}>
      <label className="field-label" htmlFor={id}>
        {label} {required && <span aria-hidden="true" style={{ color: 'var(--status-serious)' }}>*</span>}
      </label>
      <input
        id={id}
        className={cn('input', mono && 'input-mono')}
        type={type}
        value={value}
        placeholder={placeholder}
        required={required}
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? undefined : hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      <Describe id={id} hint={hint} error={error} />
    </div>
  );
}

export function TextArea({
  label,
  value,
  onChange,
  rows = 3,
  placeholder,
  hint,
  error,
  className,
}: BaseFieldProps & {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
}): React.JSX.Element {
  const id = useId();
  return (
    <div className={className}>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className="textarea"
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      <Describe id={id} hint={hint} error={error} />
    </div>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  suffix,
  hint,
  error,
  required,
  className,
}: BaseFieldProps & {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}): React.JSX.Element {
  const id = useId();
  return (
    <div className={className}>
      <label className="field-label" htmlFor={id}>
        {label} {required && <span aria-hidden="true" style={{ color: 'var(--status-serious)' }}>*</span>}
      </label>
      <div className="relative">
        <input
          id={id}
          className="input tnum"
          type="number"
          inputMode="decimal"
          value={value ?? ''}
          min={min}
          max={max}
          step={step}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            const raw = e.target.value;
            onChange(raw === '' ? undefined : Number(raw));
          }}
        />
        {suffix && (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[var(--ink-3)]">
            {suffix}
          </span>
        )}
      </div>
      <Describe id={id} hint={hint} error={error} />
    </div>
  );
}

export function SliderField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  format,
  hint,
  className,
}: Omit<BaseFieldProps, 'error'> & {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
}): React.JSX.Element {
  const id = useId();
  return (
    <div className={className}>
      <div className="flex items-center justify-between">
        <label className="field-label !mb-0" htmlFor={id}>
          {label}
        </label>
        <span className="tnum text-sm font-semibold text-[var(--ink)]">
          {format ? format(value) : value}
        </span>
      </div>
      <input
        id={id}
        className="range mt-2"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      {hint && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-[var(--ink-3)]">
          {hint}
        </p>
      )}
    </div>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  onChange,
  options,
  hint,
  error,
  required,
  className,
}: BaseFieldProps & {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
}): React.JSX.Element {
  const id = useId();
  return (
    <div className={className}>
      <label className="field-label" htmlFor={id}>
        {label} {required && <span aria-hidden="true" style={{ color: 'var(--status-serious)' }}>*</span>}
      </label>
      <select
        id={id}
        className="select"
        value={value}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <Describe id={id} hint={hint} error={error} />
    </div>
  );
}

export function ToggleField({
  label,
  checked,
  onChange,
  hint,
  className,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: ReactNode;
  className?: string;
}): React.JSX.Element {
  const id = useId();
  return (
    <div className={cn('flex items-center justify-between gap-3', className)}>
      <span>
        <span id={id} className="text-sm font-medium text-[var(--ink)]">
          {label}
        </span>
        {hint && <span className="block text-xs text-[var(--ink-3)]">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={id}
        onClick={() => onChange(!checked)}
        className="relative h-6 w-11 shrink-0 rounded-full border transition-colors"
        style={{
          background: checked ? 'var(--accent)' : 'var(--surface-3)',
          borderColor: checked ? 'var(--accent)' : 'var(--border)',
        }}
      >
        <span
          className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all"
          style={{ left: checked ? '1.5rem' : '0.15rem' }}
        />
      </button>
    </div>
  );
}

/** Editor for a string->string map (delivery target headers). */
export function KeyValueEditor({
  label,
  entries,
  onChange,
  hint,
}: {
  label: string;
  entries: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  hint?: ReactNode;
}): React.JSX.Element {
  const rows = Object.entries(entries);

  function update(index: number, key: string, val: string) {
    const next: Record<string, string> = {};
    rows.forEach(([k, v], i) => {
      if (i === index) {
        if (key) next[key] = val;
      } else {
        next[k] = v;
      }
    });
    onChange(next);
  }
  function add() {
    onChange({ ...entries, '': '' });
  }
  function remove(index: number) {
    const next: Record<string, string> = {};
    rows.forEach(([k, v], i) => {
      if (i !== index) next[k] = v;
    });
    onChange(next);
  }

  return (
    <div>
      <span className="field-label">{label}</span>
      <div className="space-y-2">
        {rows.length === 0 && <p className="text-xs text-[var(--ink-3)]">No custom headers.</p>}
        {rows.map(([k, v], i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              className="input input-mono"
              placeholder="Header"
              aria-label={`Header ${i + 1} name`}
              value={k}
              onChange={(e) => update(i, e.target.value, v)}
            />
            <input
              className="input input-mono"
              placeholder="Value"
              aria-label={`Header ${i + 1} value`}
              value={v}
              onChange={(e) => update(i, k, e.target.value)}
            />
            <button type="button" className="btn btn-icon btn-ghost" aria-label={`Remove header ${i + 1}`} onClick={() => remove(i)}>
              <Icon name="trash" size={15} />
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="btn btn-sm mt-2" onClick={add}>
        <Icon name="plus" size={14} /> Add header
      </button>
      {hint && <p className="mt-1 text-xs text-[var(--ink-3)]">{hint}</p>}
    </div>
  );
}
