import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPurposesCache } from '../src/features/audience/phase26/usePurposes';

// #1260: the Messages page printed raw API keys (channels, statuses, event types) as labels.

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string) => {
        if (name === 'messages.list')
          return {
            messages: [
              {
                id: 'msg_1',
                channel: 'sms',
                profileId: null,
                templateId: null,
                templateVersion: null,
                purpose: 'marketing_email',
                status: 'delivered',
                reason: null,
                attempts: 1,
                nextAttemptAt: null,
                lastError: null,
                notBefore: null,
                segments: null,
                test: false,
                createdAt: '2026-11-10T09:00:00Z',
                events: [{ type: 'provider_accepted', at: '2026-11-10T09:01:00Z', reason: '' }],
              },
              {
                id: 'msg_2',
                channel: 'email',
                profileId: null,
                templateId: null,
                templateVersion: null,
                purpose: 'marketing_email',
                status: 'failed',
                reason: 'unknown_outcome: the worker stopped while sending; check the provider before resending',
                attempts: 1,
                nextAttemptAt: null,
                lastError: null,
                notBefore: null,
                segments: null,
                test: false,
                createdAt: '2026-11-10T09:00:00Z',
                events: [],
              },
            ],
            nextCursor: null,
          };
        if (name === 'messages.stats') return { counts: { sent: 1, delivered: 1, decided: 1 }, rates: {} };
        if (name === 'purposes.list') return { source: 'published', purposes: [] };
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../src/app/session', () => {
  const session = () => ({ can: () => true, user: { id: 'usr_1' }, workspace: { id: 'ws_1' } });
  return { useSession: session, useWorkspace: session };
});

import MessagesPage from '../src/pages/insights/MessagesPage';

beforeEach(() => resetPurposesCache());

afterEach(cleanup);

describe('messages page labels (#1260)', () => {
  it('names channels, statuses and event types in words instead of raw keys', async () => {
    render(<MessagesPage />);
    const table = await screen.findByRole('table', { name: 'Messages' });

    await waitFor(() => expect(within(table).getByText('Delivered')).toBeTruthy());
    expect(within(table).getByText('SMS')).toBeTruthy();
    expect(within(table).getByText(/Provider accepted/)).toBeTruthy();

    // A known reason code is translated and keeps its recovery guidance (#1260 review).
    expect(within(table).getByText(/Outcome unknown: the worker stopped while sending/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('unknown_outcome');
    expect(document.body.textContent).not.toContain('provider_accepted');
    expect(document.body.textContent).not.toContain('delivered');
    expect(document.body.textContent).not.toContain('sms');
  });

  it('labels the channel and status pickers in words too', async () => {
    render(<MessagesPage />);
    await screen.findByRole('table', { name: 'Messages' });

    const channel = screen.getByLabelText('Channel');
    expect(within(channel).getByRole('option', { name: 'E-mail' })).toBeTruthy();
    expect(within(channel).getByRole('option', { name: 'SMS' })).toBeTruthy();
    expect(within(channel).getByRole('option', { name: 'Push' })).toBeTruthy();
    expect(within(channel).queryByRole('option', { name: 'sms' })).toBeNull();

    const status = screen.getByLabelText('Status');
    expect(within(status).getByRole('option', { name: 'Delivered' })).toBeTruthy();
    expect(within(status).queryByRole('option', { name: 'delivered' })).toBeNull();
  });
});
