import { useSyncExternalStore } from 'react';

// Theme (DESIGN.md → Themes, #36): System, Light or Dark, kept per person on this device. The inline
// script in index.html applies it before first paint; this module changes and persists it.

export type ThemePref = 'system' | 'light' | 'dark';
const listeners = new Set<() => void>();
let userId: string | null = localStorage.getItem('am.theme.user');

const key = () => (userId ? `am.theme.${userId}` : 'am.theme');
export function getThemePref(): ThemePref {
  const v = localStorage.getItem(key()) ?? localStorage.getItem('am.theme');
  return v === 'light' || v === 'dark' ? v : 'system';
}
const media = window.matchMedia('(prefers-color-scheme: dark)');
export function resolvedTheme(pref = getThemePref()): 'light' | 'dark' {
  return pref === 'system' ? (media.matches ? 'dark' : 'light') : pref;
}
function apply() {
  document.documentElement.dataset.theme = resolvedTheme();
  for (const l of listeners) l();
}
media.addEventListener('change', () => getThemePref() === 'system' && apply());

/** Scope the preference to the signed-in person (null when signed out). */
export function setThemeUser(id: string | null) {
  userId = id;
  if (id) localStorage.setItem('am.theme.user', id);
  else localStorage.removeItem('am.theme.user');
  apply();
}
export function setThemePref(p: ThemePref) {
  localStorage.setItem(key(), p);
  // The unscoped key keeps the sign-in page in the last chosen theme.
  localStorage.setItem('am.theme', p);
  apply();
}

const sub = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export function useThemePref(): ThemePref {
  return useSyncExternalStore(sub, getThemePref, getThemePref);
}
export function useResolvedTheme(): 'light' | 'dark' {
  return useSyncExternalStore(
    sub,
    () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'),
    () => 'light',
  );
}
