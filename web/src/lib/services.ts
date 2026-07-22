import { ApiError, createApiClient, type ApiClient } from '@/lib/api-client';
import { TelemetrySocket } from '@/lib/ws-client';
import { clearToken, getToken, setToken } from '@/lib/token';
import { useAuthStore } from '@/store/auth-store';
import { useTelemetryStore } from '@/store/telemetry-store';
import { useUiStore } from '@/store/ui-store';

/**
 * The application service layer: the single place that owns the API client and
 * telemetry socket singletons and the async flows that cross store boundaries
 * (sign-in, session expiry, telemetry lifecycle). Stores stay pure; components
 * call these functions. This module imports the stores, and the stores never
 * import it, so there is no cycle.
 */

/** A 401 on any authenticated call drops a live session back to the gate, once. */
function handleUnauthorized(): void {
  if (useAuthStore.getState().status !== 'authed') return; // sign-in owns its own 401s
  stopTelemetry();
  clearToken();
  useAuthStore.getState().setExpired('Your session ended. Sign in again.');
  useUiStore.getState().pushToast({
    tone: 'warning',
    title: 'Session ended',
    message: 'Re-enter the admin token to continue.',
  });
}

/** The shared, typed REST client. Reads the token fresh on every request. */
export const api: ApiClient = createApiClient({
  getToken,
  onUnauthorized: handleUnauthorized,
});

let socket: TelemetrySocket | null = null;

/** Open (or re-open) the telemetry stream and wire it into the telemetry store. */
export function startTelemetry(): void {
  if (!socket) {
    socket = new TelemetrySocket({
      getToken,
      onStatus: (s) => useTelemetryStore.getState().setStatus(s),
      onHello: (ms) => useTelemetryStore.getState().setMetricsInterval(ms),
      onFrame: (f) => useTelemetryStore.getState().ingestFrame(f),
      onRun: (r) => useTelemetryStore.getState().ingestRun(r),
      onServerError: (_error, code) => {
        if (code === 'ws_unauthorized') handleUnauthorized();
      },
    });
  }
  socket.connect();
}

/** Close the telemetry stream. */
export function stopTelemetry(): void {
  socket?.close();
  useTelemetryStore.getState().setStatus('closed');
}

/** Human-readable reason for a failed sign-in attempt. */
function describeAuthError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) {
      return 'Too many attempts from this address. Wait a moment, then try again.';
    }
    if (err.status === 401) return 'That admin token was rejected.';
    if (err.code === 'network_error') {
      return 'Cannot reach the simulator server. Check that it is running.';
    }
    return err.message;
  }
  return 'Unexpected error while signing in.';
}

/**
 * Validate a candidate admin token against GET /api/config (the lightest
 * authenticated endpoint, which also returns the bootstrap config). On success,
 * persist the token and open telemetry; on failure, clear it and surface why.
 */
export async function signIn(candidate: string): Promise<void> {
  const token = candidate.trim();
  const auth = useAuthStore.getState();
  if (!token) {
    auth.setError('Enter the admin token to continue.');
    return;
  }
  setToken(token);
  auth.setChecking();
  try {
    const config = await api.getConfig();
    useAuthStore.getState().setAuthed(config);
    startTelemetry();
  } catch (err) {
    clearToken();
    stopTelemetry();
    useAuthStore.getState().setError(describeAuthError(err));
  }
}

/** Explicit sign-out: purge the token and all live state. */
export function signOut(): void {
  stopTelemetry();
  clearToken();
  useTelemetryStore.getState().reset();
  useAuthStore.getState().reset();
}

/** On first load, re-validate any token carried over from a prior tab session. */
export async function bootstrapSession(): Promise<void> {
  const existing = getToken();
  if (existing) {
    await signIn(existing);
  }
}
