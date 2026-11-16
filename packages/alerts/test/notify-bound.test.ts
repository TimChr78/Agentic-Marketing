import { type AlertNotification, schema } from '@agentic-marketing/db';
import { transportFor } from '@agentic-marketing/email';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type NotifyInput, notifyChannels, sendMemberEmails } from '../src/notify';

// #964: `sendMemberEmails` stored `redactCredentials(err.message).split('\n')[0]` with no length
// bound, so a provider's ~1 MiB single-line answer became the whole `messages.reason` and
// `alert_events.notified[].error`. Every other send path uses the e-mail package's `failureText`
// (300 characters); this one must too.

vi.mock('@agentic-marketing/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentic-marketing/email')>();
  return { ...actual, transportFor: vi.fn() };
});

// The failure is deliberately 1 MiB; do not write it to the test log.
vi.mock('@agentic-marketing/telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentic-marketing/telemetry')>();
  return { ...actual, logger: { ...actual.logger, warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } };
});

const SECRET = 'review_dummy_secret';
// Many short words, so the bare-token rule cannot collapse the message into one marker: only the
// length bound keeps this out of the column.
const HUGE = `provider refused the message: ${'bad '.repeat(300_000)}password=${SECRET}`;

const WS = `ws_${'1'.repeat(32)}`;
const USER = `usr_${'2'.repeat(32)}`;
const at = new Date('2026-10-30T09:00:00.000Z');

const input: NotifyInput = {
  workspace: { id: WS, name: 'Alerts' },
  rule: {
    id: `alr_${'a'.repeat(32)}`,
    name: 'Bounce rate',
    kind: 'deliverability',
    config: { metric: 'bounce', window: 'PT24H', threshold: 0.05 },
  },
  eventId: 'evt_1',
  event: 'firing',
  value: 0.08,
  threshold: 0.05,
  window: 'PT24H',
  now: at,
};

/** A transaction just wide enough for `sendMemberEmails`: selects, an insert and updates. */
function fakeTx() {
  const updates: Record<string, unknown>[] = [];
  const inserts: Record<string, unknown>[] = [];
  const tx = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === schema.workspaceMembers) return Promise.resolve([{ userId: USER }]);
          if (table === schema.emailProviders)
            return Promise.resolve([
              {
                id: 'prv_1',
                enabled: true,
                useFor: ['transactional'],
                fromEmail: 'alerts@example.com',
                fromName: 'Alerts',
                replyTo: null,
              },
            ]);
          return Promise.resolve([]); // no existing message row
        },
      }),
    }),
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        inserts.push(row);
      },
    }),
    update: () => ({
      set: (row: Record<string, unknown>) => {
        updates.push(row);
        return { where: async () => undefined };
      },
    }),
  };
  return { tx: tx as never, updates, inserts };
}

const deps = () => ({
  kp: {} as never,
  email: { adapterDeps: { fetch: async () => new Response('{}') } } as never,
  directory: { users: async () => new Map([[USER, { email: 'member@example.com', name: 'Member' }]]) },
  publicUrl: 'https://am.example.com',
});

beforeEach(() => {
  vi.mocked(transportFor).mockResolvedValue({
    send: async () => {
      throw new Error(HUGE);
    },
    close: async () => undefined,
  });
});

describe('a failed member e-mail stores a bounded reason (#964)', () => {
  it('cuts a 1 MiB single-line provider error in messages.reason and the returned error', async () => {
    const { tx, updates } = fakeTx();
    const results = await sendMemberEmails(tx, deps(), WS, [
      { userId: USER, idempotencyKey: `alert:evt_1:firing:${USER}`, subject: 'Alert', html: '<p>Alert</p>', text: 'Alert' },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('failed');
    const error = results[0]?.error ?? '';
    expect(error.startsWith('provider refused the message:')).toBe(true);
    expect(error).not.toContain(SECRET);
    expect(error.length).toBeLessThanOrEqual(300);

    const reason = updates.find((u) => u.status === 'failed')?.reason as string;
    expect(reason.startsWith('provider_error: ')).toBe(true);
    expect(reason).not.toContain(SECRET);
    expect(reason.length).toBeLessThanOrEqual('provider_error: '.length + 300);
  });

  it('passes the bounded error into the alert notification ledger', async () => {
    const { tx } = fakeTx();
    const notifications: AlertNotification[] = await notifyChannels(tx, deps(), input, [{ type: 'email', userIds: [USER] }]);
    expect(notifications).toHaveLength(1);
    const error = notifications[0]?.error ?? '';
    expect(notifications[0]?.status).toBe('failed');
    expect(error).not.toContain(SECRET);
    expect(error.length).toBeLessThanOrEqual(300);
  });

  it('bounds a failed transport creation the same way', async () => {
    vi.mocked(transportFor).mockRejectedValue(new Error(HUGE));
    const { tx } = fakeTx();
    const results = await sendMemberEmails(tx, deps(), WS, [
      { userId: USER, idempotencyKey: `alert:evt_1:firing:${USER}`, subject: 'Alert', html: '<p>Alert</p>', text: 'Alert' },
    ]);
    expect(results[0]?.status).toBe('failed');
    expect(results[0]?.error?.length).toBeLessThanOrEqual(300);
    expect(results[0]?.error).not.toContain(SECRET);
  });
});
