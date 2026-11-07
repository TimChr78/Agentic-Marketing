import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #498 review: closing a drawer opened from a queue row returns focus to that row; only a deep
// link (no invoking row) falls back to the queue heading.

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
                id: 'apr_1',
                artifactId: `bct_${'a'.repeat(32)}`,
                artifactName: 'Review me',
                artifactType: 'broadcast',
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
                createdAt: '2026-11-06T09:00:00.000Z',
                holdUntil: null,
                artifactLatestVersion: 1,
                artifactPublishedVersion: null,
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
  ApprovalDrawer: ({ id, onClose }: { id: string; onClose: () => void }) => (
    <div role="dialog" aria-label={`Review ${id}`}>
      <button type="button" onClick={onClose}>
        Close drawer
      </button>
    </div>
  ),
}));

import { useLocation } from '../src/app/router';
import ApprovalsPage, { focusApprovalReturn, resetApprovalFocusReturn } from '../src/pages/approvals/ApprovalsPage';
import { ToastProvider } from '../src/ui/toast';

function Route() {
  const { path } = useLocation();
  if (!path.startsWith('/approvals')) return <p>Elsewhere</p>;
  const id = path.startsWith('/approvals/') ? path.slice('/approvals/'.length) : undefined;
  return <ApprovalsPage params={id ? { id } : {}} />;
}

function renderPage() {
  return render(
    <ToastProvider>
      <Route />
    </ToastProvider>,
  );
}

beforeEach(() => {
  resetApprovalFocusReturn();
  localStorage.clear();
  history.replaceState(null, '', '/approvals');
});

afterEach(() => {
  cleanup();
  resetApprovalFocusReturn();
  vi.useRealTimers();
});

describe('approval drawer focus return (#498 review)', () => {
  it('returns focus to the queue row that opened it', async () => {
    renderPage();
    const links = await screen.findAllByRole('link', { name: 'Review me' });
    const rowLink = links[0]!;
    fireEvent.click(rowLink);

    expect(await screen.findByRole('dialog', { name: 'Review apr_1' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }));

    // Either responsive link for that row is the invoking row; focus must be on it, not the heading.
    await waitFor(() => expect(document.activeElement?.getAttribute('data-approval-link')).toBe('apr_1'));
  });

  it('falls back to the queue heading when the drawer was deep-linked', async () => {
    history.replaceState(null, '', '/approvals/apr_1');
    renderPage();
    expect(await screen.findByRole('dialog', { name: 'Review apr_1' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }));

    await waitFor(() => expect(document.activeElement?.textContent).toBe('Approvals'));
  });

  it('cancels a pending restoration when the page unmounts', async () => {
    const view = renderPage();
    const rowLink = (await screen.findAllByRole('link', { name: 'Review me' }))[0]!;
    fireEvent.click(rowLink);
    expect(await screen.findByRole('dialog', { name: 'Review apr_1' })).toBeTruthy();

    // The queue reloads; the drawer closes while its timers are still pending.
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }));
    });
    view.unmount();

    const elsewhere = document.createElement('button');
    elsewhere.textContent = 'Elsewhere';
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('stops retrying when no approvals root appears, instead of stealing focus later', async () => {
    vi.useFakeTimers();
    // A stale restoration from a queue that never mounts must not keep polling forever.
    focusApprovalReturn('apr_1', 1, true);
    await act(async () => {
      vi.advanceTimersByTime(10_100);
    });
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not steal focus when the person already moved it elsewhere', async () => {
    const view = renderPage();
    const rowLink = (await screen.findAllByRole('link', { name: 'Review me' }))[0]!;
    fireEvent.click(rowLink);
    expect(await screen.findByRole('dialog', { name: 'Review apr_1' })).toBeTruthy();

    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }));
    });

    const elsewhere = document.createElement('button');
    elsewhere.textContent = 'Elsewhere';
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
    view.unmount();
  });
});
