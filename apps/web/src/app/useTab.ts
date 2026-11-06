import { useEffect, useState } from 'react';
import { setSearchParam, useLocation } from './router';

/**
 * The one tab query contract for merged homes (#446): `?tab=<key>`, default omitted (an explicit
 * default is allowed), other query parameters kept. An unknown tab resets to the default and shows
 * “This tab is unavailable”; a known tab the role cannot use stays in the URL and renders a
 * restricted state without mounting (and so without fetching) the tab body.
 */
export function usePageTab<K extends string>({
  keys,
  fallback,
  allowed,
}: {
  keys: readonly K[];
  fallback: K;
  /** Known tabs the current role may load. Omit when every tab has the same gate as the page. */
  allowed?: (key: K) => boolean;
}) {
  const { search } = useLocation();
  const raw = search.get('tab');
  const known = raw !== null && (keys as readonly string[]).includes(raw) ? (raw as K) : null;
  const [invalid, setInvalid] = useState<string | null>(null);

  // Reset an unknown tab before the body mounts, while keeping the explanation visible.
  useEffect(() => {
    if (raw === null || known) return;
    setInvalid(raw);
    setSearchParam('tab', null);
  }, [raw, known]);

  const active = known ?? fallback;
  const forbidden = allowed && !allowed(active) ? active : null;

  const select = (key: K) => {
    setInvalid(null);
    setSearchParam('tab', key === fallback ? null : key);
  };

  return { active, forbidden, invalid, select };
}
