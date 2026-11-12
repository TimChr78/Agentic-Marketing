import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebhooksCard } from '../src/features/integrations/WebhooksCard';
import { ToastProvider } from '../src/ui';

// #615: the card used to ask for one mixed-kind page of 100 rows and filter `kind === 'webhook'`
// in the browser. With more than 100 newer action deliveries the page held no webhook row, so the
// endpoint's last delivery showed "Never". The read must be kind-scoped on the server.

const h = vi.hoisted(() => ({
  calls: [] as { name: string; input: Record<string, unknown> }[],
}));

const actionDelivery = (n: number) => ({
  id: `dlv_action_${n}`,
  kind: 'action',
  targetId: 'con_1',
  action: 'postMessage',
  status: 'done',
  attempts: 1,
  nextAttemptAt: '2026-11-07T09:00:00Z',
  statusCode: 200,
  error: null,
  durationMs: 10,
  payload: {},
  response: {},
  createdAt: `2026-11-07T09:59:${String(n % 60).padStart(2, '0')}Z`,
});

const webhookDelivery = {
  id: 'dlv_webhook_1',
  kind: 'webhook',
  targetId: 'wh_1',
  action: null,
  status: 'failed',
  attempts: 3,
  nextAttemptAt: '2026-11-07T09:00:00Z',
  statusCode: 500,
  error: 'Connection refused',
  durationMs: 120,
  payload: { type: 'event.track' },
  response: null,
  createdAt: '2026-11-07T09:00:00Z',
};

vi.mock('../src/app/session', () => {
  const workspace = {
    id: 'ws_1',
    name: 'Northstar Journal',
    you: { type: 'user', userId: 'u1', role: 'owner', permissions: ['workspace:admin', 'artifacts:read'] },
    permissionsExplained: [],
  };
  return {
    useSession: () => ({ can: () => true, workspace, user: { id: 'u1', name: 'Sam', email: 'sam@example.com' } }),
    useWorkspace: () => ({
      can: () => true,
      workspace,
      user: { id: 'u1', name: 'Sam', email: 'sam@example.com' },
      memberships: [{ id: 'ws_1', name: 'Northstar Journal', role: 'owner', brand: {} }],
      refresh: async () => {},
    }),
  };
});

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: Record<string, unknown>) => {
        h.calls.push({ name, input });
        switch (name) {
          case 'webhooks.list':
            return {
              endpoints: [
                {
                  id: 'wh_1',
                  name: 'Order events',
                  url: 'https://hooks.example.com/am',
                  events: ['order.completed'],
                  purpose: null,
                  enabled: true,
                },
              ],
            };
          case 'deliveries.list':
            // The server-side filter the fix asks for: only a kind-scoped read can see the webhook
            // row past the 100 newer action deliveries.
            return { deliveries: input.kind === 'webhook' ? [webhookDelivery] : Array.from({ length: 100 }, (_, i) => actionDelivery(i)) };
          default:
            throw new Error(`unexpected command ${name}`);
        }
      }),
    },
    errText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  h.calls = [];
});

describe('WebhooksCard deliveries (#615)', () => {
  it('asks for webhook deliveries and shows the real last delivery instead of "Never"', async () => {
    render(
      <ToastProvider>
        <WebhooksCard />
      </ToastProvider>,
    );

    // Wait for the endpoint row itself, so "Never" is only asserted once the table has rendered.
    expect((await screen.findAllByText('Order events')).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByText('Never')).toBeNull());
    expect(h.calls.find((c) => c.name === 'deliveries.list')?.input).toMatchObject({ kind: 'webhook' });
    // The endpoint's "Last delivery" is its own read, narrowed by targetId (#615).
    expect(h.calls.some((c) => c.name === 'deliveries.list' && c.input.targetId === 'wh_1' && c.input.kind === 'webhook')).toBe(true);
  });
});
