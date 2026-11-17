import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// #978 part 2b: `profiles.erase` commits the SQL deletion and a cleanup job in one transaction.
// The job removes ClickHouse events and hot state afterwards, but only once no outbox row for the
// person is undelivered: an in-flight publisher must not recreate their events after the sweep.

type Server = Awaited<ReturnType<typeof startTestServer>>;

const sendOn = (base: string, key: string, batch: unknown[]) =>
  fetch(`${base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({ batch }),
  });

describe('durable erasure against ClickHouse (#978 part 2b)', () => {
  let t: Server;
  let owner: User;
  let ws = '';
  let key = '';
  const send = (batch: unknown[]) => sendOn(t.base, key, batch);

  beforeAll(async () => {
    t = await startTestServer('test_durable_erasure', testPort(3479));
    owner = await t.signUp(`owner-${Date.now()}@example.com`);
    ws = await t.workspaceWith([[owner, 'owner']]);
    key = (await t.api(owner).call('sources.create', { name: 'Backend', kind: 'server' })).key;
  }, 60_000);
  afterAll(() => t?.close());

  it('waits for an in-flight publisher, then leaves nothing in ClickHouse', async () => {
    const api = t.api(owner);
    await send([{ type: 'identify', userId: 'u-durable', traits: { plan: 'pro' } }]);
    const { profileId } = await eventually(
      () => api.call('profiles.find', { type: 'user_id', value: 'u-durable' }),
      (r) => !!r.profileId,
    );
    // An outbox publisher has claimed an event for this person but not finished delivering it.
    await t.srv.db.admin.query(
      `INSERT INTO outbox (workspace_id, id, kind, payload, operation_key, state, subject_ref)
       VALUES ($1, 'obx_durable_inflight', 'message_event', $2, 'durable-inflight', 'delivering', 'subject-unrelated')`,
      [ws, JSON.stringify({ events: [{ workspaceId: ws, profileId, type: 'sent' }] })],
    );

    const erased = await api.call('profiles.erase', { profileId: profileId!, reason: 'Durable erasure test' });
    expect(erased).toMatchObject({ status: 'pending', counts: { profiles: 1 } });
    // The SQL rows are gone at once, but the external sweep waits for the publisher.
    expect((await api.call('profiles.find', { type: 'user_id', value: 'u-durable' })).profileId).toBeNull();
    const waiting = await eventually(
      () => api.call('profiles.erasureStatus', { erasureId: erased.erasureId }),
      (s) => s.status === 'pending',
    );
    expect(waiting.checkpoints.clickhouse).toBe(false);
    expect(await t.srv.events.eventsOf(ws, { anonymousIds: [], userIds: ['u-durable'] })).not.toEqual([]);

    // The publisher commits; the deferred job is due again and sweeps the events.
    await t.srv.db.admin.query("UPDATE outbox SET state = 'delivered' WHERE operation_key = 'durable-inflight'");
    await t.srv.db.admin.query('UPDATE erasure_cleanup_jobs SET next_attempt_at = now() WHERE workspace_id = $1 AND erasure_id = $2', [
      ws,
      erased.erasureId,
    ]);
    const complete = await eventually(
      () => api.call('profiles.erasureStatus', { erasureId: erased.erasureId }),
      (s) => s.status === 'complete',
    );
    expect(complete.checkpoints).toEqual({ clickhouse: true, hotState: true });
    expect(await t.srv.events.eventsOf(ws, { anonymousIds: [], userIds: ['u-durable'] })).toEqual([]);
  });
});
