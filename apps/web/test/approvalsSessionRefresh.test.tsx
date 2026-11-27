import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markViewed } from '../src/features/approvals/viewed';

// #1249: approving a workspace settings proposal changes the workspace name and time zone, so the
// session's copy (and the module-level display zone) must be re-read at once. #1266: approving a
// brand artifact changes the site name, logo and domain, and the batch path must refresh it too.

const h = vi.hoisted(() => ({
  calls: [] as string[],
  refresh: vi.fn(async () => {}),
  approvals: [] as unknown[],
}));

const proposal = {
  id: 'prop_1',
  changes: { timeZone: { from: 'UTC', to: 'America/New_York' }, name: { from: 'Old name', to: 'New name' } },
  note: 'Use the New York time zone.',
  status: 'pending' as const,
  requester: { kind: 'person', displayName: 'Sam Builder', personName: 'Sam Builder', tokenName: null, clientName: null },
  decidedBy: null,
  decisionNote: null,
  decidedAt: null,
  createdAt: '2026-11-20T09:00:00.000Z',
  reviewUrl: null,
};

const brandApproval = {
  id: 'apr_brand',
  artifactId: `brd_${'b'.repeat(32)}`,
  artifactName: 'Acme brand',
  artifactType: 'brand',
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
};

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string) => {
        h.calls.push(name);
        if (name === 'approvals.list') return { approvals: h.approvals, total: h.approvals.length };
        if (name === 'workspace.proposals') return { proposals: [proposal] };
        if (name === 'workspace.approveProposal') return { proposalId: 'prop_1', status: 'approved', workspace: {} };
        if (name === 'approvals.approve') return { status: 'approved', version: 1 };
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../src/app/session', () => ({
  useSession: () => ({
    can: (p: string) => p === 'workspace:admin' || p === 'artifacts:approve',
    user: { id: 'usr_admin' },
    refreshPending: () => {},
    refresh: h.refresh,
  }),
}));

import ApprovalsPage from '../src/pages/approvals/ApprovalsPage';
import { ToastProvider } from '../src/ui/toast';

const view = () =>
  render(
    <ToastProvider>
      <ApprovalsPage params={{}} />
    </ToastProvider>,
  );

beforeEach(() => {
  h.calls = [];
  h.refresh.mockClear();
  h.approvals = [];
  localStorage.clear();
});

afterEach(cleanup);

describe('a workspace settings approval refreshes the session (#1249)', () => {
  it('re-reads the workspace copy after approving the proposal', async () => {
    view();
    expect(await screen.findByText(/America\/New_York/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(h.calls).toContain('workspace.approveProposal'));
    await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1));
  });
});

describe('a batch brand approval refreshes the session (#1266)', () => {
  it('re-reads the workspace copy after a batch-approved brand', async () => {
    h.approvals = [brandApproval];
    markViewed('usr_admin', brandApproval.id, brandApproval.version);
    view();

    expect(await screen.findAllByText('Acme brand')).toBeTruthy();
    await userEvent.click(screen.getByLabelText('Select Acme brand'));
    await userEvent.click(screen.getByRole('button', { name: 'Approve 1 selected' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve 1' }));

    expect(await screen.findByText(/Approved 1 change; they are live\./)).toBeTruthy();
    await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1));
  });
});
