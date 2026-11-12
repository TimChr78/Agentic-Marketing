import { useCallback, useEffect, useState } from 'react';
import { api, type Out } from '../app/api';

// Names (and published versions) of referenced artifacts, e.g. the template and segment of a
// broadcast. Cached for the session; `invalidateArtifact` drops an entry after a change.

type Got = Out<'artifacts.get'>;
const cache = new Map<string, Promise<Got>>();

/** The artifact a change named, or undefined when the caller could not name one. */
type ArtifactChangeListener = (id?: string) => void;
const listeners = new Set<ArtifactChangeListener>();

/**
 * Registers a cache that must be dropped whenever an artifact is created, renamed, saved,
 * published or deleted. The listener receives the changed artifact's id when the change named one,
 * so a cache that only reads some artifacts can ignore unrelated writes (#768). Returns an
 * unsubscribe.
 */
export function onArtifactsChanged(listener: ArtifactChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Tells every registered cache that artifacts changed, e.g. after `artifacts.create`. Pass the
 * changed id whenever it is known; `undefined` means "unknown" and reaches every listener, which is
 * the safe fallback for a create whose id the caller did not keep.
 */
export function notifyArtifactsChanged(id?: string) {
  for (const listener of listeners) listener(id);
}

export function getArtifact(id: string): Promise<Got> {
  let p = cache.get(id);
  if (!p) {
    p = api.call('artifacts.get', { artifactId: id });
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return p;
}
export const invalidateArtifact = (id: string) => {
  cache.delete(id);
  notifyArtifactsChanged(id);
};

/** Drops one cached read without telling listeners: the next get re-reads, nothing changed. */
export const forgetArtifact = (id: string) => {
  cache.delete(id);
};

export function useArtifactRef(id: string | undefined | null) {
  const [a, setA] = useState<Got | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setA(null);
    setError(null);
    if (!id) return;
    let live = true;
    getArtifact(id)
      .then((v) => live && setA(v))
      .catch((e) => live && setError(e.message ?? 'Not found'));
    return () => {
      live = false;
    };
  }, [id]);
  // A publish, rename or delete in this tab must reach the pill that shows this pointer (#770).
  // The change named the artifact, so an unrelated write never re-reads this one.
  useEffect(() => {
    if (!id) return;
    return onArtifactsChanged((changed) => {
      if (changed && changed !== id) return;
      getArtifact(id)
        .then(setA)
        .catch((e) => setError(e.message ?? 'Not found'));
    });
  }, [id]);
  return { artifact: a, error };
}

/** Names for a set of artifact ids, as a lookup function (undefined while loading). */
export function useArtifactNames(ids: string[]) {
  const key = [...new Set(ids.filter(Boolean))].sort().join(',');
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    for (const id of key ? key.split(',') : [])
      getArtifact(id)
        .then((a) => live && setNames((n) => (n[id] === a.name ? n : { ...n, [id]: a.name })))
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [key]);
  // Same signal as `useArtifactRef`: only a change to one of the named artifacts re-reads (#770),
  // because an unrelated write cannot change a name in this lookup.
  useEffect(
    () =>
      onArtifactsChanged((changed) => {
        const wanted = key ? key.split(',') : [];
        if (changed && !wanted.includes(changed)) return;
        for (const id of wanted)
          getArtifact(id)
            .then((a) => setNames((n) => (n[id] === a.name ? n : { ...n, [id]: a.name })))
            .catch(() => {});
      }),
    [key],
  );
  return useCallback((id: string) => names[id], [names]);
}

/** Artifact ids referenced anywhere in a JSON value (eml_…, seg_…, prm_… and so on). */
export function referencedIds(value: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string' && /^(eml|sms|psh|seg|prm|frm|jrn|bct|exp)_[0-9a-f]{32}$/.test(v)) out.add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return [...out];
}
