import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// PR #1273 review: the module-level approvals queue cache survived a decision made under another
// status and a session change, so a drawer remount could restore a stale page beside a fresh first
// page and render the same decision twice.

const h = vi.hoisted(() => ({
  impl: null as null | ((name: string, input: Record<string, unknown>) => Promise<unknown>),
  user: 'usr_reviewer',
  workspace: 'ws_1',
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn((name: string, input: Record<string, unknown>) => {
        if (!h.impl) throw new Error(`unexpected command ${name}`);
        return h.impl(name, input);
      }),
    },
  };
});

vi.mock('../src/app/session', () => {
  const session = () => ({
    can: () => true,
    user: { id: h.user, name: 'Ada', email: 'ada@example.com' },
    workspace: { id: h.workspace },
    refreshPending: () => {},
  });
  return { useSession: session, useWorkspace: session };
});

vi.mock('../src/features/approvals/ApprovalDrawer', () => ({
  ApprovalDrawer: ({ onDecided }: { onDecided: () => void }) => (
    <div role="dialog">
      <button type="button" onClick={onDecided}>
        Decide
      </button>
    </div>
  ),
}));

const ApprovalsPage = (await import('../src/pages/approvals/ApprovalsPage')).default;
const { resetApprovalsQueueCache } = await import('../src/pages/approvals/ApprovalsPage');
const { approvalsQueueKey, readApprovalsQueuePage, setApprovalsQueueScope, writeApprovalsQueuePage } = await import(
  '../src/features/approvals/queueCache'
);
const { ToastProvider } = await import('../src/ui');

const approval = (n: number, status: 'pending' | 'approved' = 'pending') => ({
  id: `apr_${n}`,
  artifactId: `bct_${String(n).padStart(32, '0')}`,
  artifactName: `Change ${n}`,
  artifactType: 'broadcast',
  version: 1,
  status,
  requestedBy: { type: 'user' as const, id: 'usr_2', client: null },
  requester: {
    kind: 'person' as const,
    displayName: 'Sam Builder',
    personName: 'Sam Builder',
    tokenName: null,
    tokenId: null,
    clientName: null,
  },
  note: '',
  decidedBy: null,
  decisionNote: null,
  createdAt: '2026-11-05T09:00:00.000Z',
  holdUntil: null,
  artifactLatestVersion: 1,
  artifactPublishedVersion: null,
  archived: false,
  reviewUrl: null,
  bundle: null,
});

const open = (params: Record<string, string> = {}) =>
  render(
    <ToastProvider>
      <ApprovalsPage params={params} />
    </ToastProvider>,
  );

beforeEach(() => {
  h.impl = null;
  h.user = 'usr_reviewer';
  h.workspace = 'ws_1';
  resetApprovalsQueueCache();
  window.history.replaceState(null, '', '/approvals');
});

afterEach(() => {
  cleanup();
  resetApprovalsQueueCache();
  window.history.replaceState(null, '', '/');
});

describe('approvals queue cache scope (PR #1273 review)', () => {
  it('restores cached extra pages beside a fresh first page without duplicating a row', async () => {
    // Visit 1, approved tab: one extra page is loaded, so the cache holds apr_2.
    h.impl = async (name, input) => {
      if (name === 'workspace.proposals') return { proposals: [] };
      if (name !== 'approvals.list') throw new Error(`unexpected ${name}`);
      if (input.status === 'approved') {
        if (input.cursor === 'page-2') return { approvals: [approval(2, 'approved')], total: 2, decisionTotal: 2, nextCursor: null };
        return { approvals: [approval(1, 'approved')], total: 2, decisionTotal: 2, nextCursor: 'page-2' };
      }
      return { approvals: [approval(5)], total: 1, decisionTotal: 1, nextCursor: null };
    };

    const first = open();
    await screen.findAllByText('Change 5');
    fireEvent.click(screen.getByRole('tab', { name: 'Approved' }));
    await screen.findAllByText('Change 1');
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await screen.findAllByText('Change 2');
    first.unmount();

    // Meanwhile a decision elsewhere moves apr_2 into the approved list as the newest row: the
    // fresh first page now contains it, and the stale cached page still holds it.
    h.impl = async (name, input) => {
      if (name === 'workspace.proposals') return { proposals: [] };
      if (name !== 'approvals.list') throw new Error(`unexpected ${name}`);
      if (input.status === 'approved') {
        return { approvals: [approval(2, 'approved'), approval(1, 'approved')], total: 2, decisionTotal: 2, nextCursor: null };
      }
      return { approvals: [approval(5)], total: 1, decisionTotal: 1, nextCursor: null };
    };

    window.history.replaceState(null, '', '/approvals?status=approved');
    open();
    await waitFor(() => expect(screen.getAllByText('Change 2').length).toBeGreaterThan(0));

    // The fresh first page contains apr_2; the stale cache still holds it. One row renders once in
    // each responsive copy (cards and table), so a duplicated decision would show four.
    expect(screen.getAllByText('Change 2')).toHaveLength(2);
  });

  it('forgets every status page after a decision, not only the visible tab', async () => {
    let phase = 1;
    h.impl = async (name, input) => {
      if (name === 'workspace.proposals') return { proposals: [] };
      if (name !== 'approvals.list') throw new Error(`unexpected ${name}`);
      if (input.status === 'approved') {
        if (input.cursor === 'approved-2') return { approvals: [approval(3, 'approved')], total: 3, decisionTotal: 3, nextCursor: null };
        return phase === 1
          ? { approvals: [approval(1, 'approved')], total: 3, decisionTotal: 3, nextCursor: 'approved-2' }
          : { approvals: [approval(2, 'approved'), approval(1, 'approved')], total: 2, decisionTotal: 2, nextCursor: 'approved-2' };
      }
      return { approvals: [approval(5)], total: 1, decisionTotal: 1, nextCursor: null };
    };

    window.history.replaceState(null, '', '/approvals?status=approved');
    const first = open();
    await screen.findAllByText('Change 1');
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await screen.findAllByText('Change 3');
    expect(readApprovalsQueuePage(approvalsQueueKey(h.user, h.workspace, 'approved'))).toBeTruthy();
    first.unmount();

    // A decision under Pending reloads the queue; it must invalidate Approved's pages too.
    phase = 2;
    window.history.replaceState(null, '', '/approvals?status=pending');
    const second = open({ id: 'apr_5' });
    fireEvent.click(await screen.findByRole('button', { name: 'Decide' }));
    expect(readApprovalsQueuePage(approvalsQueueKey(h.user, h.workspace, 'approved'))).toBeUndefined();
    second.unmount();

    window.history.replaceState(null, '', '/approvals?status=approved');
    open();
    await screen.findAllByText('Change 2');
    // The dropped page never comes back, so the just-approved row exists once and apr_3 stays gone.
    expect(screen.getAllByText('Change 2')).toHaveLength(2);
    expect(screen.queryByText('Change 3')).toBeNull();
  });

  it('never reuses a cached page from another signed-in person', async () => {
    h.impl = async (name, input) => {
      if (name === 'workspace.proposals') return { proposals: [] };
      if (name !== 'approvals.list') throw new Error(`unexpected ${name}`);
      if (input.status === 'approved') {
        if (input.cursor === 'approved-2') return { approvals: [approval(3, 'approved')], total: 3, decisionTotal: 3, nextCursor: null };
        return { approvals: [approval(1, 'approved')], total: 3, decisionTotal: 3, nextCursor: 'approved-2' };
      }
      return { approvals: [approval(5)], total: 1, decisionTotal: 1, nextCursor: null };
    };

    window.history.replaceState(null, '', '/approvals?status=approved');
    const first = open();
    await screen.findAllByText('Change 1');
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await screen.findAllByText('Change 3');
    first.unmount();

    // Another person signs in to the same workspace; the old extra page must not be restored.
    h.user = 'usr_other';
    h.impl = async (name, input) => {
      if (name === 'workspace.proposals') return { proposals: [] };
      if (name !== 'approvals.list') throw new Error(`unexpected ${name}`);
      if (input.status === 'approved')
        return { approvals: [approval(2, 'approved'), approval(1, 'approved')], total: 2, decisionTotal: 2, nextCursor: null };
      return { approvals: [approval(5)], total: 1, decisionTotal: 1, nextCursor: null };
    };

    open();
    await screen.findAllByText('Change 2');
    expect(screen.queryByText('Change 3')).toBeNull();
  });

  it('drops remembered pages when the signed-in person or workspace changes', () => {
    setApprovalsQueueScope('usr_a', 'ws_1');
    writeApprovalsQueuePage(approvalsQueueKey('usr_a', 'ws_1', 'approved'), { rows: [approval(3, 'approved')], cursor: null });
    expect(readApprovalsQueuePage(approvalsQueueKey('usr_a', 'ws_1', 'approved'))).toBeTruthy();

    setApprovalsQueueScope('usr_b', 'ws_1');
    expect(readApprovalsQueuePage(approvalsQueueKey('usr_a', 'ws_1', 'approved'))).toBeUndefined();

    writeApprovalsQueuePage(approvalsQueueKey('usr_b', 'ws_1', 'approved'), { rows: [approval(3, 'approved')], cursor: null });
    setApprovalsQueueScope('usr_b', 'ws_2');
    expect(readApprovalsQueuePage(approvalsQueueKey('usr_b', 'ws_1', 'approved'))).toBeUndefined();
  });
});
