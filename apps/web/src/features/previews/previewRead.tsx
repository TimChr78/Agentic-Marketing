import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { errText } from '../../app/api';

// Phase 25 review reads: one result per command + input, shared between the consequence summary
// and the renderer that shows the same thing (a template is previewed and checked once, not
// twice). The cache lives with the open drawer; every entry is keyed by its exact input, so a
// different version or content revision can never inherit the previous result (#498/#499).

export interface ReadSnapshot<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  refreshing: boolean;
}

interface Entry {
  snapshot: ReadSnapshot<unknown>;
  promise: Promise<void> | null;
  listeners: Set<() => void>;
}

const EMPTY: ReadSnapshot<never> = { data: undefined, error: null, loading: false, refreshing: false };

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`;
}

/** The cache key: the command plus its exact input, with object keys in a stable order. */
export function readKey(command: string, input: unknown): string {
  return `${command}:${stableJson(input)}`;
}

function emit(entry: Entry) {
  for (const listener of entry.listeners) listener();
}

export class PreviewReadCache {
  private entries = new Map<string, Entry>();
  private entry(key: string): Entry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        snapshot: { data: undefined, error: null, loading: true, refreshing: false },
        promise: null,
        listeners: new Set(),
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  peek<T>(key: string): ReadSnapshot<T> {
    return this.entry(key).snapshot as ReadSnapshot<T>;
  }

  subscribe(key: string, listener: () => void) {
    const entry = this.entry(key);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }

  private start<T>(entry: Entry, fn: () => Promise<T>) {
    const first = entry.snapshot.data === undefined && entry.snapshot.error === null;
    entry.snapshot = {
      ...entry.snapshot,
      loading: first,
      refreshing: !first,
      ...(first ? { error: null } : {}),
    };
    emit(entry);
    entry.promise = Promise.resolve()
      .then(fn)
      .then(
        (data) => {
          entry.snapshot = { data, error: null, loading: false, refreshing: false };
        },
        (error) => {
          entry.snapshot = { ...entry.snapshot, error: errText(error), loading: false, refreshing: false };
        },
      )
      .finally(() => {
        entry.promise = null;
        emit(entry);
      });
  }

  /**
   * Reads only when this key has no settled result yet. A renderer that mounts after the summary
   * joins the same result instead of issuing a second request.
   */
  load<T>(key: string, fn: () => Promise<T>) {
    const entry = this.entry(key);
    if (entry.promise || entry.snapshot.data !== undefined || entry.snapshot.error !== null) return;
    this.start(entry, fn);
  }

  /** Re-runs the read and keeps the previous result visible while it refreshes. */
  refresh<T>(key: string, fn: () => Promise<T>) {
    const entry = this.entry(key);
    if (entry.promise) return;
    this.start(entry, fn);
  }

  clear() {
    for (const entry of this.entries.values()) entry.listeners.clear();
    this.entries.clear();
  }
}

const CacheContext = createContext<PreviewReadCache | null>(null);

/** Scopes preview reads to one open review. */
export function PreviewReadProvider({ children }: { children: ReactNode }) {
  const [cache] = useState(() => new PreviewReadCache());
  useEffect(() => () => cache.clear(), [cache]);
  return <CacheContext.Provider value={cache}>{children}</CacheContext.Provider>;
}

/**
 * A keyed read: the previous key's data is never returned for the new key, so a new provenance
 * label can never sit over the previous render. Without a provider each component gets a small
 * private cache; inside the approval drawer the provider shares one result per command + input.
 */
export function useSharedRead<T>(
  command: string,
  input: unknown,
  fn: () => Promise<T>,
  opts: { skip?: boolean } = {},
): ReadSnapshot<T> & { refresh: () => void } {
  const shared = useContext(CacheContext);
  const [fallback] = useState(() => new PreviewReadCache());
  const cache = shared ?? fallback;
  const key = opts.skip ? null : readKey(command, input);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const subscribe = useCallback((listener: () => void) => (key ? cache.subscribe(key, listener) : () => {}), [cache, key]);
  const getSnapshot = useCallback(() => (key ? cache.peek<T>(key) : (EMPTY as ReadSnapshot<T>)), [cache, key]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (key) cache.load(key, () => fnRef.current());
  }, [cache, key]);
  const refresh = useCallback(() => {
    if (key) cache.refresh(key, () => fnRef.current());
  }, [cache, key]);
  return { ...snapshot, refresh };
}
