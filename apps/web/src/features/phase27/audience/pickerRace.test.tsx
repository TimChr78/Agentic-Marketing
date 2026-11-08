import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setWorkspaceId } from '../../../app/api';
import type { ArtifactListLoader, ArtifactRow } from '../../artifacts/artifactList';
import { peekPickerIndex, readPickerIndex, refreshPickerIndex, resetPickerIndexes, usePickerIndex } from '../../artifacts/pickerIndex';

// #525 review: a refresh must never let an older in-flight read overwrite the newer index.

const ws = '11111111-1111-4111-8111-111111111111';

const h = vi.hoisted(() => ({
  initial: [] as unknown[],
}));

vi.mock('../../../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string) => {
        if (name === 'artifacts.list') return { artifacts: h.initial, total: h.initial.length, nextCursor: null };
        throw new Error(`unexpected ${name}`);
      }),
    },
  };
});

function row(i: number): ArtifactRow {
  return {
    id: `seg_${String(i).padStart(32, '0')}`,
    type: 'segment',
    name: `segment ${i}`,
    latestVersion: 1,
    latestState: 'draft' as const,
    publishedVersion: null,
    updatedAt: '2026-11-02T09:00:00.000Z',
  };
}

function deferredRows() {
  let resolve!: (value: { artifacts: ArtifactRow[]; total: number; nextCursor: null }) => void;
  const promise = new Promise<{ artifacts: ArtifactRow[]; total: number; nextCursor: null }>((done) => {
    resolve = done;
  });
  const load: ArtifactListLoader = () => promise;
  return {
    load,
    resolve: (i: number) => resolve({ artifacts: [row(i)], total: 1, nextCursor: null }),
  };
}

beforeEach(() => {
  cleanup();
  resetPickerIndexes();
  setWorkspaceId(ws, { persist: false });
  h.initial = [];
});

afterEach(cleanup);

describe('picker index refresh ordering (#525)', () => {
  it('keeps the newer refresh when the older request completes last', async () => {
    const older = deferredRows();
    const newer = deferredRows();
    const first = readPickerIndex(ws, 'segment', { load: older.load });
    const refreshed = refreshPickerIndex(ws, 'segment', { load: newer.load });

    newer.resolve(2);
    await refreshed;
    expect(peekPickerIndex(ws, 'segment')?.artifacts[0]?.name).toBe('segment 2');

    older.resolve(1);
    await first;
    expect(peekPickerIndex(ws, 'segment')?.artifacts[0]?.name).toBe('segment 2');
  });

  it('notifies a mounted selector when a refresh completes', async () => {
    h.initial = [row(1)];
    function Names() {
      const index = usePickerIndex('segment');
      return <p>{index.loading ? 'loading' : (index.data?.artifacts.map((a) => a.name).join(', ') ?? 'none')}</p>;
    }
    render(<Names />);
    expect(await screen.findByText('segment 1')).toBeTruthy();

    const next = deferredRows();
    const refreshed = refreshPickerIndex(ws, 'segment', { load: next.load });
    next.resolve(2);
    await refreshed;
    expect(await screen.findByText('segment 2')).toBeTruthy();
  });
});
