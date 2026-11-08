import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { errText, getWorkspaceId, onWorkspaceChange } from '../../app/api';
import { type ArtifactListLoader, type ArtifactPage, type ArtifactRow, artifactListLoader, fetchAllArtifactPages } from './artifactList';

// The shared picker index (#524): one bounded, complete list per artifact type per workspace, so a
// picker never reads `artifacts.get` per row and repeated selectors never fan out. `shared.md` fixes
// the read: `artifacts.list({type, limit: 200, cursor?})` once per returned page, sequential cursors,
// with the existing 100-page guard. The index is cached for the session, exposed with its honest
// total and completeness, and refreshed only through its exact keys.
//
// Keying: `${workspaceId}:${type}`. A version change (save, discard, publish) drops every loaded
// index of that workspace whose rows contain the artifact; a create drops only the one type it
// created. No other workspace or type is refetched.

export interface PickerIndex extends ArtifactPage {}

export interface PickerIndexState {
  /** The loaded rows; undefined until the first successful read. */
  data: PickerIndex | undefined;
  /** The server's honest total for the filter; 0 until the first result arrives. */
  total: number;
  /** False when the page guard stopped the load before the server ran out of rows. */
  complete: boolean;
  loading: boolean;
  /** The last read's message, kept until a retry succeeds. */
  error: string | null;
  /** Repeats L(type): the only way the index is refreshed. */
  reload: () => Promise<void>;
}

interface Entry {
  data?: PickerIndex;
  error: string | null;
  loading: boolean;
  promise: Promise<PickerIndex> | null;
  listeners: Set<() => void>;
  snapshot: PickerIndexState;
}

const EMPTY_SNAPSHOT: PickerIndexState = {
  data: undefined,
  total: 0,
  complete: false,
  loading: true,
  error: null,
  reload: async () => {},
};

const entries = new Map<string, Entry>();

export function pickerIndexKey(workspaceId: string, type: string): string {
  return `${workspaceId}:${type}`;
}

function snapshotOf(entry: Entry | undefined): PickerIndexState {
  return entry ? entry.snapshot : EMPTY_SNAPSHOT;
}

function makeSnapshot(entry: Entry): PickerIndexState {
  return {
    data: entry.data,
    total: entry.data?.total ?? 0,
    complete: entry.data?.complete ?? false,
    loading: entry.loading,
    error: entry.error,
    reload: async () => {},
  };
}

function entryFor(key: string): Entry {
  let entry = entries.get(key);
  if (!entry) {
    entry = { error: null, loading: true, promise: null, listeners: new Set(), snapshot: snapshotOf(undefined) };
    entries.set(key, entry);
  }
  return entry;
}

function emit(entry: Entry) {
  entry.snapshot = makeSnapshot(entry);
  for (const listener of entry.listeners) listener();
}

function subscribe(key: string, listener: () => void) {
  const entry = entryFor(key);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    // An unmounted selector leaves no reason to keep an index alive; the next mount reads it again.
    // A cached index without listeners is dropped only when it is invalidated, never on unmount.
  };
}

function snapshot(key: string): PickerIndexState {
  return snapshotOf(entries.get(key));
}

/** The index currently cached for this exact workspace and type, if any. */
export function peekPickerIndex(workspaceId: string, type: string): PickerIndex | undefined {
  return entries.get(pickerIndexKey(workspaceId, type))?.data;
}

/**
 * Reads the shared index, or returns the cached one. Concurrent selectors share one in-flight read.
 * `load` is for tests and the demo; pages always use the real `artifacts.list`.
 */
export function readPickerIndex(workspaceId: string, type: string, opts: { load?: ArtifactListLoader } = {}): Promise<PickerIndex> {
  const entry = entryFor(pickerIndexKey(workspaceId, type));
  if (entry.data) return Promise.resolve(entry.data);
  if (entry.promise) return entry.promise;
  const load = opts.load ?? artifactListLoader;
  entry.loading = true;
  entry.error = null;
  entry.snapshot = makeSnapshot(entry);
  emit(entry);
  const promise = fetchAllArtifactPages(load, type).then(
    (page) => {
      if (entries.get(pickerIndexKey(workspaceId, type)) !== entry) return page;
      entry.data = page;
      entry.error = null;
      entry.loading = false;
      entry.promise = null;
      emit(entry);
      return page;
    },
    (error: unknown) => {
      if (entries.get(pickerIndexKey(workspaceId, type)) !== entry) throw error;
      entry.error = errText(error);
      entry.loading = false;
      entry.promise = null;
      emit(entry);
      throw error;
    },
  );
  entry.promise = promise;
  return promise;
}

/** Repeats the index read; the only cache the pickers ever refresh. */
export function refreshPickerIndex(workspaceId: string, type: string, opts: { load?: ArtifactListLoader } = {}) {
  const key = pickerIndexKey(workspaceId, type);
  const entry = entries.get(key);
  if (entry) {
    entry.data = undefined;
    entry.promise = null;
  }
  return readPickerIndex(workspaceId, type, opts);
}

function reloadEntry(workspaceId: string, type: string) {
  const key = pickerIndexKey(workspaceId, type);
  const entry = entries.get(key);
  if (!entry) return;
  // Mounted selectors see the drop and start the next read immediately; an idle index is simply
  // forgotten, so its next mount reads once instead of showing old rows.
  entry.data = undefined;
  entry.error = null;
  entry.promise = null;
  entry.loading = true;
  emit(entry);
  if (entry.listeners.size > 0) void readPickerIndex(workspaceId, type).catch(() => {});
  else entries.delete(key);
}

/** Drops the exact workspace/type key, e.g. after creating a new artifact of that type. */
export function invalidatePickerIndex(workspaceId: string, type: string) {
  reloadEntry(workspaceId, type);
}

/**
 * Drops the exact keys that hold a new version of this artifact: its workspace's loaded indexes
 * whose rows contain its id. A create adds a row no index knows about yet; use
 * `invalidatePickerIndex` for that. Nothing else is refetched.
 */
export function invalidatePickerArtifact(workspaceId: string, artifactId: string) {
  for (const [key, entry] of entries) {
    if (!key.startsWith(`${workspaceId}:`)) continue;
    if (!entry.data?.artifacts.some((a: ArtifactRow) => a.id === artifactId)) continue;
    reloadEntry(workspaceId, key.slice(workspaceId.length + 1));
  }
}

/** Test and workspace-switch seam: forget every index. */
export function resetPickerIndexes() {
  entries.clear();
}

/** The shared picker index for one type in the current workspace. */
export function usePickerIndex(type: string): PickerIndexState {
  const workspaceId = useSyncExternalStore(onWorkspaceChange, getWorkspaceId, getWorkspaceId);
  const key = pickerIndexKey(workspaceId ?? '', type);
  const state = useSyncExternalStore(
    (listener) => subscribe(key, listener),
    () => snapshot(key),
    () => snapshot(key),
  );
  // Every selector asks for the same key, so mounting several of them still starts one read.
  useEffect(() => {
    if (!workspaceId) return;
    void readPickerIndex(workspaceId, type).catch(() => {});
  }, [workspaceId, type]);
  const reload = useCallback(
    () => (workspaceId ? refreshPickerIndex(workspaceId, type).then(() => undefined) : Promise.resolve()),
    [workspaceId, type],
  );
  return { ...state, reload };
}

/** The type-only seam A and J can use without importing a component. */
export type { ArtifactListLoader, ArtifactPage };
