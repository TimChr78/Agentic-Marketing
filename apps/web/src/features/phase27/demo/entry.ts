import { routerHref, routerPath, setRouterBasePath } from '../../../app/router';

/** Where the legacy demo's hash routes live in the real product. */
const LEGACY_HASH: Record<string, string> = {
  overview: '/',
  profiles: '/audience/people',
  email: '/content/templates',
  setup: '/settings/integrations',
  journeys: '/marketing/journeys',
  analytics: '/insights/analytics',
  approvals: '/approvals',
  workspace: '/settings/workspace',
  // The live-site walkthrough was retired; its address now opens Home with a short notice.
  live: '/',
};

/** The persistent demo URL namespace. Every demo link and navigation stays under it. */
export const DEMO_BASE_PATH = '/demo';

export interface DemoEntry {
  /** True when the visitor arrived at the retired live-site walkthrough. */
  liveRetired: boolean;
}

export const isSingleFileBuild = () => import.meta.env.MODE === 'single';

/** Whether this page belongs to the demo at all. */
export function isDemoEntry(): boolean {
  if (isSingleFileBuild()) return true;
  if (typeof location === 'undefined') return false;
  // The URL namespace is the only way in. A production path is never demo mode, even when an old
  // entry still carries `history.state.demo`; a copied /demo link, a new tab and a reload all stay
  // in the demo because the path says so.
  return location.pathname === DEMO_BASE_PATH || location.pathname.startsWith(`${DEMO_BASE_PATH}/`);
}

/**
 * Normalises the demo entry into its URL namespace, before the shell mounts. `/demo` is the base
 * every link keeps, the legacy hash routes map to their real sections, and an unknown demo address
 * becomes an ordinary Not found path that stays inside the demo.
 */
export function enterDemo(): DemoEntry {
  const single = isSingleFileBuild();
  const pathname = location.pathname;
  const underDemo = !single && (pathname === DEMO_BASE_PATH || pathname.startsWith(`${DEMO_BASE_PATH}/`));
  const hash = location.hash;
  let internal = single ? pathname : underDemo ? pathname.slice(DEMO_BASE_PATH.length) || '/' : pathname;
  let liveRetired = false;

  if (hash) {
    const legacy = hash.replace(/^#/, '').trim().toLowerCase();
    const target = LEGACY_HASH[legacy];
    if (target !== undefined) {
      internal = target;
      liveRetired = legacy === 'live';
    } else {
      // Keep the requested words so the page reads as this demo address, not a real destination.
      internal = `/unknown/${encodeURIComponent(legacy || 'address')}`;
    }
  }

  if (single) {
    setRouterBasePath('');
  } else {
    setRouterBasePath(DEMO_BASE_PATH);
  }
  const path = internal === '/' ? DEMO_BASE_PATH : `${DEMO_BASE_PATH}${internal}`;
  const next = single ? `${internal}${location.search}` : `${path}${location.search}`;
  try {
    history.replaceState({ ...(history.state ?? {}), demo: true, demoLiveRetired: liveRetired }, '', next);
  } catch {
    // A sandboxed single-file frame may refuse history changes; the app still renders the fixture
    // shell, it just cannot update the address.
  }
  return { liveRetired };
}

/**
 * The one confinement rule for a URL written while the demo is mounted. Any destination is resolved
 * against the current URL, normalized (`.`/`..`/duplicate slashes) and rebuilt under `/demo`, so a
 * caller cannot stamp a production path as demo. Returns undefined for no URL, letting the browser
 * keep the current entry.
 */
export function confineDemoHref(url: string | URL | null | undefined): string | undefined {
  if (url === null || url === undefined) return undefined;
  if (isSingleFileBuild()) return undefined;
  const raw = String(url);
  let parsed: URL;
  try {
    parsed = new URL(raw, location.href);
  } catch {
    // Let the native API raise its own error for a malformed destination.
    return raw;
  }
  // A different origin must reach the native API unchanged so it throws its SecurityError; never
  // substitute the current query or hash for it.
  if (parsed.origin !== location.origin) return raw;
  const internal = routerPath(parsed.pathname);
  const href = routerHref(internal);
  return `${href}${parsed.search}${parsed.hash}`;
}

/**
 * Marks every in-app navigation as demo history while the demo is mounted and confines its URL to
 * `/demo`. Reload and back/forward therefore stay on fixture data, and no caller can push a
 * production path that later looks like demo mode.
 */
export function installDemoHistory(): () => void {
  if (typeof history === 'undefined' || isSingleFileBuild()) return () => {};
  const push = history.pushState;
  const replace = history.replaceState;
  const mark = (state: unknown) => ({ ...((state as Record<string, unknown> | null) ?? {}), demo: true });
  history.pushState = function (this: History, state: unknown, unused: string, url?: string | URL | null) {
    return push.call(this, mark(state), unused, confineDemoHref(url));
  } as typeof history.pushState;
  history.replaceState = function (this: History, state: unknown, unused: string, url?: string | URL | null) {
    return replace.call(this, mark(state), unused, confineDemoHref(url));
  } as typeof history.replaceState;
  return () => {
    history.pushState = push;
    history.replaceState = replace;
  };
}

/** The one-time notice shown where the retired live-site walkthrough used to be. */
export const LIVE_RETIRED_NOTICE =
  'The live-site walkthrough is no longer part of the demo. The real destinations here replace it: the newsletter signup in Forms, the weekly issue in Templates and the results in Analytics. Nothing on this page sends or executes.';

/** True when this entry replaced the old `#live` walkthrough. */
export function demoLiveRetired(): boolean {
  return (history.state as { demoLiveRetired?: boolean } | null)?.demoLiveRetired === true;
}
