import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// #957: a pending request whose artifact is archived can never publish. The review queue says so
// on the row, instead of showing it as an ordinary pending change.

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn((name: string) => {
        if (name === 'approvals.list')
          return Promise.resolve({
            approvals: [
              {
                id: 'apr_archived',
                artifactId: `not_${'a'.repeat(32)}`,
                artifactName: 'Archived note',
                artifactType: 'note',
                version: 1,
                status: 'pending',
                requestedBy: { type: 'user', id: 'usr_builder' },
                requester: {
                  kind: 'person',
                  displayName: 'Sam Builder',
                  personName: 'Sam Builder',
                  tokenName: null,
                  clientName: null,
                },
                note: '',
                decidedBy: null,
                decisionNote: null,
                createdAt: '2026-11-06T09:00:00.000Z',
                holdUntil: null,
                artifactLatestVersion: 1,
                artifactPublishedVersion: null,
                archived: true,
                reviewUrl: null,
                bundle: null,
              },
            ],
            total: 1,
            nextCursor: null,
          });
        if (name === 'workspace.proposals') return Promise.resolve({ proposals: [] });
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../src/app/session', () => ({
  useSession: () => ({ can: () => true, user: { id: 'usr_reviewer' }, refreshPending: () => {} }),
}));

vi.mock('../src/features/approvals/ApprovalDrawer', () => ({
  ApprovalDrawer: () => null,
}));

import ApprovalsPage from '../src/pages/approvals/ApprovalsPage';
import { ToastProvider } from '../src/ui/toast';

afterEach(cleanup);

describe('an archived artifact in the review queue (#957)', () => {
  it('marks the pending row as archived', async () => {
    render(
      <ToastProvider>
        <ApprovalsPage params={{}} />
      </ToastProvider>,
    );
    expect((await screen.findAllByText('Archived note')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Archived')).length).toBeGreaterThan(0);
  });
});
