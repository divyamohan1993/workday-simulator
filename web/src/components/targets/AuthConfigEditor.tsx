import type { DeliveryAuthConfig } from '@/types/api';
import { SelectField, TextField } from '@/components/ui/fields';
import { Icon } from '@/components/ui/Icon';

/**
 * Editor for a delivery target's authentication, a discriminated union over
 * `kind`. Switching kind resets to that kind's default shape so the form never
 * holds an inconsistent mix of fields.
 *
 * Secret handling (security-first): the server never returns real secrets (it
 * redacts them to "***REDACTED***"). Rather than round-trip that sentinel back
 * on update, which would silently overwrite the stored secret with the literal
 * string unless the server special-cases it, secret fields are BLANKED when an
 * existing target is loaded and must be re-entered to save. This guarantees an
 * edit can never corrupt a live credential, at the cost of retyping the secret
 * on an edit. The form enforces re-entry.
 */

type AuthKind = DeliveryAuthConfig['kind'];

const KIND_OPTIONS: Array<{ value: AuthKind; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'bearer', label: 'Bearer token' },
  { value: 'basic', label: 'Basic (username / password)' },
  { value: 'oauth2_client_credentials', label: 'OAuth2 client credentials' },
  { value: 'hmac', label: 'HMAC body signature' },
];

function defaultFor(kind: AuthKind): DeliveryAuthConfig {
  switch (kind) {
    case 'none':
      return { kind: 'none' };
    case 'bearer':
      return { kind: 'bearer', token: '' };
    case 'basic':
      return { kind: 'basic', username: '', password: '' };
    case 'oauth2_client_credentials':
      return { kind: 'oauth2_client_credentials', tokenUrl: '', clientId: '', clientSecret: '', scope: '' };
    case 'hmac':
      return { kind: 'hmac', algorithm: 'sha256', secret: '', header: 'X-Signature', signaturePrefix: 'sha256=' };
    default:
      return { kind: 'none' };
  }
}

export function AuthConfigEditor({
  value,
  onChange,
  editing,
}: {
  value: DeliveryAuthConfig;
  onChange: (next: DeliveryAuthConfig) => void;
  editing: boolean;
}): React.JSX.Element {
  const secretHint = editing ? 'Re-enter to save (secrets are never shown)' : undefined;

  return (
    <div className="space-y-3">
      <SelectField
        label="Authentication"
        value={value.kind}
        onChange={(kind) => onChange(defaultFor(kind))}
        options={KIND_OPTIONS}
      />

      {value.kind === 'bearer' && (
        <TextField
          label="Bearer token"
          mono
          value={value.token}
          onChange={(token) => onChange({ ...value, token })}
          hint={secretHint}
        />
      )}

      {value.kind === 'basic' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Username" value={value.username} onChange={(username) => onChange({ ...value, username })} />
          <TextField label="Password" type="password" mono value={value.password} onChange={(password) => onChange({ ...value, password })} hint={secretHint} />
        </div>
      )}

      {value.kind === 'oauth2_client_credentials' && (
        <div className="space-y-3">
          <TextField label="Token URL" mono value={value.tokenUrl} onChange={(tokenUrl) => onChange({ ...value, tokenUrl })} placeholder="https://idp.example/oauth/token" />
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label="Client ID" mono value={value.clientId} onChange={(clientId) => onChange({ ...value, clientId })} />
            <TextField label="Client secret" type="password" mono value={value.clientSecret} onChange={(clientSecret) => onChange({ ...value, clientSecret })} hint={secretHint} />
          </div>
          <TextField label="Scope (optional)" value={value.scope ?? ''} onChange={(scope) => onChange({ ...value, scope })} placeholder="scim provisioning" />
        </div>
      )}

      {value.kind === 'hmac' && (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              label="Algorithm"
              value={value.algorithm}
              onChange={(algorithm) => onChange({ ...value, algorithm })}
              options={[
                { value: 'sha256', label: 'SHA-256' },
                { value: 'sha512', label: 'SHA-512' },
              ]}
            />
            <TextField label="Signature header" mono value={value.header} onChange={(header) => onChange({ ...value, header })} placeholder="X-Signature" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label="Shared secret" type="password" mono value={value.secret} onChange={(secret) => onChange({ ...value, secret })} hint={secretHint} />
            <TextField label="Signature prefix (optional)" mono value={value.signaturePrefix ?? ''} onChange={(signaturePrefix) => onChange({ ...value, signaturePrefix })} placeholder="sha256=" />
          </div>
        </div>
      )}

      {value.kind === 'none' && (
        <p className="flex items-center gap-1.5 text-xs text-[var(--ink-3)]">
          <Icon name="info" size={13} /> No credentials attached to outbound requests.
        </p>
      )}
    </div>
  );
}
