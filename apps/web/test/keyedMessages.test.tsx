import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Deferred, deferred, settle } from './keyedReadsSupport';

// #619: a Messages filter change is a new query. The previous query's rows, count and cursor must
// not stay on screen while the new one loads, and paging must restart from the new query.

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

vi.mock('../src/app/session', () => ({
  useSession: () => ({ can: () => true, user: { id: 'usr_msg' } }),
  useWorkspace: () => ({ can: () => true, user: { id: 'usr_msg' }, workspace: { id: 'ws_1' } }),
}));

import MessagesPage from '../src/pages/insights/MessagesPage';

const message = (id: string, channel: string, profileId: string) => ({
  id,
  channel,
  profileId,
  templateId: null,
  templateVersion: null,
  purpose: 'marketing_email',
  status: 'sent',
  reason: null,
  attempts: 1,
  nextAttemptAt: null,
  lastError: null,
  notBefore: null,
  segments: null,
  test: false,
  createdAt: '2026-11-05T10:00:00.000Z',
  events: [{ type: 'sent', at: '2026-11-05T10:00:01.000Z', reason: '', url: '' }],
});

const PRF_A = `prf_${'a'.repeat(32)}`;
const PRF_B = `prf_${'b'.repeat(32)}`;

const stats = (sent: number) => ({
  counts: { sent, delivered: sent - 1, opened: 0, clicked: 0, bounced: 0, complained: 0, decided: sent - 2 },
  rates: { delivered: 1, bounced: 0, complained: 0, clicked: 0, unsubscribed: 0 },
});

let smsList: Deferred<unknown>;
let stats7: Deferred<unknown>;

beforeEach(() => {
  h.calls.length = 0;
  smsList = deferred();
  stats7 = deferred();
  h.impl = (name, input) => {
    if (name === 'messages.stats') {
      if (input.days === 7) return stats7.promise;
      return Promise.resolve(stats(4242));
    }
    if (name === 'messages.list') {
      if (input.channel === 'sms') return smsList.promise;
      if (input.cursor === 'cur-a') return Promise.resolve({ messages: [message('msg_a2', 'email', PRF_A)], nextCursor: 'cur-a2' });
      return Promise.resolve({ messages: [message('msg_a1', 'email', PRF_A)], nextCursor: 'cur-a' });
    }
    throw new Error(`unexpected command ${name}`);
  };
});

afterEach(cleanup);

describe('messages belong to the selected filter (#619)', () => {
  it('drops the previous filter rows, count and cursor while the new filter loads', async () => {
    render(<MessagesPage />);

    expect(await screen.findByText(`${PRF_A.slice(0, 14)}…`)).toBeTruthy();
    expect(await screen.findByText(/1 message · more available/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getByText(/2 messages/)).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'sms' } });

    // The new query is pending: none of the old query's rows, count or paging may be shown.
    await waitFor(() => expect(screen.queryByText(`${PRF_A.slice(0, 14)}…`)).toBeNull());
    expect(screen.queryByText(/2 messages/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(screen.getByRole('status', { name: 'Loading list' })).toBeTruthy();

    await settle(smsList, { messages: [message('msg_b1', 'sms', PRF_B)], nextCursor: 'cur-b' });

    expect(await screen.findByText(`${PRF_B.slice(0, 14)}…`)).toBeTruthy();
    expect(screen.getByText(/1 message · more available/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(h.calls.filter((c) => c.name === 'messages.list').at(-1)?.input.cursor).toBe('cur-b'));
    const last = h.calls.filter((c) => c.name === 'messages.list').at(-1)!;
    expect(last.input.channel).toBe('sms');
  });

  it('clears the previous period counts while the new period loads', async () => {
    render(<MessagesPage />);

    expect(await screen.findByText('4,242')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Period'), { target: { value: '7' } });

    await waitFor(() => expect(screen.queryByText('4,242')).toBeNull());
    expect(screen.getByRole('status', { name: 'Sent' })).toBeTruthy();

    await settle(stats7, stats(7777));

    expect(await screen.findByText('7,777')).toBeTruthy();
    expect(screen.queryByText('4,242')).toBeNull();
  });
});
