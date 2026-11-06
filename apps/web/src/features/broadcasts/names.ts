import { useWorkspace } from '../../app/session';
import { useApi } from '../../app/useApi';
import { fetchAllArtifacts } from '../artifacts/artifactList';

// One name cache per workspace and artifact type (#448). The broadcast list resolves every visible
// segmentId from this shared paginated `artifacts.list` read instead of an `artifacts.get` per row;
// the detail page reuses the same caches for its segment and template references. A failed read is
// dropped so a later screen can try again, and never fails the table that embeds it.

export interface ArtifactName {
  name: string;
  type: string;
  latestVersion: number;
}

const caches = new Map<string, Promise<Map<string, ArtifactName>>>();

export function artifactNameCache(workspaceId: string, type: string): Promise<Map<string, ArtifactName>> {
  const key = `${workspaceId}:${type}`;
  const existing = caches.get(key);
  if (existing) return existing;
  const promise = fetchAllArtifacts(type)
    .then((page) => new Map(page.artifacts.map((a) => [a.id, { name: a.name, type: a.type, latestVersion: a.latestVersion }])))
    .catch((error: unknown) => {
      caches.delete(key);
      throw error;
    });
  caches.set(key, promise);
  return promise;
}

/** Test helper: forget every workspace's cached names. */
export function clearArtifactNameCache() {
  caches.clear();
}

export function useArtifactNames(type: string, opts: { skip?: boolean } = {}) {
  const { workspace } = useWorkspace();
  return useApi(() => artifactNameCache(workspace.id, type), [workspace.id, type], { skip: opts.skip });
}
