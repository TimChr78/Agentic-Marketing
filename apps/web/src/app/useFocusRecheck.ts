import { useEffect, useRef } from 'react';

/**
 * Runs `recheck` when the window regains focus and when the tab becomes visible again (#735).
 *
 * A module-scope cache and its in-tab invalidation signal cannot see a change made by another tab,
 * person, agent or the API. A read that must not outlive its source re-checks on the person's
 * return. Both events fire for one return on most browsers, so the callback must be sequence-safe
 * (the reads that use this already are) rather than debounced here.
 *
 * The callback is kept in a ref: a new inline function each render must not tear down and re-add
 * the listeners.
 */
export function useFocusRecheck(recheck: () => void) {
  const latest = useRef(recheck);
  latest.current = recheck;
  useEffect(() => {
    const run = () => {
      if (document.visibilityState !== 'hidden') latest.current();
    };
    window.addEventListener('focus', run);
    document.addEventListener('visibilitychange', run);
    return () => {
      window.removeEventListener('focus', run);
      document.removeEventListener('visibilitychange', run);
    };
  }, []);
}
