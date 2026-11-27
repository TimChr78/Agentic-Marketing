import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #1262: the heading counted the rows of one page and the rest were unreachable. The command now
// returns the real `total` and a keyset `nextCursor`; `count` stays the page length.

const h = vi.hoisted(() => ({
  impl: null as null | ((name: string, input: Record<string, unknown>) => Promise<unknown>),
  calls: [] as { name: string; input: Record<string, unknown> }[],
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn((name: string, input: Record<string, unknown>) => {
        h.calls.push({ name, input });
        if (!h.impl) throw new Error(`unexpected command ${name}`);
        return h.impl(name, input);
      }),
    },
  };
});

vi.mock('../src/app/session', () => {
  const session = () => ({ can: () => true, user: { id: 'usr_1' }, workspace: { id: 'ws_1' } });
  return { useSession: session, useWorkspace: session };
});

import TopicsPage from '../src/pages/build/TopicsPage';
import { ToastProvider } from '../src/ui';

const topic = (n: number, id = `ctp_${String(n).padStart(32, '0')}`) => ({
  id,
  title: `Topic ${n}`,
  angle: '',
  audience: '',
  readerRole: '',
  keyword: null,
  tags: [],
  status: 'idea',
  score: 0,
  signals: [],
  ownerId: null,
  ownerName: null,
  targetDate: null,
  canonicalUrl: null,
  campaignId: null,
  broadcastId: null,
  dedupeKey: `topic-${n}`,
  similarTopicIds: [],
  briefArtifactId: null,
  createdBy: { type: 'user', id: 'usr_1' },
  agentId: null,
  createdAt: '2026-11-10T09:00:00.000Z',
  updatedAt: '2026-11-10T09:00:00.000Z',
});

beforeEach(() => {
  h.impl = null;
  h.calls.length = 0;
});

afterEach(cleanup);

describe('Topics backlog paging (#1262)', () => {
  it('shows the server total and loads the rest with the continuation cursor', async () => {
    h.impl = async (name, input) => {
      if (name !== 'content.topics.list') throw new Error(`unexpected ${name}`);
      if (input.cursor === 'topic-page-2')
        return { count: 40, total: 240, nextCursor: null, topics: Array.from({ length: 40 }, (_, i) => topic(201 + i)) };
      return { count: 200, total: 240, nextCursor: 'topic-page-2', topics: Array.from({ length: 200 }, (_, i) => topic(i + 1)) };
    };

    render(
      <ToastProvider>
        <TopicsPage />
      </ToastProvider>,
    );

    await screen.findAllByText('Topic 200');
    expect(screen.getByText('240 topics')).toBeTruthy();
    expect(screen.queryByText('200 topics')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /load more/i }));
    await screen.findAllByText('Topic 240');

    const second = h.calls.filter((c) => c.name === 'content.topics.list')[1]!;
    expect(second.input).toMatchObject({ cursor: 'topic-page-2' });
    expect(screen.getByText('240 topics')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: /load more/i })).toBeNull());
  });

  it('restarts paging from the first page after archiving a topic', async () => {
    h.impl = async (name, input) => {
      if (name === 'content.topics.archive') return { topic: topic(2) };
      if (name !== 'content.topics.list') throw new Error(`unexpected ${name}`);
      if (input.cursor === 'topic-page-2') return { count: 2, total: 4, nextCursor: null, topics: [topic(3), topic(4)] };
      // The archive invalidates the loaded second page, so the reload is a fresh first page.
      return { count: 2, total: 3, nextCursor: 'topic-page-2', topics: [topic(1), topic(2)] };
    };

    render(
      <ToastProvider>
        <TopicsPage />
      </ToastProvider>,
    );

    await screen.findAllByText('Topic 1');
    await userEvent.click(screen.getByRole('button', { name: /load more/i }));
    await screen.findAllByText('Topic 4');

    await userEvent.click(screen.getByRole('button', { name: 'Archive Topic 2' }));

    await waitFor(() => expect(screen.queryByText('Topic 4')).toBeNull());
    expect(screen.queryByText('Topic 3')).toBeNull();
    expect(screen.getByText('Topic 1')).toBeTruthy();
    const calls = h.calls.filter((c) => c.name === 'content.topics.list');
    const reload = calls[calls.length - 1]!;
    expect(reload.input).not.toHaveProperty('cursor');
    expect(reload.input).not.toHaveProperty('offset');
  });

  it('drops a Load more page that lands after an archive reset the list', async () => {
    let resolvePage2: ((value: unknown) => void) | undefined;
    h.impl = async (name, input) => {
      if (name === 'content.topics.archive') return { topic: topic(2) };
      if (name !== 'content.topics.list') throw new Error(`unexpected ${name}`);
      if (input.cursor === 'topic-page-2')
        return new Promise((resolve) => {
          resolvePage2 = resolve;
        });
      return { count: 2, total: 3, nextCursor: 'topic-page-2', topics: [topic(1), topic(2)] };
    };

    render(
      <ToastProvider>
        <TopicsPage />
      </ToastProvider>,
    );

    await screen.findAllByText('Topic 1');
    await userEvent.click(screen.getByRole('button', { name: /load more/i }));
    // Archiving while the second page is in flight resets the list and starts a fresh first page.
    await userEvent.click(screen.getByRole('button', { name: 'Archive Topic 2' }));

    await act(async () => {
      resolvePage2?.({ count: 1, total: 3, nextCursor: null, topics: [topic(3)] });
      await Promise.resolve();
    });

    // The late page belonged to the list before the archive; it must not reappear.
    expect(screen.queryByText('Topic 3')).toBeNull();
    expect(screen.getByText('Topic 1')).toBeTruthy();
  });
});
