import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #498 review: cancelling a rejection returns focus to the Reject button that revealed the
// reason field, instead of leaving focus in the removed textarea.

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn((name: string) => {
        if (name === 'approvals.get') return Promise.resolve(detail);
        if (name === 'purposes.list')
          return Promise.resolve({
            source: 'published',
            purposes: [
              {
                key: 'marketing_email',
                name: 'Marketing e-mail',
                description: '',
                basis: 'consent',
                channels: ['email'],
                requiresDoubleOptIn: true,
                topics: [],
              },
            ],
          });
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
  }),
}));

import { ApprovalDrawer } from '../src/features/approvals/ApprovalDrawer';
import { ToastProvider } from '../src/ui/toast';

const frm = `frm_${'a'.repeat(32)}`;

const detail = {
  id: 'apr_form',
  artifactId: frm,
  artifactName: 'Focus form',
  artifactType: 'form',
  version: 1,
  status: 'pending',
  requestedBy: { type: 'user', id: 'usr_builder' },
  requester: { kind: 'person', displayName: 'Sam Builder', personName: 'Sam Builder', tokenName: null, clientName: null },
  note: '',
  decidedBy: null,
  decisionNote: null,
  createdAt: '2026-11-06T09:00:00.000Z',
  holdUntil: null,
  artifactLatestVersion: 1,
  artifactPublishedVersion: null,
  publishedVersion: null,
  reviewUrl: null,
  bundle: null,
  content: {
    purposes: ['marketing_email'],
    doubleOptIn: true,
    consentText: 'Yes, send me the newsletter.',
    traits: ['firstName'],
    successUrl: 'https://martechsignal.example/thanks',
    allowedOrigins: [],
  },
  publishedContent: null,
  diff: { from: null, to: 1, changes: [] },
  history: [],
};

function renderDrawer() {
  return render(
    <ToastProvider>
      <ApprovalDrawer id={detail.id} queue={[detail.id]} onClose={() => {}} onDecided={() => {}} />
    </ToastProvider>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('rejection focus return (#498 review)', () => {
  it('returns focus to Reject when the rejection is cancelled', async () => {
    renderDrawer();
    const reject = await screen.findByRole('button', { name: 'Reject' });
    fireEvent.click(reject);

    const reason = await screen.findByRole('textbox');
    await waitFor(() => expect(document.activeElement).toBe(reason));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reject' })));
  });
});
