import { TOKEN_STORAGE_KEY } from '@/lib/constants';

/**
 * The admin token holder. Kept in a standalone module (not in a store) so both
 * the REST client and the WebSocket client can read it without importing the
 * auth store, which would create an import cycle.
 *
 * Security posture: the token lives in `sessionStorage`, not `localStorage`, so
 * it is scoped to the tab session and cleared on close, limiting the exposure
 * window. It is unavoidably passed as a WebSocket query parameter because
 * browsers cannot set WebSocket request headers (see contract section 5); the
 * compensating controls are the server's nonce-based CSP, the absence of any
 * third-party script on this page, and the short session lifetime. This is an
 * accepted, documented tradeoff for a self-hosted operations console.
 */

let current: string | null = null;

export function getToken(): string | null {
  if (current !== null) return current;
  try {
    current = sessionStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    current = null;
  }
  return current;
}

export function setToken(token: string): void {
  current = token;
  try {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Storage may be unavailable (private mode quota); keep the in-memory copy.
  }
}

export function clearToken(): void {
  current = null;
  try {
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Ignore.
  }
}
