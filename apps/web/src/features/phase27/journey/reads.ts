import { api, getWorkspaceId } from '../../../app/api';

// Reads the journey inspector repeats across selections. The shared picker index already covers
// artifact selectors; these three workspace lists are not artifacts, so they get the same
// "once per workspace" treatment: selecting another step of the same kind or returning to a step
// reuses the result instead of reading again (#528).

const shared = new Map<string, Promise<unknown>>();

export function sharedRead<T>(key: string, load: () => Promise<T>): Promise<T> {
  const cached = shared.get(key) as Promise<T> | undefined;
  if (cached) return cached;
  const read = load();
  shared.set(key, read);
  // A failed read is not a result: the next selection tries again.
  read.catch(() => shared.delete(key));
  return read;
}

const workspaceKey = () => getWorkspaceId() ?? '';

export const trackingPlanList = () =>
  sharedRead(`tracking_plan:${workspaceKey()}`, () => api.call('artifacts.list', { type: 'tracking_plan', limit: 1 }));

export const trackingPlan = (id: string) =>
  sharedRead(`tracking_plan_artifact:${workspaceKey()}:${id}`, () => api.call('artifacts.get', { artifactId: id }));

export const webhookList = () => sharedRead(`webhooks:${workspaceKey()}`, () => api.call('webhooks.list', {}));

export const connectionList = () => sharedRead(`connections:${workspaceKey()}`, () => api.call('connections.list', {}));

/** Test seam: forget the shared reads. */
export function resetSharedReads() {
  shared.clear();
}
