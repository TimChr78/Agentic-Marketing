import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setWorkspaceId } from '../src/app/api';
import { ArtifactSelect } from '../src/features/artifacts/ArtifactSelect';
import type { ArtifactListLoader } from '../src/features/artifacts/artifactList';
import {
  invalidatePickerArtifact,
  invalidatePickerIndex,
  peekPickerIndex,
  readPickerIndex,
  resetPickerIndexes,
  usePickerIndex,
} from '../src/features/artifacts/pickerIndex';

const ws1 = '11111111-1111-4111-8111-111111111111';
const ws2 = '22222222-2222-4222-8222-222222222222';

const h = vi.hoisted(() => ({
  calls: [] as string[],
  rows: [] as unknown[],
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string) => {
        h.calls.push(name);
        if (name === 'artifacts.list') return { artifacts: h.rows, total: h.rows.length, nextCursor: null };
        throw new Error(`unexpected ${name}`);
      }),
    },
  };
});

function row(i: number, type = 'segment', prefix = 'seg') {
  return {
    id: `${prefix}_${String(i).padStart(32, '0')}`,
    type,
    name: `${type} ${i}`,
    latestVersion: 1,
    latestState: 'draft' as const,
    publishedVersion: null,
    updatedAt: '2026-11-02T09:00:00.000Z',
  };
}

function loader(count: number, type = 'segment', prefix = 'seg') {
  const calls: { type?: string; limit: number; cursor?: string }[] = [];
  const load: ArtifactListLoader = async (input) => {
    calls.push(input);
    return { artifacts: Array.from({ length: count }, (_, i) => row(i, type, prefix)), total: count, nextCursor: null };
  };
  return { load, calls };
}

beforeEach(() => {
  resetPickerIndexes();
  h.calls.length = 0;
  h.rows = [];
  setWorkspaceId(ws1, { persist: false });
});

afterEach(cleanup);

describe('shared picker index (#524)', () => {
  it('reads one complete list per type per workspace, whatever the row count', async () => {
    const one = loader(1);
    const fifty = loader(50);
    await readPickerIndex(ws1, 'segment', { load: one.load });
    await readPickerIndex(ws1, 'segment', { load: fifty.load });
    expect(one.calls).toHaveLength(1);
    expect(fifty.calls).toHaveLength(0);
    expect(peekPickerIndex(ws1, 'segment')?.artifacts).toHaveLength(1);

    // A different workspace is a different index; the same workspace and type is cached.
    const other = loader(3);
    await readPickerIndex(ws2, 'segment', { load: other.load });
    expect(other.calls).toHaveLength(1);
  });

  it('exposes the honest total and completeness of the bounded index', async () => {
    const partial: ArtifactListLoader = async () => ({ artifacts: [row(1), row(2)], total: 999 });
    const page = await readPickerIndex(ws1, 'email_template', { load: partial });
    expect(page.total).toBe(999);
    expect(page.complete).toBe(true);
  });

  it('invalidates only the exact workspace and type keys holding the new version', async () => {
    const segments = loader(2, 'segment');
    const templates = loader(2, 'email_template', 'eml');
    const otherWorkspace = loader(2, 'segment');
    await readPickerIndex(ws1, 'segment', { load: segments.load });
    await readPickerIndex(ws1, 'email_template', { load: templates.load });
    await readPickerIndex(ws2, 'segment', { load: otherWorkspace.load });

    invalidatePickerArtifact(ws1, row(0).id);

    expect(peekPickerIndex(ws1, 'segment')).toBeUndefined();
    expect(peekPickerIndex(ws1, 'email_template')).toBeDefined();
    expect(peekPickerIndex(ws2, 'segment')).toBeDefined();

    await readPickerIndex(ws1, 'segment', { load: segments.load });
    await readPickerIndex(ws1, 'email_template', { load: templates.load });
    await readPickerIndex(ws2, 'segment', { load: otherWorkspace.load });
    expect(segments.calls).toHaveLength(2);
    expect(templates.calls).toHaveLength(1);
    expect(otherWorkspace.calls).toHaveLength(1);
  });

  it('drops a whole type index when a new artifact is created', async () => {
    const segments = loader(2);
    const templates = loader(2, 'email_template', 'eml');
    await readPickerIndex(ws1, 'segment', { load: segments.load });
    await readPickerIndex(ws1, 'email_template', { load: templates.load });

    invalidatePickerIndex(ws1, 'segment');

    expect(peekPickerIndex(ws1, 'segment')).toBeUndefined();
    expect(peekPickerIndex(ws1, 'email_template')).toBeDefined();
  });

  it('does not read a row detail for any row when repeated selectors mount', async () => {
    h.rows = Array.from({ length: 40 }, (_, i) => row(i));
    render(
      <>
        <ArtifactSelect type="segment" value={undefined} onChange={() => {}} />
        <ArtifactSelect type="segment" value={undefined} onChange={() => {}} />
        <ArtifactSelect type="email_template" value={undefined} onChange={() => {}} />
      </>,
    );
    await waitFor(() => expect(screen.getAllByRole('combobox').length).toBe(3));
    await waitFor(() => expect(h.calls.filter((name) => name === 'artifacts.list')).toHaveLength(2));
    expect(h.calls.filter((name) => name === 'artifacts.get')).toHaveLength(0);
  });
});

function Status({ type }: { type: string }) {
  const index = usePickerIndex(type);
  return (
    <p>
      {type}: {index.loading ? 'loading' : index.error ? index.error : `${index.data?.artifacts.length ?? 0} of ${index.total}`}
      {index.complete ? '' : ' (partial)'}
    </p>
  );
}

describe('picker index hook (#524)', () => {
  it('serves the cached index to every selector without a read per selector', async () => {
    h.rows = Array.from({ length: 7 }, (_, i) => row(i));
    render(
      <>
        <Status type="segment" />
        <Status type="segment" />
        <Status type="segment" />
      </>,
    );
    await waitFor(() => expect(screen.getAllByText('segment: 7 of 7')).toHaveLength(3));
    expect(h.calls.filter((name) => name === 'artifacts.list')).toHaveLength(1);
  });

  it('reports a failed read and retries it on reload', async () => {
    const calls: string[] = [];
    const fail: ArtifactListLoader = async () => {
      calls.push('read');
      throw new Error('The list is unavailable.');
    };
    await expect(readPickerIndex(ws1, 'segment', { load: fail })).rejects.toThrow('The list is unavailable.');
    expect(calls).toHaveLength(1);
    // A failure is not cached as a result: the next read tries again.
    await expect(readPickerIndex(ws1, 'segment', { load: fail })).rejects.toThrow('The list is unavailable.');
    expect(calls).toHaveLength(2);
  });
});
