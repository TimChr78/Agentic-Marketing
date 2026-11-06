import { useWorkspace } from '../../app/session';
import { useApi } from '../../app/useApi';
import { onArtifactsChanged } from '../artifactCache';
import { fetchAllArtifacts } from '../artifacts/artifactList';

// One name cache per workspace and artifact type (#448). The broadcast list resolves every visible
// segmentId from this shared paginated `artifacts.list` read instead of an `artifacts.get` per row;
// the detail page reuses the same caches for its segment and template references. A failed read is
// dropped so a later screen can try again, and never fails the table that embeds it.
//
// The map must not outlive a change to what it names (#459, #486): every artifact create, rename,
// save, publish or delete clears it through `onArtifactsChanged`. A short TTL is the backstop for
// changes made by another tab, an agent or the API, which this tab never hears about.

export interface ArtifactName {
  name: string;
  type: string;
  latestVersion: number;
}

/** A stale name is corrected after at most this long even with no local mutation. */
export const ARTIFACT_NAME_TTL_MS = 30_000;

interface CachedNames {
  promise: Promise<Map<string, ArtifactName>>;
  at: number;
}

const caches = new Map<string, CachedNames>();

export function artifactNameCache(workspaceId: string, type: string): Promise<Map<string, ArtifactName>> {
  const key = `${workspaceId}:${type}`;
  const existing = caches.get(key);
  if (existing && Date.now() - existing.at < ARTIFACT_NAME_TTL_MS) return existing.promise;
  const promise = fetchAllArtifacts(type)
    .then((page) => new Map(page.artifacts.map((a) => [a.id, { name: a.name, type: a.type, latestVersion: a.latestVersion }])))
    .catch((error: unknown) => {
      caches.delete(key);
      throw error;
    });
  caches.set(key, { promise, at: Date.now() });
  return promise;
}

/** Forget every resolved name map; the next consumer reads the references again. */
export function invalidateArtifactNames() {
  caches.clear();
}

onArtifactsChanged(invalidateArtifactNames);

/** Test helper: forget every workspace's cached names. */
export function clearArtifactNameCache() {
  invalidateArtifactNames();
}

export function useArtifactNames(type: string, opts: { skip?: boolean } = {}) {
  const { workspace } = useWorkspace();
  return useApi(() => artifactNameCache(workspace.id, type), [workspace.id, type], { skip: opts.skip });
}
