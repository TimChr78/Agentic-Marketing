import { randomUUID } from 'node:crypto';
import type { BusEvent } from '@agentic-marketing/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOT_STATE_TOMBSTONE_TTL_S, SNAPSHOT_TTL_S, valkeyHotState } from '../src';

// #1196: an erasure leaves a tombstone in Valkey, and every hot-state writer checks it in the same
// atomic operation. A write that lands after the tombstone is refused; one that landed before it is
// removed by the erasure's own delete. The fence must outlive the longest hot-state TTL.

const VALKEY_URL = process.env.VALKEY_URL;
const prefix = `am-hotstate-tombstone-${process.pid}-${Date.now()}`;

let hot!: ReturnType<typeof valkeyHotState>;
const ws = '00000000-0000-4000-8000-000000000000';

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
  if (VALKEY_URL) hot = valkeyHotState({ url: VALKEY_URL, prefix });
});

afterAll(async () => {
  if (hot) await hot.close();
});

describe.skipIf(!VALKEY_URL)('the erasure tombstone fence', () => {
  it('refuses snapshot and session writes for a tombstoned subject, and only for it', async () => {
    const erased = randomUUID();
    const alive = randomUUID();
    await hot.tombstone(ws, { anonymousIds: [erased], userIds: [] });

    // A refresh that read before the erasure writes after it: the snapshot is skipped.
    expect(await hot.writeSnapshot(ws, { anonymousIds: [erased], userIds: [] }, snapshot('prf_a'))).toBe(false);
    expect(await hot.snapshot(ws, { anonymousId: erased })).toBeNull();
    // A late accepted event: the session is skipped.
    await hot.recordSessions([event(erased), event(erased, { type: 'track', name: 'Purchase' })]);
    expect((await hot.session(ws, erased)).isNew).toBe(true);

    // A different visitor in the same batch is written normally.
    expect(await hot.writeSnapshot(ws, { anonymousIds: [alive], userIds: [] }, snapshot('prf_b'))).toBe(true);
    expect((await hot.snapshot(ws, { anonymousId: alive }))?.profileId).toBe('prf_b');
    await hot.recordSessions([event(alive)]);
    expect(await hot.session(ws, alive)).toMatchObject({ pageViews: 1, lastPath: '/home', isNew: false });
  });

  it('hides state for a tombstoned user id as well', async () => {
    const userId = `user-${randomUUID()}`;
    await hot.writeSnapshot(ws, { anonymousIds: [], userIds: [userId] }, snapshot('prf_c'));
    expect((await hot.snapshot(ws, { userId }))?.profileId).toBe('prf_c');
    await hot.tombstone(ws, { anonymousIds: [], userIds: [userId] });
    expect(await hot.snapshot(ws, { userId })).toBeNull();
    expect(await hot.writeSnapshot(ws, { anonymousIds: [], userIds: [userId] }, snapshot('prf_d'))).toBe(false);
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
