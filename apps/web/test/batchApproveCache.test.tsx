import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setWorkspaceId } from '../src/app/api';
import { markViewed } from '../src/features/approvals/viewed';
import { invalidateArtifact } from '../src/features/artifactCache';
import { ArtifactSelect } from '../src/features/artifacts/ArtifactSelect';
import { resetPickerIndexes } from '../src/features/artifacts/pickerIndex';
import ApprovalsPage from '../src/pages/approvals/ApprovalsPage';
import { ToastProvider } from '../src/ui/toast';

// #1252: the review drawer drops the artifact's picker rows after a decision, but the queue's own
// "Approve N selected" batch action publishes with the same command and sent no notice. Every
// picker kept the just-published segment as "not live yet" until a reload.

const h = vi.hoisted(() => ({
  calls: [] as string[],
  rows: [] as unknown[],
  published: false,
  publish: null as null | (() => void),
  approval: {
    id: 'apr_1',
    artifactId: `seg_${'1'.repeat(32)}`,
    artifactName: 'Win-back segment',
    artifactType: 'segment',
    version: 1,
    status: 'pending',
    requestedBy: { type: 'user', id: 'usr_builder' },
    requester: { kind: 'person', displayName: 'Sam Builder', personName: 'Sam Builder', tokenName: null, clientName: null },
    note: null,
    createdAt: '2026-11-20T09:00:00.000Z',
    holdUntil: null,
    bundle: null,
    archived: false,
    artifactPublishedVersion: null,
    content: {},
  },
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string) => {
        h.calls.push(name);
        if (name === 'artifacts.list') return { artifacts: h.rows, total: h.rows.length, nextCursor: null };
        if (name === 'approvals.approve') {
          h.publish?.();
          return { status: 'approved', version: 1 };
        }
        if (name === 'approvals.list') return { approvals: h.published ? [] : [h.approval], total: h.published ? 0 : 1 };
        if (name === 'workspace.proposals') return { proposals: [] };
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../src/app/session', () => ({
  useSession: () => ({ can: () => true, user: { id: 'usr_reviewer' }, refreshPending: () => {} }),
}));

const segment = (published: boolean) => ({
  id: h.approval.artifactId,
  type: 'segment',
  name: 'segment 1',
  latestVersion: 1,
  latestState: published ? ('published' as const) : ('draft' as const),
  publishedVersion: published ? 1 : null,
  updatedAt: '2026-11-02T09:00:00.000Z',
  archived: false,
});

const listReads = () => h.calls.filter((name) => name === 'artifacts.list').length;

beforeEach(() => {
  resetPickerIndexes();
  localStorage.clear();
  h.calls.length = 0;
  h.rows = [segment(false)];
  h.published = false;
  h.publish = null;
  setWorkspaceId('11111111-1111-4111-8111-111111111111', { persist: false });
  // A change can be batch-approved once its exact version was previewed.
  markViewed('usr_reviewer', h.approval.id, h.approval.version);
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

describe('batch approval from the queue (#1252)', () => {
  it('drops every picker row it publishes, like the review drawer', async () => {
    render(
      <ToastProvider>
        <ArtifactSelect type="segment" value={undefined} onChange={() => {}} />
        <ApprovalsPage params={{}} />
      </ToastProvider>,
    );
    await waitFor(() => expect(screen.getByRole('option', { name: 'segment 1 · not live yet' })).toBeTruthy());
    expect(listReads()).toBe(1);
    expect((await screen.findAllByRole('link', { name: /Win-back segment/ })).length).toBeGreaterThan(0);

    // The server publishes the segment when the approval is approved.
    h.publish = () => {
      h.rows = [segment(true)];
      h.published = true;
    };
    await userEvent.click(screen.getByLabelText('Select Win-back segment'));
    await userEvent.click(screen.getByRole('button', { name: 'Approve 1 selected' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve 1' }));

    expect(await screen.findByText(/Approved 1 change; they are live\./)).toBeTruthy();
    // The picker hears the decision and re-reads: the row is live, not the stale draft.
    await waitFor(() => expect(screen.getByRole('option', { name: 'segment 1 · live v1' })).toBeTruthy());
    expect(screen.queryByRole('option', { name: 'segment 1 · not live yet' })).toBeNull();
    expect(listReads()).toBe(2);

    // The direct invalidation is now the no-op; the notice already did it.
    act(() => invalidateArtifact(h.approval.artifactId));
    await waitFor(() => expect(screen.getByRole('option', { name: 'segment 1 · live v1' })).toBeTruthy());
  });
});
