import { api, type Out } from '../../app/api';
import { useApi } from '../../app/useApi';

export type ArtifactRow = Out<'artifacts.list'>['artifacts'][number];

/** Every artifact matching a filter, with the server's honest total. */
export interface ArtifactPage {
  artifacts: ArtifactRow[];
  /** All rows the server has for this filter, including pages the client did not fetch. */
  total: number;
  /** False when the page cap stopped the loop before the server ran out of rows. */
  complete: boolean;
}

/** The part of `artifacts.list` pagination the client depends on. */
export interface ArtifactListPageResponse {
  artifacts: ArtifactRow[];
  total?: number;
  nextCursor?: string | null;
}

export type ArtifactListLoader = (input: {
  type?: string;
  limit: number;
  cursor?: string;
  includeArchived?: boolean;
}) => Promise<ArtifactListPageResponse>;

/** Matches the command's maximum page size. */
export const ARTIFACT_PAGE_SIZE = 200;
/**
 * A hard stop for a server that keeps returning cursors: 100 × 200 = 20,000 artifacts. Reaching it
 * reports `complete: false` rather than pretending the list is whole.
 */
export const ARTIFACT_MAX_PAGES = 100;

/**
 * Follows `nextCursor` until the server says the list is done. Older servers that return only
 * `{ artifacts }` still work as a single complete page.
 */
export async function fetchAllArtifactPages(
  load: ArtifactListLoader,
  type?: string,
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<ArtifactPage> {
  const pageSize = opts.pageSize ?? ARTIFACT_PAGE_SIZE;
  const maxPages = opts.maxPages ?? ARTIFACT_MAX_PAGES;
  const artifacts: ArtifactRow[] = [];
  let total = 0;
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const r = await load({ ...(type ? { type } : {}), limit: pageSize, ...(cursor ? { cursor } : {}) });
    artifacts.push(...r.artifacts);
    total = typeof r.total === 'number' ? r.total : artifacts.length;
    if (!r.nextCursor) return { artifacts, total, complete: true };
    cursor = r.nextCursor;
  }
  return { artifacts, total, complete: artifacts.length >= total };
}

/** Loads every page of one artifact type (or every type) through the real API. */
export const artifactListLoader: ArtifactListLoader = (input) => api.call('artifacts.list', { ...input, type: input.type as never });

export function fetchAllArtifacts(type?: string) {
  return fetchAllArtifactPages(artifactListLoader, type);
}

export function useAllArtifacts(type?: string) {
  return useApi(() => fetchAllArtifacts(type), [type]);
}
