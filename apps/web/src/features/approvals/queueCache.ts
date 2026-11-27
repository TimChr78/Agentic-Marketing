import type { Out } from '../../app/api';

type Approval = Out<'approvals.list'>['approvals'][number];

export interface ApprovalsQueuePage {
  rows: Approval[];
  cursor: string | null;
}

// The route table remounts the Approvals page when a drawer opens (#1254), so the pages loaded past
// the first one live outside the component instance. They are scoped to the signed-in person and
// workspace, so a session change can never read another person's rows (PR #1273 review).
const pages = new Map<string, ApprovalsQueuePage>();
let scope: string | null = null;

const scopeKey = (userId: string, workspaceId: string) => `${userId}|${workspaceId}`;

/** The cache key for one status tab of one person's workspace. */
export function approvalsQueueKey(userId: string | null | undefined, workspaceId: string | null | undefined, status: string) {
  return `${scopeKey(userId ?? '', workspaceId ?? '')}|${status}`;
}

export function readApprovalsQueuePage(key: string): ApprovalsQueuePage | undefined {
  return pages.get(key);
}

export function writeApprovalsQueuePage(key: string, page: ApprovalsQueuePage) {
  pages.set(key, page);
}

/** A decision changes every queue of that workspace, so drop all of its status pages. */
export function dropApprovalsQueueScope(userId: string | null | undefined, workspaceId: string | null | undefined) {
  const prefix = `${scopeKey(userId ?? '', workspaceId ?? '')}|`;
  for (const key of pages.keys()) {
    if (key.startsWith(prefix)) pages.delete(key);
  }
}

/**
 * Called by the Approvals page on render with the signed-in person and workspace. A change of either
 * forgets the previous pages: keeping another person's rows in memory is pointless at best and a
 * leak at worst. The keys carry both ids as well, so a stale page can never be read.
 */
export function setApprovalsQueueScope(userId: string | null, workspaceId: string | null) {
  const next = userId && workspaceId ? scopeKey(userId, workspaceId) : null;
  if (next === scope) return;
  scope = next;
  pages.clear();
}

/** Sign-out and tests: forget every remembered page. */
export function clearApprovalsQueueCache() {
  pages.clear();
}

// SessionProvider announces a sign-out instead of importing this module, which keeps it out of the
// signed-out bundle; the Approvals page sets the scope itself when it renders.
if (typeof window !== 'undefined') window.addEventListener('am:signed-out', clearApprovalsQueueCache);

/** A fresh module for a test case, including the remembered scope. */
export function resetApprovalsQueueCache() {
  pages.clear();
  scope = null;
}
