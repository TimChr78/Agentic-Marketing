import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #1266: the review drawer's approve path publishes a brand artifact, which changes the shell's
// site name, logo and domain. The session's workspace copy must be re-read on this path too.

const h = vi.hoisted(() => ({
  calls: [] as string[],
  refresh: vi.fn(async () => {}),
}));

const detail = {
  id: 'apr_brand',
  artifactId: `brd_${'b'.repeat(32)}`,
  artifactName: 'Acme brand',
  artifactType: 'brand',
  version: 1,
  status: 'pending',
  requestedBy: { type: 'user', id: 'usr_builder' },
  requester: { kind: 'person', displayName: 'Sam Builder', personName: 'Sam Builder', tokenName: null, clientName: null },
  note: null,
  decidedBy: null,
  decisionNote: null,
  createdAt: '2026-11-20T09:00:00.000Z',
  holdUntil: null,
  artifactLatestVersion: 1,
  artifactPublishedVersion: null,
  archived: false,
  publishedVersion: null,
  reviewUrl: null,
  bundle: null,
  publishedContent: null,
  content: { siteName: 'Acme', logoUrl: null },
  diff: { from: null, to: 1, changes: [] },
  history: [],
};

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string) => {
        h.calls.push(name);
        if (name === 'approvals.get') return detail;
        if (name === 'approvals.approve') return { status: 'approved', version: 1 };
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../src/app/session', () => ({
  useSession: () => ({ can: () => true, user: { id: 'usr_reviewer' } }),
  useWorkspace: () => ({
    can: () => true,
    user: { id: 'usr_reviewer' },
    workspace: { id: 'ws_1', approvalPolicy: 'agent_changes' },
    refresh: h.refresh,
  }),
}));

vi.mock('../src/features/approvals/ConsequenceSummary', () => ({ ConsequenceSummary: () => null }));
vi.mock('../src/features/previews/ArtifactPreview', () => ({ ArtifactPreview: () => <div>Brand preview</div> }));

import { ApprovalDrawer } from '../src/features/approvals/ApprovalDrawer';
import { ToastProvider } from '../src/ui/toast';

beforeEach(() => {
  h.calls = [];
  h.refresh.mockClear();
  localStorage.clear();
});

afterEach(cleanup);

describe('a brand approval refreshes the session (#1266)', () => {
  it('re-reads the workspace copy after approving in the review drawer', async () => {
    render(
      <ToastProvider>
        <ApprovalDrawer id={detail.id} queue={[detail.id]} onClose={() => {}} onDecided={() => {}} />
      </ToastProvider>,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Approve and publish' }));

    await waitFor(() => expect(h.calls).toContain('approvals.approve'));
    await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1));
  });
});
