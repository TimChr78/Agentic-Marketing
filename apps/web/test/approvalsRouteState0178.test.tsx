import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/app/session', () => {
  const session = () => ({
    can: () => true,
    status: 'signed-in',
    user: { id: 'usr_reviewer', name: 'Ada', email: 'ada@example.com' },
    workspace: { id: 'ws_1', approvalPolicy: 'none', timeZone: 'UTC' },
    refreshPending: () => {},
  });
  return { useSession: session, useWorkspace: session };
});

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: Record<string, unknown>) => {
        if (name === 'approvals.list') {
          if (input.cursor === 'page-2') return { approvals: rows(3, 3), total: 3, decisionTotal: 3, nextCursor: null };
          return { approvals: rows(1, 2), total: 3, decisionTotal: 3, nextCursor: 'page-2' };
        }
        if (name === 'workspace.proposals') return { proposals: [] };
        throw new Error(`unexpected ${name}`);
      }),
    },
  };
});

vi.mock('../src/features/approvals/ApprovalDrawer', () => ({
  ApprovalDrawer: ({ id, onClose }: { id: string; onClose: () => void }) => (
    <div role="dialog" aria-label={`Review ${id}`}>
      <button type="button" onClick={onClose}>
        Close drawer
      </button>
    </div>
  ),
}));

import { Routes } from '../src/app/routes';
import { resetApprovalFocusReturn, resetApprovalsQueueCache } from '../src/pages/approvals/ApprovalsPage';
import { ToastProvider } from '../src/ui';

const rows = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => {
    const n = from + i;
    return {
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
      bundle: null,
    };
  });

beforeEach(() => {
  resetApprovalsQueueCache();
  resetApprovalFocusReturn();
  window.history.replaceState(null, '', '/approvals');
});

afterEach(() => {
  cleanup();
  resetApprovalsQueueCache();
  resetApprovalFocusReturn();
  window.history.replaceState(null, '', '/');
});

describe('Approvals route state across the drawer (#1254 review)', () => {
  it('keeps the loaded pages and returns focus to the invoked row', async () => {
    render(
      <Suspense fallback={<p>loading</p>}>
        <ToastProvider>
          <Routes />
        </ToastProvider>
      </Suspense>,
    );

    await screen.findAllByText('Change 1');
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await screen.findAllByText('Change 3');

    const row = screen.getAllByRole('link', { name: /Change 3/ })[0]!;
    fireEvent.click(row);
    expect(await screen.findByRole('dialog', { name: 'Review apr_3' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }));

    // The route remounts on the way back; the second-page request must still be in the queue.
    await screen.findAllByText('Change 3');
    await waitFor(() => expect(document.activeElement?.getAttribute('data-approval-link')).toBe('apr_3'));
  });
});
