import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeliveryEvent } from '../../../packages/email/src/adapters';
import { applyDeliveryEvents } from '../../../packages/email/src/deliveryEvents';
import { eventually, startTestServer, testPort, type User } from './harness';

// #960: the #928 future-clamp bounded the consent write only. The same payload's provider time was
// still written raw into the message event, `messages.sent_at` and the suppression row, so a
// replayed or misconfigured webhook carrying a far-future `at` skewed deliverability trends and put
// an impossible date on the suppression list. The provider's time is now clamped once, before any
// write, and a past time is kept exactly as the provider reported it.

const PORT = testPort(3506);
const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2026-01-05T08:30:00.000Z';

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let profileId = '';
let emailHash = '';

const api = () => t.api(owner, ws);

/** A message the delivery worker will not claim: it is already `sending`, not `queued`. */
async function waitingMessage(id: string): Promise<void> {
  await t.srv.db.admin.query(
    `INSERT INTO messages (workspace_id, id, idempotency_key, channel, profile_id, purpose, status, recipient_hash)
     VALUES ($1, $2, $3, 'email', $4, 'marketing_email', 'sending', $5)`,
    [ws, id, `clamp-${id}`, profileId, emailHash],
  );
}

const apply = (events: DeliveryEvent[]) => t.srv.db.withWorkspace(ws, (tx) => applyDeliveryEvents(tx, events, 'test', t.srv.keyProvider));

const messageRow = async (id: string) =>
  (
    await t.srv.db.admin.query<{ sent_at: Date | null; status: string }>(
      'SELECT sent_at, status FROM messages WHERE workspace_id = $1 AND id = $2',
      [ws, id],
    )
  ).rows[0]!;

const suppressionAt = async () =>
  (await t.srv.db.admin.query<{ at: Date }>('SELECT at FROM suppressions WHERE workspace_id = $1 AND value_hash = $2', [ws, emailHash]))
    .rows[0]?.at;

const lastConsentAt = async () =>
  (
    await t.srv.db.admin.query<{ recorded_at: Date }>(
      `SELECT recorded_at FROM consent_records WHERE workspace_id = $1 AND profile_id = $2
       ORDER BY recorded_at DESC, id DESC LIMIT 1`,
      [ws, profileId],
    )
  ).rows[0]?.recorded_at;

beforeAll(async () => {
  t = await startTestServer('test_v01424_event_clamp', PORT);
  owner = await t.signUp(`owner-event-clamp-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const key = (await api().call('sources.create', { name: 'Backend', kind: 'server' })).key;
  await fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({ batch: [{ type: 'identify', userId: 'clamp-1', traits: { email: 'clamp@example.com' } }] }),
  });
  profileId = (
    await eventually(
      () => api().call('profiles.find', { type: 'user_id', value: 'clamp-1' }),
      (r) => !!r.profileId,
    )
  ).profileId!;
  await api().call('consent.record', { profileId, purpose: 'marketing_email', status: 'granted' });
  emailHash = (
    await t.srv.db.admin.query<{ value: string }>(
      `SELECT value FROM identifiers WHERE workspace_id = $1 AND profile_id = $2 AND type = 'email'`,
      [ws, profileId],
    )
  ).rows[0]!.value;
}, 120_000);

afterAll(() => t?.close());

describe('a provider callback’s time is clamped before it is stored (#960)', () => {
  it('writes a future event, sentAt, suppression and consent time no later than now', async () => {
    const id = 'msg_clamp_future';
    await waitingMessage(id);
    const now = Date.now();
    const result = await apply([{ eventId: 'clamp-future', type: 'complained', messageId: id, at: FUTURE }]);
    expect(result.events).toHaveLength(1);
    expect(Date.parse(result.events[0]!.at)).toBeLessThanOrEqual(now + 1_000);
    const row = await messageRow(id);
    expect(row.status).toBe('complained');
    expect(row.sent_at!.getTime()).toBeLessThanOrEqual(now + 1_000);
    expect((await suppressionAt())!.getTime()).toBeLessThanOrEqual(now + 1_000);
    expect((await lastConsentAt())!.getTime()).toBeLessThanOrEqual(now + 1_000);
  }, 60_000);

  it('keeps a past event time exactly as the provider reported it', async () => {
    // A different address, so the suppression row of the first test does not answer this one.
    const other = 'clamp-past@example.com';
    await fetch(`${t.base}/v1/batch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`${(await api().call('sources.create', { name: 'Past', kind: 'server' })).key}:`).toString('base64')}`,
      },
      body: JSON.stringify({ batch: [{ type: 'identify', userId: 'clamp-2', traits: { email: other } }] }),
    });
    const pastProfile = (
      await eventually(
        () => api().call('profiles.find', { type: 'user_id', value: 'clamp-2' }),
        (r) => !!r.profileId,
      )
    ).profileId!;
    await api().call('consent.record', { profileId: pastProfile, purpose: 'marketing_email', status: 'granted' });
    const pastHash = (
      await t.srv.db.admin.query<{ value: string }>(
        `SELECT value FROM identifiers WHERE workspace_id = $1 AND profile_id = $2 AND type = 'email'`,
        [ws, pastProfile],
      )
    ).rows[0]!.value;

    const id = 'msg_clamp_past';
    await t.srv.db.admin.query(
      `INSERT INTO messages (workspace_id, id, idempotency_key, channel, profile_id, purpose, status, recipient_hash)
       VALUES ($1, $2, $3, 'email', $4, 'marketing_email', 'sending', $5)`,
      [ws, id, `clamp-${id}`, pastProfile, pastHash],
    );
    const result = await apply([{ eventId: 'clamp-past', type: 'delivered', messageId: id, at: PAST }]);
    expect(result.events[0]!.at).toBe(PAST);
    expect((await messageRow(id)).sent_at!.toISOString()).toBe(PAST);
    // A complaint at the same past time lands on the suppression row unchanged.
    const complaint = await apply([{ eventId: 'clamp-past-complaint', type: 'complained', messageId: id, at: PAST }]);
    expect(complaint.events[0]!.at).toBe(PAST);
    const at = (
      await t.srv.db.admin.query<{ at: Date }>('SELECT at FROM suppressions WHERE workspace_id = $1 AND value_hash = $2', [ws, pastHash])
    ).rows[0]!.at;
    expect(at.toISOString()).toBe(PAST);
  }, 60_000);
});
