import { useState } from 'react';
import type { DeliveryAuthConfig, DeliveryKind, DeliveryTarget } from '@/types/api';
import type { DeliveryTargetInput } from '@/lib/api-types';
import { ALL_DELIVERY_KINDS, DELIVERY_KIND_HINT, DELIVERY_KIND_LABEL } from '@/lib/constants';
import { KeyValueEditor, NumberField, SelectField, TextField, ToggleField } from '@/components/ui/fields';
import { AuthConfigEditor } from '@/components/targets/AuthConfigEditor';
import { Icon } from '@/components/ui/Icon';

/**
 * Create/edit form for a delivery target. Renders as a <form> with an external
 * id so the hosting dialog's footer buttons can submit it. Client validation is
 * intentionally light (required fields, obvious ranges); the server's zod schema
 * is the source of truth and its errors surface as a toast.
 */

function defaultInput(kind: DeliveryKind): DeliveryTargetInput {
  return {
    name: '',
    kind,
    url: '',
    auth: { kind: 'none' },
    headers: {},
    rateLimit: { rps: 0, burst: 0 },
    concurrency: 16,
    retry: { maxRetries: 4, baseDelayMs: 200, maxDelayMs: 15_000, jitter: true, retryableStatuses: [408, 429, 500, 502, 503, 504] },
    queueHighWater: 10_000,
    overflowPolicy: 'drop_oldest',
  };
}

/**
 * Blank secret fields so the redacted sentinel the server returns is never shown
 * or re-submitted. The user must re-enter the secret to save; this makes it
 * impossible for an edit to silently overwrite a live credential.
 */
function blankSecrets(auth: DeliveryAuthConfig): DeliveryAuthConfig {
  switch (auth.kind) {
    case 'bearer':
      return { ...auth, token: '' };
    case 'basic':
      return { ...auth, password: '' };
    case 'oauth2_client_credentials':
      return { ...auth, clientSecret: '' };
    case 'hmac':
      return { ...auth, secret: '' };
    default:
      return auth;
  }
}

/** True when the selected auth method still needs its secret entered. */
function secretMissing(auth: DeliveryAuthConfig): boolean {
  switch (auth.kind) {
    case 'bearer':
      return auth.token.trim() === '';
    case 'basic':
      return auth.password.trim() === '';
    case 'oauth2_client_credentials':
      return auth.clientSecret.trim() === '';
    case 'hmac':
      return auth.secret.trim() === '';
    default:
      return false;
  }
}

function fromTarget(t: DeliveryTarget): DeliveryTargetInput {
  return {
    name: t.name,
    kind: t.kind,
    url: t.url,
    auth: blankSecrets(t.auth),
    headers: { ...t.headers },
    rateLimit: { ...t.rateLimit },
    concurrency: t.concurrency,
    retry: { ...t.retry, retryableStatuses: [...t.retry.retryableStatuses] },
    queueHighWater: t.queueHighWater,
    overflowPolicy: t.overflowPolicy,
    batchSize: t.batchSize,
    natsSubject: t.natsSubject,
  };
}

function urlPlaceholder(kind: DeliveryKind): string {
  if (kind === 'nats') return 'nats://localhost:4222';
  return 'https://oneim.example/scim/v2';
}

export function TargetForm({
  formId,
  initial,
  onSubmit,
}: {
  formId: string;
  initial: DeliveryTarget | null;
  onSubmit: (input: DeliveryTargetInput) => void;
}): React.JSX.Element {
  const editing = initial !== null;
  const [draft, setDraft] = useState<DeliveryTargetInput>(() =>
    initial ? fromTarget(initial) : defaultInput('scim'),
  );
  const [statusesText, setStatusesText] = useState(() =>
    (initial?.retry.retryableStatuses ?? [408, 429, 500, 502, 503, 504]).join(', '),
  );
  const [errors, setErrors] = useState<{ name?: string; url?: string; auth?: string }>({});

  function set<K extends keyof DeliveryTargetInput>(key: K, val: DeliveryTargetInput[K]) {
    setDraft((d) => ({ ...d, [key]: val }));
  }

  function clean(input: DeliveryTargetInput): DeliveryTargetInput {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.headers ?? {})) {
      if (k.trim()) headers[k.trim()] = v;
    }
    const retryableStatuses = statusesText
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);

    let auth = input.auth;
    if (auth.kind === 'oauth2_client_credentials' && !auth.scope) auth = { ...auth, scope: undefined };
    if (auth.kind === 'hmac' && !auth.signaturePrefix) auth = { ...auth, signaturePrefix: undefined };

    return {
      ...input,
      name: input.name.trim(),
      url: input.url.trim(),
      headers,
      auth,
      retry: { ...input.retry!, retryableStatuses },
      batchSize: input.kind === 'batch' ? (input.batchSize ?? 500) : undefined,
      natsSubject: input.kind === 'nats' ? input.natsSubject?.trim() || 'oneim.events' : undefined,
    };
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const next: { name?: string; url?: string; auth?: string } = {};
    if (!draft.name.trim()) next.name = 'A name is required.';
    if (!draft.url.trim()) next.url = 'A destination URL is required.';
    if (secretMissing(draft.auth)) {
      next.auth = editing
        ? 'Re-enter the secret to save. Secrets are never shown, so an edit cannot keep an unseen one.'
        : 'Enter the secret for this authentication method.';
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    onSubmit(clean(draft));
  }

  return (
    <form id={formId} onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Name" required value={draft.name} onChange={(v) => set('name', v)} error={errors.name} placeholder="Production OneIM" />
        <SelectField
          label="Delivery kind"
          value={draft.kind}
          onChange={(kind) => set('kind', kind)}
          options={ALL_DELIVERY_KINDS.map((k) => ({ value: k, label: DELIVERY_KIND_LABEL[k] }))}
          hint={DELIVERY_KIND_HINT[draft.kind]}
        />
      </div>

      <TextField
        label="Destination URL"
        required
        mono
        value={draft.url}
        onChange={(v) => set('url', v)}
        error={errors.url}
        placeholder={urlPlaceholder(draft.kind)}
        hint={draft.kind === 'nats' ? 'nats:// connection URL' : 'HTTP(S) base URL of the Identity Manager'}
      />

      <div
        className="rounded-lg border bg-[var(--surface-1)] p-3"
        style={{ borderColor: errors.auth ? 'color-mix(in srgb, var(--status-critical) 55%, transparent)' : 'var(--border-faint)' }}
      >
        <AuthConfigEditor value={draft.auth} onChange={(auth) => { set('auth', auth); if (errors.auth) setErrors((prev) => ({ ...prev, auth: undefined })); }} editing={editing} />
        {errors.auth && (
          <p className="mt-2 flex items-center gap-1.5 text-xs" style={{ color: 'var(--status-critical)' }} role="alert">
            <Icon name="alert" size={12} />
            {errors.auth}
          </p>
        )}
      </div>

      {draft.kind === 'batch' && (
        <NumberField label="Batch size" value={draft.batchSize} onChange={(v) => set('batchSize', v)} min={1} max={10_000} suffix="events" hint="Events accumulated per batch payload" />
      )}
      {draft.kind === 'nats' && (
        <TextField label="NATS subject" mono value={draft.natsSubject ?? ''} onChange={(v) => set('natsSubject', v)} placeholder="oneim.events" />
      )}

      <details className="rounded-lg border border-[var(--border-faint)] bg-[var(--surface-1)] p-3">
        <summary className="flex cursor-pointer select-none items-center gap-2 text-sm font-medium text-[var(--ink-2)]">
          <Icon name="sliders" size={15} /> Backpressure, rate limit &amp; retry
        </summary>
        <div className="mt-3 space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <NumberField label="Rate limit" value={draft.rateLimit?.rps} onChange={(v) => set('rateLimit', { rps: v ?? 0, burst: draft.rateLimit?.burst ?? 0 })} min={0} suffix="rps" hint="0 = unlimited" />
            <NumberField label="Burst" value={draft.rateLimit?.burst} onChange={(v) => set('rateLimit', { rps: draft.rateLimit?.rps ?? 0, burst: v ?? 0 })} min={0} />
            <NumberField label="Concurrency" value={draft.concurrency} onChange={(v) => set('concurrency', v ?? 1)} min={1} max={1024} suffix="in-flight" />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <NumberField label="Queue high-water" value={draft.queueHighWater} onChange={(v) => set('queueHighWater', v ?? 1)} min={1} suffix="events" />
            <SelectField
              label="Overflow policy"
              value={draft.overflowPolicy ?? 'drop_oldest'}
              onChange={(v) => set('overflowPolicy', v)}
              options={[
                { value: 'block', label: 'Block (apply backpressure)' },
                { value: 'drop_new', label: 'Drop newest' },
                { value: 'drop_oldest', label: 'Drop oldest' },
              ]}
            />
            <NumberField label="Max retries" value={draft.retry?.maxRetries} onChange={(v) => set('retry', { ...draft.retry!, maxRetries: v ?? 0 })} min={0} max={20} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField label="Base delay" value={draft.retry?.baseDelayMs} onChange={(v) => set('retry', { ...draft.retry!, baseDelayMs: v ?? 0 })} min={0} suffix="ms" />
            <NumberField label="Max delay" value={draft.retry?.maxDelayMs} onChange={(v) => set('retry', { ...draft.retry!, maxDelayMs: v ?? 0 })} min={0} suffix="ms" />
          </div>
          <TextField label="Retryable statuses" mono value={statusesText} onChange={setStatusesText} hint="Comma-separated HTTP status codes" placeholder="408, 429, 500, 502, 503, 504" />
          <ToggleField label="Jittered backoff" checked={draft.retry?.jitter ?? true} onChange={(v) => set('retry', { ...draft.retry!, jitter: v })} hint="Randomize retry delays to avoid thundering herds" />
          <KeyValueEditor label="Custom headers" entries={draft.headers ?? {}} onChange={(headers) => set('headers', headers)} />
        </div>
      </details>
    </form>
  );
}
