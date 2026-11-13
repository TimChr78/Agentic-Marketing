import { useEffect, useRef } from 'react';

/** Focus and visibilitychange of one return arrive within a few milliseconds of each other. */
export const RETURN_WINDOW_MS = 1_000;

/**
 * Runs `recheck` once each time the person returns to the tab (#735): when the window regains focus
 * or the tab becomes visible again.
 *
 * A module-scope cache and its in-tab invalidation signal cannot see a change made by another tab,
 * person, agent or the API. A read that must not outlive its source re-checks on the person's
 * return. Both events fire for one return on most browsers, in either order, so the second one
 * within `RETURN_WINDOW_MS` is the same return and does nothing. Leaving (blur, hidden) ends a
 * return at once; without a departure event a later return still reads once the window has
 * passed (0.14.13 review round 3). The reads that use this are also sequence-safe.
 *
 * The callback is kept in a ref: a new inline function each render must not tear down and re-add
 * the listeners.
 */
export function useFocusRecheck(recheck: () => void) {
  const latest = useRef(recheck);
  latest.current = recheck;
  useEffect(() => {
    let lastRun = Number.NEGATIVE_INFINITY;
    // Leaving the tab or window ends a return, so the next focus or visible event always reads.
    const left = () => {
      lastRun = Number.NEGATIVE_INFINITY;
    };
    const run = () => {
      if (document.visibilityState === 'hidden') {
        left();
        return;
      }
      const now = Date.now();
      if (now - lastRun < RETURN_WINDOW_MS) return;
      lastRun = now;
      latest.current();
    };
    window.addEventListener('focus', run);
    window.addEventListener('blur', left);
    document.addEventListener('visibilitychange', run);
    return () => {
      window.removeEventListener('focus', run);
      window.removeEventListener('blur', left);
      document.removeEventListener('visibilitychange', run);
    };
  }, []);
}
