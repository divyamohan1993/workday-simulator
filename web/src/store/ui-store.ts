import { create } from 'zustand';
import type { StatusTone } from '@/lib/palette';
import type { ViewId } from '@/lib/constants';

/**
 * Global UI state: the active view (mirrored to the URL hash so refresh and
 * deep-links work), the mobile nav drawer, and a transient toast queue.
 */

export interface Toast {
  id: string;
  tone: StatusTone;
  title: string;
  message?: string;
}

const VALID_VIEWS: ViewId[] = ['dashboard', 'scenarios', 'targets', 'history'];

/** Read a valid ViewId from the location hash, defaulting to the dashboard. */
export function viewFromHash(): ViewId {
  if (typeof window === 'undefined') return 'dashboard';
  const raw = window.location.hash.replace(/^#\/?/, '') as ViewId;
  return VALID_VIEWS.includes(raw) ? raw : 'dashboard';
}

let toastSeq = 0;

interface UiState {
  view: ViewId;
  mobileNavOpen: boolean;
  toasts: Toast[];

  setView: (view: ViewId) => void;
  syncViewFromHash: () => void;
  setMobileNavOpen: (open: boolean) => void;
  pushToast: (toast: Omit<Toast, 'id'>, ttlMs?: number) => string;
  dismissToast: (id: string) => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  view: viewFromHash(),
  mobileNavOpen: false,
  toasts: [],

  setView: (view) => {
    if (typeof window !== 'undefined') {
      // Update the hash without adding a history entry per keystroke of navigation.
      window.location.hash = `/${view}`;
    }
    set({ view, mobileNavOpen: false });
  },
  syncViewFromHash: () => set({ view: viewFromHash() }),
  setMobileNavOpen: (open) => set({ mobileNavOpen: open }),

  pushToast: (toast, ttlMs = 6000) => {
    const id = `t${++toastSeq}`;
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
    if (ttlMs > 0) {
      setTimeout(() => get().dismissToast(id), ttlMs);
    }
    return id;
  },
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));
