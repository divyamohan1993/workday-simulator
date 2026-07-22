import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Minimal data-fetching hook with loading/error/refetch and automatic abort on
 * unmount or dependency change. Chosen over a query library because the control
 * plane has few, simple reads and we avoid a heavy cache dependency; mutations
 * simply call the API then `refetch()`.
 *
 * The fetcher receives an AbortSignal; aborted requests never set state, so a
 * fast view switch cannot flash a stale error.
 */

export interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  /** True until the first settle, so callers can show a first-load skeleton. */
  initialLoading: boolean;
  refetch: () => void;
}

export function useAsync<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: ReadonlyArray<unknown>,
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [settledOnce, setSettledOnce] = useState<boolean>(false);
  const [reloadCount, setReloadCount] = useState<number>(0);

  // Keep the latest fetcher without making it a dependency (callers pass inline fns).
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError(null);

    fetcherRef.current(controller.signal)
      .then((result) => {
        if (!active) return;
        setData(result);
        setLoading(false);
        setSettledOnce(true);
      })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
        setSettledOnce(true);
      });

    return () => {
      active = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, reloadCount]);

  const refetch = useCallback(() => setReloadCount((c) => c + 1), []);

  return { data, error, loading, initialLoading: loading && !settledOnce, refetch };
}
