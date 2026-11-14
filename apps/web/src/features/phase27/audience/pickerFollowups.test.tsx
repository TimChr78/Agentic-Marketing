import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setWorkspaceId } from '../../../app/api';
import { ToastProvider } from '../../../ui/toast';
import { ArtifactListPage } from '../../artifacts/ArtifactListPage';
import type { ArtifactRow } from '../../artifacts/artifactList';
import {
  invalidatePickerArtifact,
  invalidatePickerIndex,
  peekPickerIndex,
  readPickerIndex,
  resetPickerIndexes,
  usePickerIndex,
} from '../../artifacts/pickerIndex';

// #525 review follow-ups: a skipped picker index must not subscribe, and a pending index must be
// invalidated like a loaded one so a pre-mutation response cannot fill the cache.

const ws = '11111111-1111-4111-8111-111111111111';
const segmentId = `seg_${'a'.repeat(32)}`;

type Call = { name: string; input: Record<string, unknown> };
type Page = { artifacts: ArtifactRow[]; total: number; nextCursor: null };

const h = vi.hoisted(() => ({
  calls: [] as Call[],
  rows: [] as ArtifactRow[],
  listQueue: [] as (() => Promise<Page>)[],
  created: `frm_${'b'.repeat(32)}`,
}));

function callsOf(name: string) {
  return h.calls.filter((call) => call.name === name);
}

vi.mock('../../../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: Record<string, unknown> = {}) => {
        h.calls.push({ name, input });
        if (name === 'artifacts.list') {
          const next = h.listQueue.shift();
          if (next) return await next();
          return { artifacts: h.rows, total: h.rows.length, nextCursor: null };
        }
        if (name === 'artifacts.create') return { artifactId: h.created };
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../../../app/session', () => ({
  useSession: () => ({
    can: () => true,
    workspace: { id: ws, approvalPolicy: 'none', timeZone: 'UTC' },
    user: { id: 'u1', name: 'Alex Morgan', email: 'alex@example.com' },
  }),
  useWorkspace: () => ({
    can: () => true,
    workspace: { id: ws, approvalPolicy: 'none', timeZone: 'UTC' },
    user: { id: 'u1', name: 'Alex Morgan', email: 'alex@example.com' },
  }),
}));

function formRow(name: string): ArtifactRow {
  return {
    id: `frm_${'c'.repeat(32)}`,
    type: 'form',
    name,
    latestVersion: 1,
    latestState: 'draft',
    publishedVersion: null,
    updatedAt: '2026-11-02T09:00:00.000Z',
    archived: false,
  };
}

/** A mounted picker selector, so a pending index can be observed while it loads. */
function SegmentNames() {
  const index = usePickerIndex('segment');
  return <p>{index.loading ? 'loading' : (index.data?.artifacts.map((artifact) => artifact.name).join(', ') ?? 'none')}</p>;
}

function templateRow(): ArtifactRow {
  return {
    id: `eml_${'e'.repeat(32)}`,
    type: 'email_template',
    name: 'Confirm your subscription',
    latestVersion: 1,
    latestState: 'published',
    publishedVersion: 1,
    updatedAt: '2026-11-02T09:00:00.000Z',
    archived: false,
  };
}

function deferredPage() {
  let resolve!: (page: Page) => void;
  const promise = new Promise<Page>((done) => {
    resolve = done;
  });
  return {
    load: () => promise,
    resolve: (name: string) =>
      resolve({
        artifacts: [
          {
            id: segmentId,
            type: 'segment',
            name,
            latestVersion: 1,
            latestState: 'draft',
            publishedVersion: null,
            updatedAt: '2026-11-02T09:00:00.000Z',
            archived: false,
          },
        ],
        total: 1,
        nextCursor: null,
      }),
  };
}

beforeEach(() => {
  cleanup();
  resetPickerIndexes();
  setWorkspaceId(ws, { persist: false });
  h.calls.length = 0;
  h.rows = [];
  h.listQueue = [];
  window.history.replaceState(null, '', '/');
});

afterEach(cleanup);

describe('skipped picker index (#525)', () => {
  it('does not read the index from the legacy list page when a create invalidates it', async () => {
    h.rows = [formRow('Weekly journal')];
    render(
      <ToastProvider>
        <ArtifactListPage
          type="form"
          title="Forms"
          description="Signup forms."
          emptyTitle="No forms yet"
          emptyText="Create one."
          create={{ label: 'New form', content: (name) => ({ name }) }}
        />
      </ToastProvider>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Forms' })).toBeTruthy();
    await waitFor(() => expect(callsOf('artifacts.list')).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'New form' }));
    fireEvent.change(screen.getByRole('textbox', { name: /^Name/ }), { target: { value: 'Second form' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(callsOf('artifacts.create')).toHaveLength(1));

    // The create invalidates the form index. A skipped hook must not have a listener that turns
    // that invalidation into a read nobody asked for.
    await new Promise((done) => setTimeout(done, 50));
    expect(callsOf('artifacts.list')).toHaveLength(1);
    invalidatePickerIndex(ws, 'form');
    await new Promise((done) => setTimeout(done, 50));
    expect(callsOf('artifacts.list')).toHaveLength(1);
  });
});

describe('pending picker index (#525)', () => {
  it('drops a pre-mutation response and re-reads when the index is invalidated', async () => {
    const older = deferredPage();
    const newer = deferredPage();
    h.listQueue = [older.load, newer.load];

    render(<SegmentNames />);
    await waitFor(() => expect(callsOf('artifacts.list')).toHaveLength(1));

    // A rename arrives while the first list read is still pending.
    invalidatePickerArtifact(ws, segmentId);
    await waitFor(() => expect(callsOf('artifacts.list')).toHaveLength(2));

    older.resolve('Old name');
    await waitFor(() => expect(screen.getByText('loading')).toBeTruthy());
    expect(screen.queryByText('Old name')).toBeNull();

    newer.resolve('Weekly readers');
    expect(await screen.findByText('Weekly readers')).toBeTruthy();
    expect(screen.queryByText('Old name')).toBeNull();
  });

  it('an unknown artifact prefix drops pending indexes but leaves loaded indexes alone', async () => {
    const older = deferredPage();
    const newer = deferredPage();
    h.listQueue = [older.load, newer.load];

    render(<SegmentNames />);
    await waitFor(() => expect(callsOf('artifacts.list')).toHaveLength(1));

    const loaded = await readPickerIndex(ws, 'email_template', {
      load: async () => ({ artifacts: [templateRow()], total: 1, nextCursor: null }),
    });
    expect(loaded.artifacts[0]?.name).toBe('Confirm your subscription');

    // An id without a known type prefix cannot name its index; every pending index is dropped,
    // but a loaded index that does not hold the id is not touched.
    invalidatePickerArtifact(ws, `zzz_${'d'.repeat(32)}`);
    await waitFor(() => expect(callsOf('artifacts.list')).toHaveLength(2));
    expect(peekPickerIndex(ws, 'email_template')?.artifacts[0]?.name).toBe('Confirm your subscription');

    older.resolve('Old name');
    await waitFor(() => expect(screen.getByText('loading')).toBeTruthy());
    expect(screen.queryByText('Old name')).toBeNull();

    newer.resolve('Weekly readers');
    expect(await screen.findByText('Weekly readers')).toBeTruthy();
  });
});
