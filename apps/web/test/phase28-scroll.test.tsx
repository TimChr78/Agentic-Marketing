import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Phase 28 (#555): motion.md forbids automatic smooth scrolling. The two places that scroll for
// the person — the copilot's newest message and the approvals page's highlighted proposal — must
// scroll immediately, because JS `behavior: 'smooth'` ignores the CSS reduced-motion override.

const h = vi.hoisted(() => ({
  scrolls: [] as ScrollIntoViewOptions[],
  conversation: { id: 'cnv_1', title: 'Draft a win-back', updatedAt: '2026-11-06T09:00:00.000Z' },
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn((name: string) => {
        if (name === 'copilot.conversations') return Promise.resolve({ conversations: [h.conversation] });
        if (name === 'copilot.conversation')
          return Promise.resolve({
            id: 'cnv_1',
            events: [
              { type: 'user', text: 'Draft a win-back' },
              { type: 'text', text: 'Here is a first draft.' },
            ],
          });
        if (name === 'agents.list') return Promise.resolve({ agents: [] });
        if (name === 'approvals.list') return Promise.resolve({ approvals: [], total: 0, nextCursor: null });
        if (name === 'workspace.proposals')
          return Promise.resolve({
            proposals: [
              {
                id: 'prp_1',
                requester: { kind: 'person', displayName: 'Sam Builder', personName: 'Sam Builder', tokenName: null, clientName: null },
                createdAt: '2026-11-06T09:00:00.000Z',
                changes: { timeZone: { from: 'Europe/London', to: 'Europe/Berlin' } },
              },
            ],
          });
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../src/app/session', () => {
  const session = { can: () => true, user: { id: 'usr_1' }, refreshPending: () => {} };
  return { useSession: () => session, useWorkspace: () => ({ ...session, workspace: {} }) };
});

vi.mock('../src/features/approvals/ApprovalDrawer', () => ({ ApprovalDrawer: () => null }));

import { CopilotDrawer } from '../src/features/copilot/CopilotDrawer';
import ApprovalsPage from '../src/pages/approvals/ApprovalsPage';
import { ToastProvider } from '../src/ui';

beforeEach(() => {
  h.scrolls = [];
  Element.prototype.scrollIntoView = vi.fn(function (this: Element, options?: boolean | ScrollIntoViewOptions) {
    h.scrolls.push((options ?? {}) as ScrollIntoViewOptions);
  });
  window.scrollTo = () => {};
});

afterEach(() => {
  cleanup();
  history.replaceState(null, '', '/');
});

const rendersSmooth = () => h.scrolls.filter((o) => (o as { behavior?: string }).behavior === 'smooth');

describe('phase 28 scrolling is immediate (#555)', () => {
  it('scrolls the copilot to the newest message without smooth behaviour', async () => {
    render(
      <ToastProvider>
        <CopilotDrawer open onClose={() => {}} />
      </ToastProvider>,
    );
    // Opening an earlier conversation replaces the item list, which triggers the scroll.
    await userEvent.click(await screen.findByRole('button', { name: 'Draft a win-back' }));
    await waitFor(() => expect(screen.getByText('Here is a first draft.')).toBeTruthy());
    await waitFor(() => expect(h.scrolls.length).toBeGreaterThan(0));
    expect(rendersSmooth()).toEqual([]);
    expect(h.scrolls.at(-1)).toMatchObject({ block: 'end' });
  });

  it('scrolls to a highlighted approval proposal without smooth behaviour', async () => {
    history.replaceState(null, '', '/approvals?proposal=prp_1');
    render(
      <ToastProvider>
        <ApprovalsPage params={{}} />
      </ToastProvider>,
    );
    await waitFor(() => expect(document.getElementById('proposal-prp_1')).not.toBeNull());
    await waitFor(() => expect(h.scrolls.length).toBeGreaterThan(0));
    expect(rendersSmooth()).toEqual([]);
    expect(h.scrolls.at(-1)).toMatchObject({ block: 'center' });
  });
});
