import { randomUUID } from 'node:crypto';
import type { BusEvent } from '@agentic-marketing/events';
import Valkey from 'iovalkey';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOT_STATE_TOMBSTONE_TTL_S, SNAPSHOT_TTL_S, valkeyHotState } from '../src';

// #1196: an erasure leaves a tombstone in Valkey, and every hot-state writer checks it in the same
// atomic operation. A write that lands after the tombstone is refused; one that landed before it is
// removed by the erasure's own delete. The fence must outlive the longest hot-state TTL.

const VALKEY_URL = process.env.VALKEY_URL;
const prefix = `am-hotstate-tombstone-${process.pid}-${Date.now()}`;

let hot!: ReturnType<typeof valkeyHotState>;
let raw!: Valkey;
const ws = '00000000-0000-4000-8000-000000000000';
const sessionKey = (anonymousId: string) => `${prefix}:${ws}:s:${anonymousId}`;

const event = (anonymousId: string, overrides: Partial<BusEvent> = {}): BusEvent =>
  ({
    workspaceId: ws,
    sourceId: 'src',
    messageId: randomUUID(),
    type: 'page',
    name: 'Home',
    anonymousId,
    userId: '',
    timestamp: '2026-11-22T10:00:00.000Z',
    receivedAt: '2026-11-22T10:00:00.000Z',
    properties: {},
    traits: {},
    piiTraits: {},
    context: { page: { path: '/home' } },
    consent: {},
    ...overrides,
  }) as BusEvent;

const snapshot = (profileId: string) => ({ profileId, traits: { tier: 'gold' }, segments: ['seg'], at: '2026-11-22T10:00:00.000Z' });

beforeAll(() => {
  if (VALKEY_URL) {
    hot = valkeyHotState({ url: VALKEY_URL, prefix });
    raw = new Valkey(VALKEY_URL);
  }
});

afterAll(async () => {
  if (hot) await hot.close();
  if (raw) raw.disconnect();
});

describe.skipIf(!VALKEY_URL)('the erasure tombstone fence', () => {
  it('refuses snapshot and session writes for a tombstoned subject, and only for it', async () => {
    const erased = randomUUID();
    const alive = randomUUID();
    await hot.tombstone(ws, { anonymousIds: [erased], userIds: [] });

    // A refresh that read before the erasure writes after it: the snapshot is skipped.
    expect(await hot.writeSnapshot(ws, { anonymousIds: [erased], userIds: [] }, snapshot('prf_a'))).toEqual({
      anonymousIds: [],
      userIds: [],
    });
    expect(await hot.snapshot(ws, { anonymousId: erased })).toBeNull();

    // A late accepted event: the raw session key is never created. A live visitor in the same
    // batch is written normally, so the refusal is per subject rather than a dead script.
    await hot.recordSessions([event(erased), event(erased, { type: 'track', name: 'Purchase' }), event(alive)]);
    expect(await raw.exists(sessionKey(erased))).toBe(0);
    expect((await hot.session(ws, erased)).isNew).toBe(true);
    expect(await raw.exists(sessionKey(alive))).toBe(1);
    expect(await raw.ttl(sessionKey(alive))).toBeGreaterThan(0);
    expect(await hot.session(ws, alive)).toMatchObject({ pageViews: 1, lastPath: '/home', isNew: false });

    // A partly accepted multi-id write reports exactly the ids it wrote, so a caller (the edge
    // mirror) queues only those (#1196 review).
    const partial = await hot.writeSnapshot(ws, { anonymousIds: [erased, alive], userIds: [] }, snapshot('prf_b'));
    expect(partial).toEqual({ anonymousIds: [alive], userIds: [] });
    expect((await hot.snapshot(ws, { anonymousId: alive }))?.profileId).toBe('prf_b');
  });

  it('hides state for a tombstoned user id as well', async () => {
    const userId = `user-${randomUUID()}`;
    await hot.writeSnapshot(ws, { anonymousIds: [], userIds: [userId] }, snapshot('prf_c'));
    expect((await hot.snapshot(ws, { userId }))?.profileId).toBe('prf_c');
    await hot.tombstone(ws, { anonymousIds: [], userIds: [userId] });
    expect(await hot.snapshot(ws, { userId })).toBeNull();
    expect(await hot.writeSnapshot(ws, { anonymousIds: [], userIds: [userId] }, snapshot('prf_d'))).toEqual({
      anonymousIds: [],
      userIds: [],
    });
  });

  it('refuses a session when the user id, not the anonymous id, is tombstoned', async () => {
    const anonymousId = randomUUID();
    const userId = `user-${randomUUID()}`;
    await hot.tombstone(ws, { anonymousIds: [], userIds: [userId] });

    // An event with a new anonymous id and an erased user id must not rebuild a session.
    await hot.recordSessions([event(anonymousId, { userId })]);
    expect(await raw.exists(sessionKey(anonymousId))).toBe(0);
    expect((await hot.session(ws, anonymousId, userId)).isNew).toBe(true);
  });

  it('applies the read fence by user id to an existing session', async () => {
    const anonymousId = randomUUID();
    const userId = `user-${randomUUID()}`;
    await hot.recordSessions([event(anonymousId, { userId })]);
    expect((await hot.session(ws, anonymousId, userId)).isNew).toBe(false);

    await hot.tombstone(ws, { anonymousIds: [], userIds: [userId] });
    // /v1/decide passes the user id when it has one, so the old session must not personalise.
    expect((await hot.session(ws, anonymousId, userId)).isNew).toBe(true);
    // The anonymous-keyed copy remains, which is why the user id has to reach the read.
    expect((await hot.session(ws, anonymousId)).isNew).toBe(false);
  });

  it('refuses a session when the profile id on the event is tombstoned', async () => {
    const anonymousId = randomUUID();
    const profileId = `prf_${randomUUID().replace(/-/g, '')}`;
    await hot.tombstone(ws, { anonymousIds: [], userIds: [], profileIds: [profileId] });

    await hot.recordSessions([event(anonymousId, { profileId })]);
    expect(await raw.exists(sessionKey(anonymousId))).toBe(0);
    expect((await hot.session(ws, anonymousId)).isNew).toBe(true);
  });

  it('writes every visitor in a batch when one event has a non-string page path', async () => {
    const odd = randomUUID();
    const live = randomUUID();

    // A boolean `context.page.path` used to abort the Lua script after the counters were written
    // and before EXPIRE: the key stayed with TTL -1 and the next visitor in the batch got nothing.
    await expect(hot.recordSessions([event(odd, { context: { page: { path: true } } }), event(live)])).resolves.toBeUndefined();

    expect(await raw.exists(sessionKey(odd))).toBe(1);
    expect(await raw.ttl(sessionKey(odd))).toBeGreaterThan(0);
    expect((await hot.session(ws, odd)).lastPath).toBeNull();

    expect(await raw.exists(sessionKey(live))).toBe(1);
    expect(await raw.ttl(sessionKey(live))).toBeGreaterThan(0);
    expect((await hot.session(ws, live)).lastPath).toBe('/home');
  });

  it('rejects when a tombstone write fails instead of leaving the erasure unfenced', async () => {
    const id = randomUUID();
    // Redis answers the individual SET in EXEC with an error; discarding the replies used to let
    // the cleanup delete and checkpoint without a fence. The error must reach the cleanup so it
    // retries.
    await expect(hot.tombstone(ws, { anonymousIds: [id], userIds: [] }, -1)).rejects.toThrow();
    expect(await hot.tombstoneTtl(ws, id)).toBe(-2);
  });

  it('keeps the tombstone at least as long as the longest hot-state TTL', async () => {
    expect(HOT_STATE_TOMBSTONE_TTL_S).toBeGreaterThanOrEqual(SNAPSHOT_TTL_S);
    const id = randomUUID();
    await hot.tombstone(ws, { anonymousIds: [id], userIds: [] });
    const ttl = await hot.tombstoneTtl(ws, id);
    expect(ttl).toBeGreaterThan(SNAPSHOT_TTL_S - 60);
    expect(ttl).toBeLessThanOrEqual(HOT_STATE_TOMBSTONE_TTL_S);
  });
});
