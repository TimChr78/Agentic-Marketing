import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Opening a segment request must mark that exact version viewed even while its live audience
// estimate is still loading. The reviewed rule renders synchronously from the approval's own
// content; the estimate only annotates it. When it gated the mark, closing the drawer before the
// estimate arrived left the queue row on "Not yet viewed" for good (`e2e/approvals.spec.ts` at
// 390 px, #1273 review).

const h = vi.hoisted(() => ({
  estimate: null as Promise<unknown> | null,
  calls: [] as { name: string; input: Record<string, unknown> }[],
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn((name: string, input: Record<string, unknown>) => {
        h.calls.push({ name, input });
        if (name === 'approvals.list') return Promise.resolve({ approvals: [row], total: 1, decisionTotal: 1, nextCursor: null });
        if (name === 'workspace.proposals') return Promise.resolve({ proposals: [] });
        if (name === 'approvals.get') return Promise.resolve(detail);
        if (name === 'segments.preview') return h.estimate ?? new Promise(() => {});
        if (name === 'purposes.list') return Promise.resolve({ source: 'published', purposes: [] });
        if (name === 'artifacts.get') return Promise.resolve({ id: detail.artifactId, type: 'segment', name: 'Engaged readers' });
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../src/app/session', () => {
  const session = () => ({
    can: () => true,
    user: { id: 'usr_reviewer', name: 'Ada', email: 'ada@example.com' },
    workspace: { id: 'ws_1', approvalPolicy: 'none', timeZone: 'UTC' },
    refresh: async () => {},
    refreshPending: () => {},
  });
  return { useSession: session, useWorkspace: session };
});

import { Routes } from '../src/app/routes';
import { wasViewed } from '../src/features/approvals/viewed';
import { resetApprovalFocusReturn } from '../src/pages/approvals/ApprovalsPage';
import { ToastProvider } from '../src/ui';

const seg = `seg_${'a'.repeat(32)}`;

const row = {
  id: 'apr_seg',
  artifactId: seg,
  artifactName: 'Engaged readers',
  artifactType: 'segment',
  version: 2,
  status: 'pending' as const,
  requestedBy: { type: 'user' as const, id: 'usr_2', client: null },
  requester: {
    kind: 'person' as const,
    displayName: 'Sam Builder',
    personName: 'Sam Builder',
    tokenName: null,
    tokenId: null,
    clientName: null,
  },
  note: 'Tighten to 14 days of opens.',
  decidedBy: null,
  decisionNote: null,
  createdAt: '2026-11-05T09:00:00.000Z',
  holdUntil: null,
  artifactLatestVersion: 2,
  artifactPublishedVersion: 1,
  archived: false,
  reviewUrl: null,
  bundle: null,
};

const detail = {
  ...row,
  publishedVersion: 1,
  publishedContent: null,
  content: { description: 'Engaged readers', condition: { consent: 'marketing_email' } },
  diff: { from: 1, to: 2, changes: [] },
  history: [],
};

const openQueue = () =>
  render(
    <Suspense fallback={<p>loading</p>}>
      <ToastProvider>
        <Routes />
      </ToastProvider>
    </Suspense>,
  );

beforeEach(() => {
  h.estimate = null;
  h.calls.length = 0;
  localStorage.clear();
  resetApprovalFocusReturn();
  window.history.replaceState(null, '', '/approvals');
});

afterEach(() => {
  cleanup();
  resetApprovalFocusReturn();
  window.history.replaceState(null, '', '/');
});

describe('opening a segment review marks it viewed without waiting for the estimate (#1273 review)', () => {
  it('marks the exact version viewed while its live size is still loading, and the row says Viewed on return', async () => {
    openQueue();
    const link = (await screen.findAllByRole('link', { name: /Engaged readers/ }))[0]!;
    expect(screen.getAllByText('Not yet viewed').length).toBeGreaterThan(0);

    fireEvent.click(link);
    expect(await screen.findByRole('dialog', { name: 'Engaged readers' })).toBeTruthy();
    // The reviewed rule is on screen; the estimate is still in flight and never resolves here.
    expect(await screen.findByText('Who is in it')).toBeTruthy();
    expect(screen.getByText('Estimated size from live data')).toBeTruthy();
    expect(h.calls.some((c) => c.name === 'segments.preview')).toBe(true);

    // The estimate never resolves, so waiting for it would hold the mark forever.
    await waitFor(() => expect(wasViewed('usr_reviewer', 'apr_seg', 2)).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.getAllByText('Viewed').length).toBeGreaterThan(0));
    expect(screen.queryByText('Not yet viewed')).toBeNull();
  });
});
