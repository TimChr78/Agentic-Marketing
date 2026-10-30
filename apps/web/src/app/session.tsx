import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { setWorkspaceTimeZone } from '../ui/time';
import { ApiError, api, getWorkspaceId, type Out, setWorkspaceId } from './api';
import { setThemeUser } from './theme';

// The signed-in person, their workspace and what they may do. Loaded once after sign-in; the UI
// uses `can()` to hide what the role cannot use, so it never offers an action that would 403.

export type Workspace = Out<'workspace.get'>;
export type Membership = Out<'workspace.memberships'>['workspaces'][number];
export interface User {
  id: string;
  name: string;
  email: string;
}

type Status = 'loading' | 'signed-out' | 'offline' | 'no-workspace' | 'ready';

interface SessionValue {
  status: Status;
  user: User | null;
  workspace: Workspace | null;
  memberships: Membership[];
  can: (permission: string) => boolean;
  refresh: () => Promise<void>;
  switchWorkspace: (id: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Pending approvals, for the nav badge. */
  pending: number;
  refreshPending: () => void;
}

const SessionContext = createContext<SessionValue | null>(null);

async function getSession(): Promise<User | null | 'offline'> {
  try {
    const r = await fetch('/api/auth/get-session', { credentials: 'include' });
    if (!r.ok) return r.status >= 500 ? 'offline' : null;
    const body = await r.json().catch(() => null);
    return body?.user ? { id: body.user.id, name: body.user.name ?? '', email: body.user.email ?? '' } : null;
  } catch {
    return 'offline';
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [pending, setPending] = useState(0);

  const load = useCallback(async () => {
    const u = await getSession();
    if (u === 'offline') return setStatus('offline');
    if (!u) {
      setUser(null);
      setThemeUser(null);
      return setStatus('signed-out');
    }
    setUser(u);
    setThemeUser(u.id);
    const loadWs = () => api.call('workspace.get', {});
    let ws: Workspace;
    try {
      ws = await loadWs();
    } catch (e) {
      // A stored workspace the person left: fall back to their first one.
      if (e instanceof ApiError && e.status === 401 && getWorkspaceId()) {
        setWorkspaceId(null);
        try {
          ws = await loadWs();
        } catch {
          return setStatus('no-workspace');
        }
      } else if (e instanceof ApiError && e.status === 401) return setStatus('no-workspace');
      else return setStatus('offline');
    }
    setWorkspace(ws);
    setWorkspaceTimeZone(ws.timeZone);
    if (!getWorkspaceId()) setWorkspaceId(ws.id);
    setMemberships((await api.call('workspace.memberships', {}).catch(() => ({ workspaces: [] }))).workspaces);
    setStatus('ready');
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshPending = useCallback(() => {
    if (status !== 'ready') return;
    // The nav badge counts what this person can act on: approvals, plus pending workspace
    // setting proposals for admins (everyone else can see proposals but not decide them).
    const approvals = api
      .call('approvals.list', { status: 'pending', limit: 200 })
      // A bundle (#107) is one decision, as in the list.
      .then((r) => new Set(r.approvals.map((a) => a.bundle?.id ?? a.id)).size)
      .catch(() => 0);
    const proposals = workspace?.you.permissions.includes('workspace:admin')
      ? api
          .call('workspace.proposals', { status: 'pending', limit: 200 })
          .then((r) => r.proposals.length)
          .catch(() => 0)
      : Promise.resolve(0);
    Promise.all([approvals, proposals]).then(([a, p]) => setPending(a + p));
  }, [status, workspace]);
  useEffect(() => {
    refreshPending();
    const t = setInterval(refreshPending, 60_000);
    const onFocus = () => refreshPending();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshPending]);

  const value = useMemo<SessionValue>(() => {
    const perms = new Set(workspace?.you.permissions ?? []);
    return {
      status,
      user,
      workspace,
      memberships,
      can: (p) => perms.has(p),
      refresh: load,
      pending,
      refreshPending,
      switchWorkspace: async (id) => {
        setWorkspaceId(id);
        setStatus('loading');
        await load();
      },
      signOut: async () => {
        await fetch('/api/auth/sign-out', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }).catch(() => {});
        setWorkspaceId(null);
        setWorkspace(null);
        setUser(null);
        setThemeUser(null);
        setStatus('signed-out');
      },
    };
  }, [status, user, workspace, memberships, load, pending, refreshPending]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}

/** For pages inside the shell, where a workspace is always loaded. */
export function useWorkspace() {
  const s = useSession();
  return { ...s, workspace: s.workspace!, user: s.user! };
}
