import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

// #1254: the queue reads one page of 200 and ignored nextCursor/total, so newer requests were
// unreachable and the Pending count stopped at 200.
// #1258: a failed workspace.proposals read rendered nothing instead of an error with Retry.

const h = vi.hoisted(() => ({
  impl: null as null | ((name: string, input: Record<string, unknown>) => Promise<unknown>),
  calls: [] as { name: string; input: Record<string, unknown> }[],
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn((name: string, input: Record<string, unknown>) => {
        h.calls.push({ name, input });
        if (!h.impl) throw new Error(`unexpected command ${name}`);
        return h.impl(name, input);
      }),
    },
  };
});

vi.mock('../src/app/session', () => {
  const session = () => ({
    can: () => true,
    user: { id: 'usr_reviewer', name: 'Ada', email: 'ada@example.com' },
    refreshPending: () => {},
  });
  return { useSession: session, useWorkspace: session };
});

vi.mock('../src/features/approvals/ApprovalDrawer', () => ({ ApprovalDrawer: () => null }));

import ApprovalsPage from '../src/pages/approvals/ApprovalsPage';
import { ToastProvider } from '../src/ui';

const bundle = (memberNumbers: number[]) => ({
  id: 'apb_1',
  members: memberNumbers.map((n) => ({
    approvalId: `apr_${n}`,
    artifactId: `bct_${String(n).padStart(32, '0')}`,
    artifactName: `Change ${n}`,
    artifactType: 'broadcast',
    version: 1,
  })),
});

const approval = (n: number, bundleValue: ReturnType<typeof bundle> | null = null) => ({
  id: `apr_${n}`,
  artifactId: `bct_${String(n).padStart(32, '0')}`,
  artifactName: `Change ${n}`,
  artifactType: 'broadcast',
  version: 1,
  status: 'pending',
  requestedBy: { type: 'user', id: 'usr_2' },
  requester: { kind: 'person', displayName: 'Sam Builder', personName: 'Sam Builder', tokenName: null, clientName: null },
  note: '',
  decidedBy: null,
  decisionNote: null,
  createdAt: '2026-11-05T09:00:00.000Z',
  holdUntil: null,
  artifactLatestVersion: 1,
  artifactPublishedVersion: null,
  archived: false,
  reviewUrl: null,
  bundle: bundleValue,
});

const renderPage = () =>
  render(
    <ToastProvider>
      <ApprovalsPage params={{}} />
    </ToastProvider>,
  );

afterEach(() => {
  cleanup();
  h.calls.length = 0;
  h.impl = null;
});

describe('Approvals paging (#1254)', () => {
  it('follows nextCursor on Load more and shows the total on the Pending tab', async () => {
    h.impl = async (name, input) => {
      if (name === 'approvals.list') {
        if (input.cursor === 'page-2')
          return { approvals: Array.from({ length: 40 }, (_, i) => approval(201 + i)), total: 240, decisionTotal: 240, nextCursor: null };
        return {
          approvals: Array.from({ length: 200 }, (_, i) => approval(i + 1)),
          total: 240,
          decisionTotal: 240,
          nextCursor: 'page-2',
        };
      }
      if (name === 'workspace.proposals') return { proposals: [] };
      throw new Error(`unexpected ${name}`);
    };

    renderPage();
    await screen.findAllByText('Change 1');

    // The count is the server's total, not the 200 loaded rows.
    expect(screen.getByRole('tab', { name: /Pending/ }).textContent).toContain('240');
    expect(screen.queryByText('200')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /load more/i }));
    await screen.findAllByText('Change 240');

    const second = h.calls.filter((c) => c.name === 'approvals.list')[1]!;
    expect(second.input).toEqual({ status: 'pending', limit: 200, cursor: 'page-2' });
    // The total is unchanged and there is no further page to load.
    expect(screen.getByRole('tab', { name: /Pending/ }).textContent).toContain('240');
    await waitFor(() => expect(screen.queryByRole('button', { name: /load more/i })).toBeNull());
  });

  it('drops a Load more result that lands after a tab switch and a fresh first page', async () => {
    let resolvePage2: ((value: unknown) => void) | undefined;
    h.impl = async (name, input) => {
      if (name === 'workspace.proposals') return { proposals: [] };
      if (name !== 'approvals.list') throw new Error(`unexpected ${name}`);
      if (input.cursor === 'page-2')
        return new Promise((resolve) => {
          resolvePage2 = resolve;
        });
      if (input.status === 'approved') return { approvals: [], total: 0, decisionTotal: 0, nextCursor: null };
      return { approvals: [approval(1)], total: 2, decisionTotal: 2, nextCursor: 'page-2' };
    };

    renderPage();
    await screen.findAllByText('Change 1');
    await userEvent.click(screen.getByRole('button', { name: /load more/i }));

    await userEvent.click(screen.getByRole('tab', { name: /Approved/ }));
    await screen.findByText('No approved changes');
    await act(async () => {
      resolvePage2?.({ approvals: [approval(2)], total: 2, decisionTotal: 2, nextCursor: null });
      await Promise.resolve();
    });

    await userEvent.click(screen.getByRole('tab', { name: /Pending/ }));
    await screen.findAllByText('Change 1');
    expect(screen.queryByText('Change 2')).toBeNull();
  });

  it('counts a bundle once even when its members straddle two pages', async () => {
    const pair = bundle([1, 3]);
    h.impl = async (name, input) => {
      if (name === 'approvals.list') {
        if (input.cursor === 'page-2') return { approvals: [approval(3, pair), approval(4)], total: 4, decisionTotal: 3, nextCursor: null };
        return { approvals: [approval(1, pair), approval(2)], total: 4, decisionTotal: 3, nextCursor: 'page-2' };
      }
      if (name === 'workspace.proposals') return { proposals: [] };
      throw new Error(`unexpected ${name}`);
    };

    renderPage();
    await screen.findAllByText('Change 1');

    // Three decisions: the bundle (members 1 and 3) and the standalone requests 2 and 4.
    expect(screen.getByRole('tab', { name: /Pending/ }).textContent).toContain('3');
    expect(screen.getByRole('tab', { name: /Pending/ }).textContent).not.toContain('4');

    await userEvent.click(screen.getByRole('button', { name: /load more/i }));
    await screen.findAllByText('Change 3');
    // The bundle collapses into its later member once both pages are loaded.
    expect(screen.queryAllByText('Change 1')).toHaveLength(0);
    expect(screen.getByRole('tab', { name: /Pending/ }).textContent).toContain('3');
  });
});

describe('Approvals workspace settings read (#1258)', () => {
  it('shows an error with Retry, then recovers with exactly one new read', async () => {
    let proposalsFail = true;
    h.impl = async (name) => {
      if (name === 'approvals.list') return { approvals: [approval(1)], total: 1, decisionTotal: 1, nextCursor: null };
      if (name === 'workspace.proposals') {
        if (proposalsFail) {
          proposalsFail = false;
          throw new Error('the proposals read failed');
        }
        return { proposals: [] };
      }
      throw new Error(`unexpected ${name}`);
    };

    renderPage();
    await screen.findAllByText('Change 1');

    expect(await screen.findByText(/Couldn't load workspace settings proposals/)).toBeTruthy();
    expect(screen.getByText('the proposals read failed')).toBeTruthy();
    const before = h.calls.filter((c) => c.name === 'workspace.proposals').length;
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(screen.queryByText(/Couldn't load workspace settings proposals/)).toBeNull());
    expect(h.calls.filter((c) => c.name === 'workspace.proposals')).toHaveLength(before + 1);
  });
});
