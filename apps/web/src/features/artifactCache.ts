import { useEffect, useState } from 'react';
import { api, type Out } from '../app/api';

// Names (and published versions) of referenced artifacts, e.g. the template and segment of a
// broadcast. Cached for the session; `invalidateArtifact` drops an entry after a change.

type Got = Out<'artifacts.get'>;
const cache = new Map<string, Promise<Got>>();

export function getArtifact(id: string): Promise<Got> {
  let p = cache.get(id);
  if (!p) {
    p = api.call('artifacts.get', { artifactId: id });
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return p;
}
export const invalidateArtifact = (id: string) => cache.delete(id);

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
  return (id: string) => names[id];
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
