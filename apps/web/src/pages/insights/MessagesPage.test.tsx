import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPurposesCache } from '../../features/audience/phase26/usePurposes';
import MessagesPage from './MessagesPage';

// The Purpose column names the purpose a message was sent under (#793). A workspace can define
// custom purposes, so the list must load `purposes.list` and pass it to the shared label helper;
// without it the fallback calls every custom purpose "Unavailable purpose".

const h = vi.hoisted(() => ({
  purposes: { source: 'published', purposes: [] as { key: string; name: string }[] },
  purposeError: null as Error | null,
}));

vi.mock('../../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string) => {
        if (name === 'messages.list')
          return {
            messages: [
              {
                id: 'msg_1',
                channel: 'email',
                profileId: null,
                templateId: null,
                templateVersion: null,
                purpose: 'product_updates',
                status: 'delivered',
                reason: null,
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
        if (name === 'purposes.list') {
          if (h.purposeError) throw h.purposeError;
          return h.purposes;
        }
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../../app/session', () => ({
  useSession: () => ({
    can: () => true,
    workspace: { id: 'ws_1' },
    user: { id: 'u1' },
  }),
}));

const text = () => document.body.textContent ?? '';

describe('messages list purpose labels (#793)', () => {
  beforeEach(() => {
    resetPurposesCache();
    h.purposeError = null;
    h.purposes = {
      source: 'published',
      purposes: [
        {
          key: 'product_updates',
          name: 'Product updates',
          basis: 'consent',
          channels: ['email'],
          description: '',
          requiresDoubleOptIn: false,
          topics: [],
        },
      ] as never,
    };
  });

  it('shows the name of a custom workspace purpose instead of "Unavailable purpose"', async () => {
    render(<MessagesPage />);
    await waitFor(() => expect(screen.getByRole('table', { name: 'Messages' })).toBeTruthy());

    expect(text()).toContain('Product updates');
    expect(text()).not.toContain('Unavailable purpose');
  });

  it('keeps a default purpose name and falls back only for an unknown key', async () => {
    h.purposes = { source: 'default', purposes: [] };
    render(<MessagesPage />);
    await waitFor(() => expect(screen.getByRole('table', { name: 'Messages' })).toBeTruthy());

    // A key no published purpose explains is still reported as unavailable rather than guessed.
    expect(text()).toContain('Unavailable purpose');
  });
});
