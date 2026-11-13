import { useEffect, useRef } from 'react';

/**
 * Runs `recheck` once each time the person returns to the tab (#735): when the window regains focus
 * or the tab becomes visible again.
 *
 * A module-scope cache and its in-tab invalidation signal cannot see a change made by another tab,
 * person, agent or the API. A read that must not outlive its source re-checks on the person's
 * return. Both events fire for one return on most browsers, in either order, so a latch makes the
 * first one read and the other one a no-op; it clears when the tab hides or the window loses focus,
 * which is where every return starts. The reads that use this are also sequence-safe.
 *
 * The callback is kept in a ref: a new inline function each render must not tear down and re-add
 * the listeners.
 */
export function useFocusRecheck(recheck: () => void) {
  const latest = useRef(recheck);
  latest.current = recheck;
  useEffect(() => {
    let checked = false;
    const run = () => {
      if (document.visibilityState === 'hidden') {
        checked = false;
        return;
      }
      if (checked) return;
      checked = true;
      latest.current();
    };
    const left = () => {
      checked = false;
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
