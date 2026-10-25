import { type AnchorHTMLAttributes, forwardRef, type MouseEvent, useSyncExternalStore } from 'react';

// A small history router (DECISIONS.md D6): real paths, so deep links such as /approvals/apr_…
// work and the server's SPA fallback serves them. Links are plain anchors that push state.

type Listener = () => void;
const listeners = new Set<Listener>();
const subscribe = (l: Listener) => {
  listeners.add(l);
  window.addEventListener('popstate', l);
  return () => {
    listeners.delete(l);
    window.removeEventListener('popstate', l);
  };
};
const emit = () => {
  for (const l of listeners) l();
};

/** Guards that can block navigation (unsaved changes). Return false to stay. */
const guards = new Set<() => boolean>();
export function addNavigationGuard(g: () => boolean) {
  guards.add(g);
  return () => guards.delete(g);
}

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (to === location.pathname + location.search) return;
  for (const g of guards) if (!g()) return;
  if (opts.replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  window.scrollTo(0, 0);
  emit();
}

const snapshot = () => location.pathname + location.search;
export function useLocation() {
  const href = useSyncExternalStore(subscribe, snapshot, snapshot);
  const url = new URL(href, location.origin);
  return { path: url.pathname.replace(/\/+$/, '') || '/', search: url.searchParams, href };
}

export function setSearchParam(key: string, value: string | null) {
  const url = new URL(location.href);
  if (value === null) url.searchParams.delete(key);
  else url.searchParams.set(key, value);
  history.replaceState(null, '', url.pathname + url.search);
  emit();
}

/** Matches "/build/journeys/:id" against a path; returns params or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  const wild = p[p.length - 1] === '*';
  if (wild ? s.length < p.length - 1 : s.length !== p.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '*') break;
    if (p[i].startsWith(':')) out[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return out;
}

export const Link = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; replace?: boolean }>(function Link(
  { to, replace, onClick, ...p },
  ref,
) {
  return (
    <a
      ref={ref}
      href={to}
      {...p}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || p.target) return;
        e.preventDefault();
        navigate(to, { replace });
      }}
    />
  );
});
