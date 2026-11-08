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

export interface DemoEntry {
  /** True when the visitor arrived at the retired live-site walkthrough. */
  liveRetired: boolean;
}

const isSingleFileBuild = () => import.meta.env.MODE === 'single';

/** Whether this page belongs to the demo at all. */
export function isDemoEntry(): boolean {
  if (isSingleFileBuild()) return true;
  if (typeof location === 'undefined') return false;
  if (location.pathname === '/demo' || location.pathname.startsWith('/demo/')) return true;
  // Every demo navigation carries `demo: true` in history state. A new tab, a typed real URL, or an
  // exit to sign-in starts a real navigation without it, so the demo never leaks into a real
  // workspace and a real workspace never inherits fixtures.
  return (history.state as { demo?: boolean } | null)?.demo === true;
}

/**
 * Normalises the demo entry into the real route it represents, before the real Root mounts. The
 * `/demo` prefix, the legacy hash routes and an unknown demo address all resolve here:
 * a known hash maps to its real section, an unknown one becomes an ordinary Not found path that
 * stays in the demo (the marker and fixture transport are already installed).
 */
export function enterDemo(): DemoEntry {
  const underDemo = location.pathname === '/demo' || location.pathname.startsWith('/demo/');
  let path = underDemo ? location.pathname.slice('/demo'.length) || '/' : location.pathname;
  const hash = location.hash;
  let liveRetired = false;

  if (underDemo && hash) {
    const legacy = hash.replace(/^#/, '').trim().toLowerCase();
    const target = LEGACY_HASH[legacy];
    if (target !== undefined) {
      path = target;
      liveRetired = legacy === 'live';
    } else {
      // Keep the requested words so the page reads as this demo address, not a real destination.
      path = `/demo-unknown/${encodeURIComponent(legacy || 'address')}`;
    }
  }

  const next = `${path}${location.search}${underDemo ? '' : hash}`;
  try {
    history.replaceState({ ...(history.state ?? {}), demo: true, demoLiveRetired: liveRetired }, '', next);
  } catch {
    // A sandboxed single-file frame may refuse history changes; the app still renders the fixture
    // shell, it just cannot update the address.
  }
  return { liveRetired };
}

/**
 * Marks every in-app navigation as demo history while the demo is mounted, so reload and
 * back/forward stay on fixture data. The router's own links and `navigate()` calls are untouched.
 */
export function installDemoHistory(): () => void {
  if (typeof history === 'undefined') return () => {};
  const push = history.pushState;
  const replace = history.replaceState;
  const mark = (state: unknown) => ({ ...((state as Record<string, unknown> | null) ?? {}), demo: true });
  history.pushState = function (this: History, state: unknown, unused: string, url?: string | URL | null) {
    return push.call(this, mark(state), unused, url);
  } as typeof history.pushState;
  history.replaceState = function (this: History, state: unknown, unused: string, url?: string | URL | null) {
    return replace.call(this, mark(state), unused, url);
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
