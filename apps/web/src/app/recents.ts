import { setReadListener } from './api';
import { artifactPath } from './artifactRoutes';

// Recent detail visits (#446). Only a successful, authorised artifact, agent or person detail read
// is recorded, and only once the data has loaded: the API client reports successful reads, and this
// module checks that the read matches the detail page currently open. Lists, tabs, search queries,
// approvals, failed loads and creation dialogs therefore never enter recents.
//
// Storage holds `{kind, id}` only (no names, e-mails, content, query or hash), at most 20 unique
// entries, under `am.recents.<userId>.<workspaceId>.v1`. The scope isolates people and workspaces on
// one device; when storage is unavailable the same values live in session memory. Sign-out clears
// the memory; the stored values remain for the next sign-in on this device.

export type RecentKind = 'artifact' | 'agent' | 'person';
export interface Recent {
  kind: RecentKind;
  id: string;
}

const MAX = 20;
const KINDS = new Set<RecentKind>(['artifact', 'agent', 'person']);

interface Scope {
  userId: string;
  workspaceId: string;
}
let scope: Scope | null = null;

/** Session memory, keyed like the storage key; also the fallback when storage throws. */
const memory = new Map<string, Recent[]>();

const storageKey = (s: Scope) => `am.recents.${s.userId}.${s.workspaceId}.v1`;

function parse(value: string | null): Recent[] {
  if (!value) return [];
  try {
    const raw = JSON.parse(value);
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: Recent[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const kind = (entry as { kind?: unknown }).kind;
      const id = (entry as { id?: unknown }).id;
      if (typeof kind !== 'string' || !KINDS.has(kind as RecentKind) || typeof id !== 'string' || !id) continue;
      const key = `${kind}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: kind as RecentKind, id });
      if (out.length === MAX) break;
    }
    return out;
  } catch {
    return [];
  }
}

function read(key: string): Recent[] {
  let stored: Recent[] | undefined;
  try {
    stored = parse(localStorage.getItem(key));
  } catch {
    stored = undefined;
  }
  if (stored === undefined) return memory.get(key) ?? [];
  memory.set(key, stored);
  return stored;
}

function write(key: string, items: Recent[]) {
  memory.set(key, items);
  try {
    localStorage.setItem(key, JSON.stringify(items));
  } catch {
    // Private mode or blocked storage: the list lasts this page view only.
  }
}

/** Called by SessionProvider when the signed-in person or workspace changes. */
export function setRecentsScope(userId: string | null, workspaceId: string | null) {
  scope = userId && workspaceId ? { userId, workspaceId } : null;
}

/** The MRU list for the current person and workspace. */
export function getRecents(): Recent[] {
  if (!scope) return [];
  return read(storageKey(scope));
}

/** Records a successful detail visit, moving an existing entry to the front. */
export function recordRecent(kind: RecentKind, id: string) {
  if (!scope || !id) return;
  const key = storageKey(scope);
  const next = [{ kind, id }, ...read(key).filter((r) => !(r.kind === kind && r.id === id))].slice(0, MAX);
  write(key, next);
}

/** Removes this person/workspace's list, as the palette's “Clear recents” asks. */
export function clearRecents() {
  if (!scope) return;
  const key = storageKey(scope);
  memory.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing else to remove.
  }
}

/** Sign-out clears this page's memory; stored lists stay for a later sign-in on this device. */
export function clearRecentsMemory() {
  memory.clear();
}

/** The path of a canonical detail route, without query or hash, for the “is this page open?” check. */
function pathnameOf(href: string): string {
  return new URL(href, 'http://local').pathname.replace(/\/+$/, '') || '/';
}

function handleRead(name: string, _input: unknown, output: unknown) {
  if (typeof location === 'undefined') return;
  const path = location.pathname.replace(/\/+$/, '') || '/';

  if (name === 'artifacts.get') {
    const value = output as { id?: unknown; type?: unknown } | null;
    if (typeof value?.id !== 'string' || typeof value.type !== 'string') return;
    if (path === pathnameOf(artifactPath(value.type, value.id))) recordRecent('artifact', value.id);
    return;
  }

  if (name === 'agents.get') {
    const value = output as { id?: unknown } | null;
    if (typeof value?.id === 'string' && path === pathnameOf(`/work/agents/${encodeURIComponent(value.id)}`))
      recordRecent('agent', value.id);
    return;
  }

  if (name === 'profiles.get') {
    const value = output as { id?: unknown } | null;
    if (typeof value?.id === 'string' && path === pathnameOf(`/audience/people/${encodeURIComponent(value.id)}`))
      recordRecent('person', value.id);
  }
}

setReadListener(handleRead);
