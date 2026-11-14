import { describe, expect, it } from 'vitest';
import { ARTIFACT_PAGE_SIZE, type ArtifactListLoader, fetchAllArtifactPages } from '../src/features/artifacts/artifactList';

const row = (i: number) => ({
  id: `seg_${String(i).padStart(32, '0')}`,
  type: 'segment',
  name: `Segment ${i}`,
  latestVersion: 1,
  latestState: 'draft' as const,
  publishedVersion: null,
  updatedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
  archived: false,
});

describe('artifact list pagination (#382)', () => {
  it('follows every cursor, so the 201st artifact is reachable and the total is honest', async () => {
    const requests: { limit: number; cursor?: string }[] = [];
    const load: ArtifactListLoader = async (input) => {
      requests.push({ limit: input.limit, cursor: input.cursor });
      if (!input.cursor) {
        return { artifacts: Array.from({ length: ARTIFACT_PAGE_SIZE }, (_, i) => row(i)), total: 201, nextCursor: 'page-2' };
      }
      return { artifacts: [row(200)], total: 201, nextCursor: null };
    };

    const page = await fetchAllArtifactPages(load, 'segment');

    expect(page.artifacts).toHaveLength(201);
    expect(page.artifacts[200]?.name).toBe('Segment 200');
    expect(page.total).toBe(201);
    expect(page.complete).toBe(true);
    expect(requests).toEqual([
      { limit: ARTIFACT_PAGE_SIZE, cursor: undefined },
      { limit: ARTIFACT_PAGE_SIZE, cursor: 'page-2' },
    ]);
  });

  it('stops at an exact page boundary without inventing another page', async () => {
    let calls = 0;
    const load: ArtifactListLoader = async () => {
      calls++;
      return { artifacts: Array.from({ length: ARTIFACT_PAGE_SIZE }, (_, i) => row(i)), total: ARTIFACT_PAGE_SIZE, nextCursor: null };
    };

    const page = await fetchAllArtifactPages(load, 'segment');

    expect(calls).toBe(1);
    expect(page.artifacts).toHaveLength(ARTIFACT_PAGE_SIZE);
    expect(page.total).toBe(ARTIFACT_PAGE_SIZE);
    expect(page.complete).toBe(true);
  });

  it('reports an incomplete load when a broken server keeps returning cursors', async () => {
    let calls = 0;
    const load: ArtifactListLoader = async () => {
      calls++;
      return { artifacts: [row(calls)], total: 999, nextCursor: `page-${calls}` };
    };

    const page = await fetchAllArtifactPages(load, undefined, { pageSize: 2, maxPages: 3 });

    expect(calls).toBe(3);
    expect(page.artifacts).toHaveLength(3);
    expect(page.total).toBe(999);
    expect(page.complete).toBe(false);
  });

  it('accepts an older single-page response as the whole list', async () => {
    const load: ArtifactListLoader = async () => ({ artifacts: [row(1), row(2)] });

    const page = await fetchAllArtifactPages(load, 'segment');

    expect(page).toEqual({ artifacts: [row(1), row(2)], total: 2, complete: true });
  });
});
