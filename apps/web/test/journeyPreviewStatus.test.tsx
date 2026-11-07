import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #498 review: the journey graph is lazy. Opening the drawer is not viewing: only the successfully
// mounted graph may report ready, and a graph that is still loading or fails to draw never marks
// the reviewed version viewed.

const h = vi.hoisted(() => ({
  mode: 'ready' as 'ready' | 'loading' | 'error',
  pending: new Promise<void>(() => {}),
  details: {} as Record<string, unknown>,
}));

vi.mock('../src/features/journey/JourneyGraph', () => ({
  JourneyGraph: () => {
    if (h.mode === 'loading') throw h.pending;
    if (h.mode === 'error') throw new Error('The journey graph could not be drawn.');
    return <div data-testid="journey-graph">Journey graph</div>;
  },
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn((name: string, input?: unknown) => {
        if (name === 'approvals.get') return Promise.resolve(h.details[(input as { approvalId: string }).approvalId] ?? detail);
        if (name === 'purposes.list') return Promise.resolve({ source: 'published', purposes: [] });
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
import { wasViewed } from '../src/features/approvals/viewed';
import { ToastProvider } from '../src/ui/toast';

const jrn = `jrn_${'a'.repeat(32)}`;

const detail = {
  id: 'apr_journey',
  artifactId: jrn,
  artifactName: 'Viewed journey',
  artifactType: 'journey',
  version: 2,
  status: 'pending',
  requestedBy: { type: 'user', id: 'usr_builder' },
  requester: { kind: 'person', displayName: 'Sam Builder', personName: 'Sam Builder', tokenName: null, clientName: null },
  note: '',
  decidedBy: null,
  decisionNote: null,
  createdAt: '2026-11-06T09:00:00.000Z',
  holdUntil: null,
  artifactLatestVersion: 2,
  artifactPublishedVersion: 1,
  publishedVersion: 1,
  reviewUrl: null,
  bundle: null,
  content: {
    purpose: 'Welcome series',
    goal: 'Activation',
    controlGroup: { percent: 0 },
    nodes: [],
  },
  publishedContent: null,
  diff: { from: 1, to: 2, changes: [] },
  history: [],
};

const next = { ...detail, id: 'apr_journey_next', artifactId: `jrn_${'b'.repeat(32)}`, artifactName: 'Next journey' };
h.details[detail.id] = detail;
h.details[next.id] = next;

function renderDrawer() {
  return render(
    <ToastProvider>
      <ApprovalDrawer id={detail.id} queue={[detail.id]} onClose={() => {}} onDecided={() => {}} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(cleanup);

describe('a journey review is viewed only after its graph mounts (#498 review)', () => {
  it('does not mark viewed while the lazy graph is cold-loading', async () => {
    h.mode = 'loading';
    renderDrawer();

    expect(await screen.findByRole('status', { name: 'Loading the journey graph' })).toBeTruthy();
    expect(wasViewed('usr_reviewer', detail.id, detail.version)).toBe(false);
  });

  it('never marks viewed when the graph fails to draw', async () => {
    h.mode = 'error';
    renderDrawer();

    expect(await screen.findByText('Couldn’t render this journey graph')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Loading the journey graph' })).toBeNull());
    expect(wasViewed('usr_reviewer', detail.id, detail.version)).toBe(false);
  });

  it('marks the exact version viewed once the graph has mounted', async () => {
    h.mode = 'ready';
    renderDrawer();

    expect(await screen.findByTestId('journey-graph')).toBeTruthy();
    await waitFor(() => expect(wasViewed('usr_reviewer', detail.id, detail.version)).toBe(true));
  });

  it('draws the next journey after the previous graph failed', async () => {
    h.mode = 'error';
    const view = renderDrawer();
    expect(await screen.findByText('Couldn’t render this journey graph')).toBeTruthy();

    h.mode = 'ready';
    view.rerender(
      <ToastProvider>
        <ApprovalDrawer id={next.id} queue={[detail.id, next.id]} onClose={() => {}} onDecided={() => {}} />
      </ToastProvider>,
    );
    expect(await screen.findByTestId('journey-graph')).toBeTruthy();
    await waitFor(() => expect(wasViewed('usr_reviewer', next.id, next.version)).toBe(true));
  });
});
