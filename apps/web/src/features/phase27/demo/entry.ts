import { setRouterBasePath } from '../../../app/router';

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

const isSingleFileBuild = () => import.meta.env.MODE === 'single';

/** Whether this page belongs to the demo at all. */
export function isDemoEntry(): boolean {
  if (isSingleFileBuild()) return true;
  if (typeof location === 'undefined') return false;
  if (location.pathname === DEMO_BASE_PATH || location.pathname.startsWith(`${DEMO_BASE_PATH}/`)) return true;
  // A demo history entry from the same tab. A production link, a typed real URL or the sign-in exit
  // starts a real navigation without it, so the demo never leaks into a real workspace.
  return (history.state as { demo?: boolean } | null)?.demo === true;
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
