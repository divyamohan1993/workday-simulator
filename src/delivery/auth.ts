/**
 * Per-target authentication for HTTP deliveries.
 *
 * Supported schemes (union `DeliveryAuthConfig`):
 * - none   : no credential applied.
 * - bearer : `Authorization: Bearer <token>`.
 * - basic  : `Authorization: Basic base64(user:pass)`.
 * - oauth2 : client-credentials grant; the token is fetched once and cached
 *            until just before expiry, with single-flight refresh so a burst of
 *            concurrent sends triggers exactly one token request.
 * - hmac   : an HMAC over the EXACT request body is written to a configured
 *            header, optionally with a prefix (e.g. "sha256=").
 *
 * SECURITY: secrets (tokens, passwords, client secrets, HMAC keys) are NEVER
 * logged. On an OAuth error only the HTTP status is logged, never the response
 * body (which could echo a credential). HMAC uses Node's vetted crypto, never a
 * hand-rolled construction.
 */

import { createHmac } from 'node:crypto';
import type { Logger } from 'pino';
import type { DeliveryAuthConfig } from '../types/index.js';
import { CONTENT_TYPE, OAUTH_DEFAULT_TTL_SEC, OAUTH_EXPIRY_SKEW_SEC } from './constants.js';
import { DeliveryNetworkError } from './errors.js';
import type { Authenticator, HttpRequestSpec, HttpTransport } from './types.js';

/** Dependencies an authenticator needs (OAuth uses the shared transport). */
export interface AuthDeps {
  transport: HttpTransport;
  logger: Logger;
  now?: () => number;
  /** Timeout for the OAuth token request. */
  tokenTimeoutMs?: number;
}

/** No-op authenticator for `{ kind: 'none' }`. */
const NONE_AUTH: Authenticator = {
  async apply(): Promise<void> {
    /* nothing to apply */
  },
  invalidate(): void {
    /* no cached state */
  },
  stop(): void {
    /* no resources */
  },
};

/** Set the Authorization header to a fixed value (bearer/basic). */
function staticHeaderAuth(value: string): Authenticator {
  return {
    async apply(spec: HttpRequestSpec): Promise<void> {
      spec.headers.authorization = value;
    },
    invalidate(): void {
      /* static credential, nothing to drop */
    },
    stop(): void {
      /* no resources */
    },
  };
}

/** Build the `Authorization: Basic` value without leaking the password anywhere else. */
function basicHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

/** HMAC-body-signing authenticator. */
function hmacAuth(
  config: Extract<DeliveryAuthConfig, { kind: 'hmac' }>,
): Authenticator {
  const headerName = config.header.toLowerCase();
  const prefix = config.signaturePrefix ?? '';
  return {
    async apply(spec: HttpRequestSpec): Promise<void> {
      // Sign the exact bytes that will be transmitted; an empty body signs "".
      const signature = createHmac(config.algorithm, config.secret)
        .update(spec.body ?? '')
        .digest('hex');
      spec.headers[headerName] = `${prefix}${signature}`;
    },
    invalidate(): void {
      /* no cached state */
    },
    stop(): void {
      /* no resources */
    },
  };
}

/** Cached OAuth token state. */
interface TokenState {
  accessToken: string;
  /** Wall time (ms) after which the token must be refreshed. */
  expiresAtMs: number;
}

/** OAuth2 client-credentials authenticator with single-flight caching. */
function oauthClientCredentialsAuth(
  config: Extract<DeliveryAuthConfig, { kind: 'oauth2_client_credentials' }>,
  deps: AuthDeps,
): Authenticator {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.tokenTimeoutMs ?? 15_000;
  let cached: TokenState | undefined;
  let inFlight: Promise<TokenState> | undefined;

  async function fetchToken(): Promise<TokenState> {
    const params = new URLSearchParams({ grant_type: 'client_credentials' });
    if (config.scope) params.set('scope', config.scope);
    const authHeader = basicHeader(config.clientId, config.clientSecret);

    const response = await deps.transport.send(
      {
        method: 'POST',
        url: config.tokenUrl,
        headers: {
          'content-type': CONTENT_TYPE.form,
          accept: CONTENT_TYPE.json,
          authorization: authHeader,
        },
        body: params.toString(),
      },
      { timeoutMs },
    );

    if (response.status < 200 || response.status >= 300) {
      // Never log the body: token endpoints may echo client identifiers.
      deps.logger.warn({ status: response.status, tokenUrl: config.tokenUrl }, 'oauth token request failed');
      throw new DeliveryNetworkError(`oauth token request failed with status ${response.status}`);
    }

    let parsed: { access_token?: unknown; expires_in?: unknown };
    try {
      parsed = JSON.parse(response.body) as typeof parsed;
    } catch {
      throw new DeliveryNetworkError('oauth token response was not valid JSON');
    }
    if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
      throw new DeliveryNetworkError('oauth token response missing access_token');
    }
    const ttlSec = typeof parsed.expires_in === 'number' && parsed.expires_in > 0
      ? parsed.expires_in
      : OAUTH_DEFAULT_TTL_SEC;
    const expiresAtMs = now() + Math.max(1, ttlSec - OAUTH_EXPIRY_SKEW_SEC) * 1000;
    return { accessToken: parsed.access_token, expiresAtMs };
  }

  async function getToken(): Promise<string> {
    if (cached && now() < cached.expiresAtMs) return cached.accessToken;
    // Single-flight: concurrent callers share one refresh.
    if (!inFlight) {
      inFlight = fetchToken()
        .then((state) => {
          cached = state;
          return state;
        })
        .finally(() => {
          inFlight = undefined;
        });
    }
    const state = await inFlight;
    return state.accessToken;
  }

  return {
    async apply(spec: HttpRequestSpec): Promise<void> {
      const token = await getToken();
      spec.headers.authorization = `Bearer ${token}`;
    },
    invalidate(): void {
      cached = undefined;
    },
    stop(): void {
      cached = undefined;
      inFlight = undefined;
    },
  };
}

/**
 * Build an {@link Authenticator} for a target's auth config.
 *
 * @param auth The target's auth configuration.
 * @param deps Transport (for OAuth), logger and injectable clock.
 * @returns An authenticator that mutates outbound request headers/body.
 */
export function createAuthenticator(auth: DeliveryAuthConfig, deps: AuthDeps): Authenticator {
  switch (auth.kind) {
    case 'none':
      return NONE_AUTH;
    case 'bearer':
      return staticHeaderAuth(`Bearer ${auth.token}`);
    case 'basic':
      return staticHeaderAuth(basicHeader(auth.username, auth.password));
    case 'hmac':
      return hmacAuth(auth);
    case 'oauth2_client_credentials':
      return oauthClientCredentialsAuth(auth, deps);
    default: {
      // Exhaustiveness guard: a new auth kind must be handled here.
      const _exhaustive: never = auth;
      void _exhaustive;
      return NONE_AUTH;
    }
  }
}
