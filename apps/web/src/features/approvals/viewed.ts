import { useSyncExternalStore } from 'react';

// "Not yet viewed" (#41): a reviewer must open the preview of the exact version before approving
// it in a batch. Kept per person on this device (DECISIONS.md D9): it is a reviewing aid, not an
// audit record; the approval itself is what the audit log records.

const listeners = new Set<() => void>();
const key = (userId: string, approvalId: string, version: number) => `am.viewed.${userId}.${approvalId}.v${version}`;

export function markViewed(userId: string, approvalId: string, version: number) {
  const k = key(userId, approvalId, version);
  if (localStorage.getItem(k)) return;
  localStorage.setItem(k, new Date().toISOString());
  for (const l of listeners) l();
}
export function wasViewed(userId: string, approvalId: string, version: number): boolean {
  return !!localStorage.getItem(key(userId, approvalId, version));
}

let tick = 0;
const subscribe = (l: () => void) => {
  const wrapped = () => {
    tick++;
    l();
  };
  listeners.add(wrapped);
  window.addEventListener('storage', wrapped);
  return () => {
    listeners.delete(wrapped);
    window.removeEventListener('storage', wrapped);
  };
};
/** Re-renders when anything is marked viewed. */
export function useViewedTick() {
  return useSyncExternalStore(subscribe, () => tick);
}
