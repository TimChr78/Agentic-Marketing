import { useEffect, useState } from 'react';

/**
 * A stable fetch time for one successful read. It is shown as “fetched” or “checked”, never as
 * event freshness: operational reads have no event timestamp.
 */
export function useFetchedAt(data: unknown): Date | null {
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  useEffect(() => {
    if (data) setFetchedAt(new Date());
  }, [data]);
  return fetchedAt;
}
