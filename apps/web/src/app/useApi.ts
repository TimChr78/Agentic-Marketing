import { type DependencyList, useCallback, useEffect, useRef, useState } from 'react';
import { errText } from './api';

/**
 * Loads data with `fn` when `deps` change. Returns { data, error, loading, reload, setData }.
 * Keeps the previous data while reloading, so lists do not flash to a skeleton on refresh.
 */
export function useApi<T>(fn: () => Promise<T>, deps: DependencyList, opts: { skip?: boolean } = {}) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!opts.skip);
  const seq = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the caller's
  const run = useCallback(async () => {
    if (opts.skip) return;
    const n = ++seq.current;
    setLoading(true);
    try {
      const v = await fn();
      if (n === seq.current) {
        setData(v);
        setError(null);
      }
    } catch (e) {
      if (n === seq.current) setError(errText(e));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [...deps, opts.skip]);
  useEffect(() => {
    void run();
  }, [run]);
  return { data, error, loading: loading && data === undefined, refreshing: loading, reload: run, setData };
}

/**
 * Like `useApi`, but every result carries the selection key it was requested for. Data from an
 * older key is withheld while the new read is pending, so a new selection never shows an old
 * value under its own label. An error is tied to its key in the same way; a result that loaded
 * independently of the others stays visible.
 */
export function useKeyedApi<T>(key: string, fn: () => Promise<T>, opts: { skip?: boolean } = {}) {
  const read = useApi<{ key: string; data?: T; error?: string }>(
    async () => {
      try {
        return { key, data: await fn() };
      } catch (e) {
        return { key, error: errText(e) };
      }
    },
    [key],
    opts,
  );
  const current = read.data?.key === key ? read.data : undefined;
  return {
    data: current?.data,
    error: current?.error ?? null,
    loading: !opts.skip && !current,
    refreshing: read.refreshing,
    reload: read.reload,
    setData: (value: T | undefined) => read.setData(value === undefined ? undefined : { key, data: value }),
  };
}

/** Wraps an action: tracks pending state, and reports errors to `onError`. */
export function useAction<A extends unknown[], R>(fn: (...a: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (...a: A): Promise<R | undefined> => {
      setPending(true);
      setError(null);
      try {
        return await fn(...a);
      } catch (e) {
        setError(errText(e));
        throw e;
      } finally {
        setPending(false);
      }
    },
    [fn],
  );
  return { run, pending, error, setError };
}
