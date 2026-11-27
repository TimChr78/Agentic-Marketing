import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Opening a segment request used to mark it viewed only once its live audience estimate arrived.
// Closing the review before that lost the mark, so the queue row stayed on "Not yet viewed"
// (`e2e/approvals.spec.ts` at 390 px, #1277 review). The reviewed rule renders synchronously from
// the approval's own content; the estimate only annotates it.

const h = vi.hoisted(() => ({
  estimate: null as Promise<unknown> | null,
  calls: [] as string[],
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn((name: string) => {
        h.calls.push(name);
        if (name === 'approvals.get') return Promise.resolve(detail);
        // Never settles: the estimate is still on its way when the review is judged.
        if (name === 'segments.preview') return h.estimate ?? new Promise(() => {});
        if (name === 'purposes.list') return Promise.resolve({ source: 'published', purposes: [] });
        if (name === 'artifacts.get')
          return Promise.resolve({ id: detail.artifactId, type: 'segment', name: 'Engaged readers', publishedVersion: 1 });
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

import { ApprovalDrawer } from '../src/features/approvals/ApprovalDrawer';
import { wasViewed } from '../src/features/approvals/viewed';
import { ToastProvider } from '../src/ui';

const seg = `seg_${'a'.repeat(32)}`;

const detail = {
  id: 'apr_seg',
  artifactId: seg,
  artifactName: 'Engaged readers',
  artifactType: 'segment',
  version: 2,
  status: 'pending',
  requestedBy: { type: 'user', id: 'usr_builder' },
  requester: { kind: 'person', displayName: 'Sam Builder', personName: 'Sam Builder', tokenName: null, clientName: null },
  note: 'Tighten to 14 days of opens.',
  decidedBy: null,
  decisionNote: null,
  createdAt: '2026-11-05T09:00:00.000Z',
  holdUntil: null,
  artifactLatestVersion: 2,
  artifactPublishedVersion: 1,
  publishedVersion: 1,
  archived: false,
  reviewUrl: null,
  bundle: null,
  publishedContent: null,
  content: { description: 'Engaged readers', condition: { consent: 'marketing_email' } },
  diff: { from: 1, to: 2, changes: [] },
  history: [],
};

beforeEach(() => {
  h.estimate = null;
  h.calls.length = 0;
  localStorage.clear();
});

afterEach(cleanup);

describe('a segment review is viewed without waiting for its live estimate (#1277 review)', () => {
  it('marks the exact version viewed while the audience estimate is still loading', async () => {
    render(
      <ToastProvider>
        <ApprovalDrawer id={detail.id} queue={[detail.id]} onClose={() => {}} onDecided={() => {}} />
      </ToastProvider>,
    );

    expect(await screen.findByText('Who is in it')).toBeTruthy();
    expect(h.calls).toContain('segments.preview');

    await waitFor(() => expect(wasViewed('usr_reviewer', detail.id, detail.version)).toBe(true));
    // A newer version is still a new review.
    expect(wasViewed('usr_reviewer', detail.id, detail.version + 1)).toBe(false);
  });
});
