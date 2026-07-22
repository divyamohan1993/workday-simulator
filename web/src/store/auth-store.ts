import { create } from 'zustand';
import type { AppConfigResponse } from '@/lib/api-types';

/**
 * Auth gate state. Deliberately pure UI state: the token secret itself lives in
 * `lib/token.ts`, and the async sign-in orchestration lives in `lib/services.ts`
 * (which owns the API client). This store only tracks what the gate needs to
 * render and the bootstrap config payload returned by GET /api/config.
 */

export type AuthStatus = 'locked' | 'checking' | 'authed' | 'error' | 'expired';

interface AuthState {
  status: AuthStatus;
  error: string | null;
  /** Server config (doubles as the sign-in validation payload). */
  config: AppConfigResponse | null;

  setChecking: () => void;
  setAuthed: (config: AppConfigResponse) => void;
  setError: (message: string) => void;
  setExpired: (message: string) => void;
  reset: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: 'locked',
  error: null,
  config: null,

  setChecking: () => set({ status: 'checking', error: null }),
  setAuthed: (config) => set({ status: 'authed', error: null, config }),
  setError: (message) => set({ status: 'error', error: message }),
  setExpired: (message) => set({ status: 'expired', error: message, config: null }),
  reset: () => set({ status: 'locked', error: null, config: null }),
}));
