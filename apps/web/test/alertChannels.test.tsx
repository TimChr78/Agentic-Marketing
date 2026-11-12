import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #601: editing a rule must round-trip its channel list. Renaming a rule that notifies two separate
// e-mail channels must save those two channels again, not flatten them into one.

const h = vi.hoisted(() => ({
  calls: [] as { name: string; input: Record<string, unknown> }[],
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn((name: string, input: Record<string, unknown>) => {
        h.calls.push({ name, input });
        if (name === 'alerts.list')
          return Promise.resolve({
            rules: [
              {
                id: RULE,
                name: 'Two channels',
                kind: 'deliverability',
                config: { metric: 'bounce', window: 'PT24H', threshold: 0.05, minSent: 100 },
                channels: CHANNELS,
                enabled: true,
                createdBy: 'usr_ops',
                createdAt: '2026-11-01T09:00:00.000Z',
                updatedAt: '2026-11-01T09:00:00.000Z',
                state: 'ok',
                firingSince: null,
              },
            ],
          });
        if (name === 'webhooks.list') return Promise.resolve({ endpoints: [] });
        if (name === 'members.list')
          return Promise.resolve({
            members: [
              { userId: 'usr_a', email: 'a@example.com', name: 'Ada', role: 'owner' },
              { userId: 'usr_b', email: 'b@example.com', name: 'Grace', role: 'marketer' },
              { userId: 'usr_c', email: 'c@example.com', name: 'Linus', role: 'viewer' },
            ],
          });
        if (name === 'artifacts.list') return Promise.resolve({ artifacts: [], total: 0, nextCursor: null });
        if (name === 'alerts.history') return Promise.resolve({ events: [] });
        if (name === 'alerts.update') return Promise.resolve({ rule: { id: RULE } });
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../src/app/session', () => ({
  useSession: () => ({ can: () => true, user: { id: 'usr_ops' } }),
  useWorkspace: () => ({ can: () => true, user: { id: 'usr_ops' }, workspace: { id: 'ws_1' } }),
}));

import AlertsPage from '../src/pages/insights/AlertsPage';
import { ToastProvider } from '../src/ui/toast';

const RULE = `alr_${'a'.repeat(32)}`;
const CHANNELS = [
  { type: 'email' as const, userIds: ['usr_a'] },
  { type: 'email' as const, userIds: ['usr_b', 'usr_c'] },
];

beforeEach(() => {
  h.calls.length = 0;
});

afterEach(cleanup);

describe('alert channel round-trip (#601)', () => {
  it('saves a rule renamed without touching notifications with its two e-mail channels intact', async () => {
    render(
      <ToastProvider>
        <AlertsPage />
      </ToastProvider>,
    );

    expect(await screen.findByText('Two channels')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    const name = await screen.findByDisplayValue('Two channels');
    fireEvent.change(name, { target: { value: 'Renamed rule' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(h.calls.some((c) => c.name === 'alerts.update')).toBe(true));
    const update = h.calls.find((c) => c.name === 'alerts.update');
    expect(update?.input).toMatchObject({ id: RULE, name: 'Renamed rule' });
    expect(update?.input.channels).toEqual(CHANNELS);
    expect(JSON.stringify(update?.input.channels)).toBe(JSON.stringify(CHANNELS));
  });
});
