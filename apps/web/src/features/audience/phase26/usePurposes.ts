import { useCallback, useEffect, useState } from 'react';
import { api, errText, type Out } from '../../../app/api';
import { useSession } from '../../../app/session';

// Purpose names and lawful bases are workspace artifacts. The list reads them once and hands them
// to the person page through this small cache, so opening a person from the list does not repeat
// the read. A direct link to a person reads them once for itself.

export type Purposes = Out<'purposes.list'>;

let cache: { workspaceId: string | null; value: Purposes } | null = null;

export function resetPurposesCache() {
  cache = null;
}

export function cachedPurposes(workspaceId: string | null): Purposes | undefined {
  return cache && cache.workspaceId === workspaceId ? cache.value : undefined;
}

/**
 * Loads `purposes.list` at most once per workspace. `always` is for the list page, whose contract
 * is one read per mount; the person page reuses the cache and only reads when it arrived directly.
 */
export function usePurposes({ enabled, always = false }: { enabled: boolean; always?: boolean }) {
  const { workspace } = useSession();
  const workspaceId = workspace?.id ?? null;
  const [data, setData] = useState<Purposes | undefined>(() => (enabled ? cachedPurposes(workspaceId) : undefined));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled && !cachedPurposes(workspaceId));

  const load = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      const value = await api.call('purposes.list', {});
      cache = { workspaceId, value };
      setData(value);
      setError(null);
    } catch (e) {
      // Names become unavailable; the caller keeps every raw key behind a copy control.
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [enabled, workspaceId]);

  useEffect(() => {
    if (!enabled) {
      setData(undefined);
      setError(null);
      setLoading(false);
      return;
    }
    const cached = cachedPurposes(workspaceId);
    if (cached) {
      setData(cached);
      setLoading(false);
      if (!always) return;
    }
    void load();
  }, [enabled, always, load, workspaceId]);

  return { data, error, loading, reload: load };
}
