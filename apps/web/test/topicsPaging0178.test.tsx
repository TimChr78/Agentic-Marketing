import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #1262: the heading counted the rows of one page and the rest were unreachable, although the
// command returns `count` and accepts `offset`.

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
  it('shows the server total and loads the rest with offset', async () => {
    h.impl = async (name, input) => {
      if (name !== 'content.topics.list') throw new Error(`unexpected ${name}`);
      if (input.offset === 200) return { count: 240, topics: Array.from({ length: 40 }, (_, i) => topic(201 + i)) };
      return { count: 240, topics: Array.from({ length: 200 }, (_, i) => topic(i + 1)) };
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
    expect(second.input).toMatchObject({ offset: 200 });
    expect(screen.getByText('240 topics')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: /load more/i })).toBeNull());
  });
});
