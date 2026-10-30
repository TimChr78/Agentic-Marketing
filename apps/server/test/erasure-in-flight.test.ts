import { newUuid } from '@agentic-marketing/core';
import type { BusEvent } from '@agentic-marketing/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// A person erased while events naming them are still in flight (or arrive late) must not come back.
// The platform's own events never create a profile (#203); customer events dated before the
// erasure plus the grace window are dropped too, because erasure stored keyed-hash tombstones of
// the person's identifiers (#210). After the window, the same id is a new person.

type Server = Awaited<ReturnType<typeof startTestServer>>;

const sendOn = (base: string, key: string, batch: unknown[]) =>
  fetch(`${base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({ batch }),
  });

const busEvent = (workspaceId: string, sourceId: string, userId: string, name: string, at: string): BusEvent => ({
  workspaceId,
  sourceId,
  messageId: `test:${userId}:${newUuid()}`,
  type: 'track',
  name,
  anonymousId: '',
  userId,
  timestamp: at,
  receivedAt: at,
  properties: {},
  traits: {},
  piiTraits: {},
  context: {},
  consent: {},
});

const systemEvent = (workspaceId: string, userId: string, profileId: string, name: string): BusEvent => ({
  ...busEvent(workspaceId, 'system', userId, name, new Date().toISOString()),
  properties: { segment_id: 'seg_test', profile_id: profileId },
});

/** A normal customer event, as an ingest worker would put it on the bus. */
const customerEvent = (workspaceId: string, userId: string, at: string): BusEvent =>
  busEvent(workspaceId, 'src_queued', userId, 'Page Viewed', at);

describe('an erased person with the default grace window', () => {
  let t: Server;
  let owner: User;
  let ws = '';
  let key = '';
  const send = (batch: unknown[]) => sendOn(t.base, key, batch);

  beforeAll(async () => {
    t = await startTestServer('test_erasure_in_flight', testPort(3477));
    owner = await t.signUp(`owner-${Date.now()}@example.com`);
    ws = await t.workspaceWith([[owner, 'owner']]);
    key = (await t.api(owner).call('sources.create', { name: 'Backend', kind: 'server' })).key;
  }, 60_000);
  afterAll(() => t?.close());

  it('is not recreated by a segment event that was still in flight', async () => {
    const api = t.api(owner);
    await send([{ type: 'identify', userId: 'gone', traits: { plan: 'pro' } }]);
    const { profileId } = await eventually(
      () => api.call('profiles.find', { type: 'user_id', value: 'gone' }),
      (r) => !!r.profileId,
    );
    await api.call('profiles.erase', { profileId: profileId!, reason: 'Erasure request, test' });

    await t.srv.bus.publish([systemEvent(ws, 'gone', profileId!, 'Segment Exited')]);
    // A later customer event proves the worker has processed the bus past the system event.
    await send([{ type: 'identify', userId: 'still-here', traits: { plan: 'free' } }]);
    await eventually(
      () => api.call('profiles.find', { type: 'user_id', value: 'still-here' }),
      (r) => !!r.profileId,
    );
    expect((await api.call('profiles.find', { type: 'user_id', value: 'gone' })).profileId).toBeFalsy();
  });

  it('is not recreated by a customer event still on the bus, dated before the erasure', async () => {
    const api = t.api(owner);
    const happenedAt = new Date().toISOString();
    await send([{ type: 'identify', userId: 'queued-gone', traits: { plan: 'pro' } }]);
    const { profileId } = await eventually(
      () => api.call('profiles.find', { type: 'user_id', value: 'queued-gone' }),
      (r) => !!r.profileId,
    );
    await api.call('profiles.erase', { profileId: profileId!, reason: 'Erasure request, test' });

    // The page view happened before the erasure but only reaches the profile worker now.
    await t.srv.bus.publish([customerEvent(ws, 'queued-gone', happenedAt)]);
    // A later customer event proves the worker has processed the bus past the erased one.
    await send([{ type: 'identify', userId: 'later-visitor', traits: { plan: 'free' } }]);
    await eventually(
      () => api.call('profiles.find', { type: 'user_id', value: 'later-visitor' }),
      (r) => !!r.profileId,
    );
    expect((await api.call('profiles.find', { type: 'user_id', value: 'queued-gone' })).profileId).toBeFalsy();
  });

  it('keeps only keyed hashes of the erased identifiers in its tombstones', async () => {
    const { rows } = await t.srv.db.admin.query<{ ident_hash: string }>(
      'SELECT ident_hash FROM erasure_tombstones WHERE workspace_id = $1',
      [ws],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.ident_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.ident_hash).not.toContain('queued-gone');
      expect(row.ident_hash).not.toContain('gone');
    }
    const raw = await t.srv.db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM erasure_tombstones
       WHERE workspace_id = $1 AND (ident_hash LIKE '%queued-gone%' OR erasure_id LIKE '%queued-gone%')`,
      [ws],
    );
    expect(raw.rows[0].n).toBe(0);
  });
});

describe('after the grace window', () => {
  let t: Server;
  let owner: User;
  let ws = '';
  let key = '';
  const send = (batch: unknown[]) => sendOn(t.base, key, batch);
  const tombstones = async () =>
    (
      await t.srv.db.admin.query<{ ident_hash: string; erasure_id: string }>(
        'SELECT ident_hash, erasure_id FROM erasure_tombstones WHERE workspace_id = $1 ORDER BY ident_hash',
        [ws],
      )
    ).rows;

  beforeAll(async () => {
    // No grace window: an event after the erasure is new activity, as it is after the default
    // window has passed.
    t = await startTestServer('test_erasure_grace_zero', testPort(3478), { ERASURE_GRACE_HOURS: '0' });
    owner = await t.signUp(`owner-${Date.now()}@example.com`);
    ws = await t.workspaceWith([[owner, 'owner']]);
    key = (await t.api(owner).call('sources.create', { name: 'Backend', kind: 'server' })).key;
  }, 60_000);
  afterAll(() => t?.close());

  it('can still be recreated by their own new activity', async () => {
    const api = t.api(owner);
    await send([{ type: 'identify', userId: 'gone', traits: { plan: 'pro' } }]);
    const erased = await eventually(
      () => api.call('profiles.find', { type: 'user_id', value: 'gone' }),
      (r) => !!r.profileId,
    );
    await api.call('profiles.erase', { profileId: erased.profileId!, reason: 'Erasure request, test' });

    await send([{ type: 'identify', userId: 'gone', traits: { plan: 'free' } }]);
    const again = await eventually(
      () => api.call('profiles.find', { type: 'user_id', value: 'gone' }),
      (r) => !!r.profileId,
    );
    expect(again.profileId).toBeTruthy();
    expect(again.profileId).not.toBe(erased.profileId);

    // Erasing the same identifier again updates its tombstone rather than adding a row.
    const before = await tombstones();
    const second = await api.call('profiles.erase', { profileId: again.profileId!, reason: 'Erasure request, test again' });
    const after = await tombstones();
    expect(after).toHaveLength(before.length);
    expect(after.filter((row) => row.erasure_id === second.erasureId).length).toBeGreaterThan(0);
  });
});
