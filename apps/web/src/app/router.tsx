import { type AnchorHTMLAttributes, forwardRef, type MouseEvent, useSyncExternalStore } from 'react';

// A small history router (DECISIONS.md D6): real paths, so deep links such as /approvals/apr_…
// work and the server's SPA fallback serves them. Links are plain anchors that push state.

// A URL base for a mounted app, e.g. `/demo`. The browser address keeps the base; pages, matches
// and the shell see the internal path. Production never sets one, so every existing URL is
// unchanged. The demo entry sets it before the shell mounts and clears it on exit.
let basePath = '';
export function setRouterBasePath(base: string) {
  basePath = base === '/' ? '' : base.replace(/\/+$/, '');
}
export function getRouterBasePath() {
  return basePath;
}

/** The path the app routes on, without the mounted base. */
export function routerPath(pathname: string): string {
  if (!basePath) return pathname;
  if (pathname === basePath) return '/';
  return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
}

/** A browser href for an in-app path, including the mounted base. */
export function routerHref(to: string): string {
  if (!basePath || !to.startsWith('/')) return to;
  if (to === basePath || to.startsWith(`${basePath}/`)) return to;
  return to === '/' ? basePath : `${basePath}${to}`;
}

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
  const target = routerHref(to);
  if (target === location.pathname + location.search) return;
  for (const g of guards) if (!g()) return;
  if (opts.replace) history.replaceState(null, '', target);
  else history.pushState(null, '', target);
  window.scrollTo(0, 0);
  emit();
}

const snapshot = () => routerPath(location.pathname) + location.search;
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

/** Matches "/marketing/journeys/:id" against a path; returns params or null. */
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

export const Link = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; replace?: boolean }>(
  function Link({ to, replace, onClick, ...p }, ref) {
    return (
      <a
        ref={ref}
        href={routerHref(to)}
        {...p}
        onClick={(e: MouseEvent<HTMLAnchorElement>) => {
          onClick?.(e);
          if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || p.target) return;
          e.preventDefault();
          navigate(to, { replace });
        }}
      />
    );
  },
);
