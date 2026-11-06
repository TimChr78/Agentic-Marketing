import { beforeEach, describe, expect, it, vi } from 'vitest';

// #459/#486: the shared name map must not outlive a change to the artifacts it names. A rename,
// create, delete or publish through the app's mutation paths drops the cache, and a short TTL
// re-reads it even when nothing in this tab changed.

const h = vi.hoisted(() => ({
  rows: [] as {
    id: string;
    type: string;
    name: string;
    latestVersion: number;
    latestState: string;
    publishedVersion: number;
    updatedAt: string;
  }[],
  reads: 0,
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string) => {
        if (name !== 'artifacts.list') throw new Error(`unexpected command ${name}`);
        h.reads++;
        return { artifacts: [...h.rows], total: h.rows.length, nextCursor: null };
      }),
    },
  };
});

vi.mock('../src/app/session', () => ({ useWorkspace: () => ({ workspace: { id: 'ws_1' } }) }));

import { invalidateArtifact } from '../src/features/artifactCache';
import { artifactNameCache, clearArtifactNameCache } from '../src/features/broadcasts/names';

const seg = `seg_${'b'.repeat(32)}`;
const tpl = `eml_${'c'.repeat(32)}`;

function artifact(id: string, type: string, name: string, latestVersion = 1) {
  return {
    id,
    type,
    name,
    latestVersion,
    latestState: 'published',
    publishedVersion: latestVersion,
    updatedAt: '2026-11-06T09:00:00.000Z',
  };
}

beforeEach(() => {
  h.rows = [artifact(seg, 'segment', 'October promo'), artifact(tpl, 'email_template', 'Field notes')];
  h.reads = 0;
  clearArtifactNameCache();
});

describe('broadcast artifact name cache (#459, #486)', () => {
  it('does not resolve again while the cache is fresh', async () => {
    await artifactNameCache('ws_1', 'segment');
    await artifactNameCache('ws_1', 'segment');
    expect(h.reads).toBe(1);
  });

  it('re-reads after a rename goes through invalidateArtifact', async () => {
    const first = await artifactNameCache('ws_1', 'segment');
    expect(first.get(seg)?.name).toBe('October promo');

    h.rows = [artifact(seg, 'segment', 'November promo', 2), artifact(tpl, 'email_template', 'Field notes')];
    invalidateArtifact(seg);

    const second = await artifactNameCache('ws_1', 'segment');
    expect(second.get(seg)).toMatchObject({ name: 'November promo', latestVersion: 2 });
    expect(h.reads).toBe(2);
  });

  it('stops resolving a deleted segment instead of keeping its old name', async () => {
    expect((await artifactNameCache('ws_1', 'segment')).get(seg)?.name).toBe('October promo');

    h.rows = [artifact(tpl, 'email_template', 'Field notes')];
    invalidateArtifact(seg);

    expect((await artifactNameCache('ws_1', 'segment')).has(seg)).toBe(false);
  });

  it('refreshes on create through invalidateArtifact', async () => {
    const before = await artifactNameCache('ws_1', 'segment');
    const created = `seg_${'e'.repeat(32)}`;
    expect(before.has(created)).toBe(false);

    h.rows = [...h.rows, artifact(created, 'segment', 'November readers')];
    invalidateArtifact(created);

    expect((await artifactNameCache('ws_1', 'segment')).get(created)?.name).toBe('November readers');
  });

  it('keeps workspaces apart and re-reads after the TTL backstop', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-06T10:00:00Z'));
      await artifactNameCache('ws_1', 'segment');
      await artifactNameCache('ws_2', 'segment');
      expect(h.reads).toBe(2);

      h.rows = [artifact(seg, 'segment', 'November promo', 2)];
      vi.setSystemTime(new Date('2026-11-06T10:01:00Z'));
      const again = await artifactNameCache('ws_1', 'segment');
      expect(again.get(seg)?.name).toBe('November promo');
      expect(h.reads).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
