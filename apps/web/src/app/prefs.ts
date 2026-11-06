import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

// Per-person, per-device preferences (#180), beside the theme. Values live under
// `am.<name>.<userId>` so two people on one browser keep separate choices; before sign-in, or in
// the demo, `am.<name>` is used. theme.ts stores the signed-in id as `am.theme.user`, and the
// inline script in index.html reads the same key, so a pref can be applied before first paint.

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const prefKey = (name: string) => {
  const user = localStorage.getItem('am.theme.user');
  return user ? `am.${name}.${user}` : `am.${name}`;
};

export function getPref<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(prefKey(name));
    return allowed.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

export function setPref<T extends string>(name: string, value: T) {
  try {
    localStorage.setItem(prefKey(name), value);
  } catch {
    // Private mode or blocked storage: the choice lasts this page view only.
  }
  for (const listener of listeners) listener();
}

/**
 * Reads and writes one preference, re-rendering when it changes. `allowed` and `fallback` are
 * usually module constants; the getter is rebuilt only when their value changes.
 */
export function usePref<T extends string>(name: string, allowed: readonly T[], fallback: T): [T, (value: T) => void] {
  const allowedKey = allowed.join('\u0000');
  const get = useCallback(() => getPref(name, allowedKey.split('\u0000') as T[], fallback), [name, allowedKey, fallback]);
  const value = useSyncExternalStore(subscribe, get, () => fallback);
  const set = useCallback((next: T) => setPref(name, next), [name]);
  return [value, set];
}

// Desktop navigation state (#180). Collapsed is the 64 px icon rail; under 1024 px the mobile
// drawer is unaffected. The inline script writes the same value to <html data-nav> before paint.
export type NavPref = 'expanded' | 'collapsed';
const NAV_VALUES = ['expanded', 'collapsed'] as const;
export const getNavPref = () => getPref('nav', NAV_VALUES, 'expanded');
export const setNavPref = (value: NavPref) => setPref('nav', value);
export const useNavPref = () => usePref('nav', NAV_VALUES, 'expanded');

/**
 * Collapsed work groups (#446), stored per person and workspace as a JSON string array of group
 * keys under `am.navGroups.<userId>.<workspaceId>.v1`. An empty array means every group is open.
 * Storage failures leave the choice in this component's memory for the page view.
 */
const navGroupsKey = (userId: string, workspaceId: string) => `am.navGroups.${userId}.${workspaceId}.v1`;

function readCollapsedGroups(key: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function useCollapsedNavGroups(userId: string | null | undefined, workspaceId: string | null | undefined) {
  const key = userId && workspaceId ? navGroupsKey(userId, workspaceId) : null;
  const [collapsed, setCollapsedState] = useState<string[]>([]);
  useEffect(() => setCollapsedState(key ? readCollapsedGroups(key) : []), [key]);
  const setCollapsed = useCallback(
    (next: string[] | ((current: string[]) => string[])) => {
      setCollapsedState((current) => {
        const value = typeof next === 'function' ? next(current) : next;
        if (key) {
          try {
            localStorage.setItem(key, JSON.stringify(value));
          } catch {
            // Private mode or blocked storage: the choice lasts this page view only.
          }
        }
        return value;
      });
    },
    [key],
  );
  return [collapsed, setCollapsed] as const;
}
