import { DEFAULT_PURPOSES } from '@agentic-marketing/artifacts';
import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import type { BusEvent } from '@agentic-marketing/events';
import {
  applyEvents,
  disposeErasure,
  eraseProfileStage,
  personCrypto,
  prepareErasure,
  profileIdsForBatch,
  type ResolvedEvent,
} from '@agentic-marketing/profiles';
import { localKeyProvider, prepareKeys, withPreparedKeys } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { holdIdentityLock, type Queryable, waitForIdentityWaiter } from '../../profiles/test/lockSupport';
import { clickIdHook } from '../src/hook';

// #978 part 3 review: the click-id hook is an identity writer. It must take the workspace identity
// lock before reading or writing, follow the event's resolved profile to today's canonical one
// (a merge may have committed since the worker resolved it), and skip an erased person.

const MASTER_KEY = Buffer.alloc(32, 53).toString('base64');

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let kp: ReturnType<typeof localKeyProvider>;
let ws: string;
let clock = 0;

const at = () => new Date(Date.UTC(2026, 3, 1, 0, clock++)).toISOString();

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('ads_lock_protocol');
  kp = localKeyProvider(MASTER_KEY);
  ws = d.workspace;
}, 120_000);

afterAll(async () => {
  await d?.close();
});

const event = (over: Partial<BusEvent> = {}): BusEvent => {
  const timestamp = at();
  return {
    workspaceId: ws,
    sourceId: 'src_lock_test',
    messageId: newId('evt'),
    type: 'track',
    name: 'Page Viewed',
    anonymousId: '',
    userId: '',
    timestamp,
    receivedAt: timestamp,
    properties: {},
    traits: {},
    piiTraits: {},
    context: { consent: { categoryPreferences: { ad_measurement: true } } },
    consent: {},
    ...over,
  };
};

const resolvedFor = (profileId: string, gclid: string, over: Partial<BusEvent> = {}): ResolvedEvent[] => [
  { event: event({ context: { clickIds: { gclid }, consent: { categoryPreferences: { ad_measurement: true } } }, ...over }), profileId },
];

async function seedProfile(id: string, idents: { anonymous?: string; user?: string }, createdAt: Date) {
  await d.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.profiles).values({ workspaceId: ws, id, createdAt });
    const rows = [];
    if (idents.anonymous) rows.push({ workspaceId: ws, profileId: id, type: 'anonymous_id' as const, value: idents.anonymous });
    if (idents.user) rows.push({ workspaceId: ws, profileId: id, type: 'user_id' as const, value: idents.user });
    if (rows.length) await tx.insert(schema.identifiers).values(rows);
  });
}

async function merge(anonymous: string, user: string) {
  const batch = [event({ anonymousId: anonymous, userId: user })];
  await withPreparedKeys(
    async () => {
      const ids = await d.db.withWorkspace(ws, (tx) => profileIdsForBatch(tx, ws, batch, personCrypto(tx, ws, kp)));
      return prepareKeys(d.db, ws, kp, { profileIds: ids });
    },
    (prepared) => d.db.withWorkspace(ws, (tx) => applyEvents(tx, ws, batch, { prepared, purposes: async () => DEFAULT_PURPOSES })),
  );
}

const clickIdOwner = async (gclid: string, conn: Queryable = d.db.admin) => {
  const res = await conn.query<{ profile_id: string }>(
    "SELECT profile_id FROM identifiers WHERE workspace_id = $1 AND type = 'gclid' AND value = $2",
    [ws, gclid],
  );
  return res.rows[0]?.profile_id ?? null;
};

describe.skipIf(!hasTestDatabase())('click-id hook under the identity lock (#978 part 3 review)', () => {
  it('waits for the identity lock before writing a click id', async () => {
    const profileId = newId('prf');
    const gclid = newId('clk');
    await seedProfile(profileId, { anonymous: `anon-${profileId}` }, new Date(Date.UTC(2026, 3, 1)));
    const held = await holdIdentityLock(d.db.admin, ws);
    let released = false;
    try {
      const hook = clickIdHook({ db: d.db });
      const running = hook(ws, resolvedFor(profileId, gclid));
      // The hook is queued on the identity lock the probe holds; nothing is written yet. One
      // connection both holds the lock and observes, so the two-connection pool is enough.
      await waitForIdentityWaiter(held.client, ws);
      expect(await clickIdOwner(gclid, held.client)).toBeNull();
      await held.release();
      released = true;
      await running;
    } finally {
      if (!released) await held.rollback();
    }
    expect(await clickIdOwner(gclid)).toBe(profileId);
  }, 60_000);

  it('writes the click id to the survivor of a merge that committed after resolution', async () => {
    const q = newId('prf');
    const p = newId('prf');
    await seedProfile(q, { user: `user-${q}` }, new Date(Date.UTC(2026, 3, 1)));
    await seedProfile(p, { anonymous: `anon-${p}` }, new Date(Date.UTC(2026, 3, 2)));
    const gclid = newId('clk');
    const resolved = resolvedFor(p, gclid);
    await merge(`anon-${p}`, `user-${q}`);
    await clickIdHook({ db: d.db })(ws, resolved);
    expect(await clickIdOwner(gclid)).toBe(q);
  }, 60_000);

  it('reads consent on the survivor, not the stale profile', async () => {
    const q = newId('prf');
    const p = newId('prf');
    await seedProfile(q, { user: `user-${q}` }, new Date(Date.UTC(2026, 3, 1)));
    await seedProfile(p, { anonymous: `anon-${p}` }, new Date(Date.UTC(2026, 3, 2)));
    const gclid = newId('clk');
    const resolved = resolvedFor(p, gclid);
    await merge(`anon-${p}`, `user-${q}`);
    // The survivor refuses ad_measurement in the ledger; the event's own signal cannot override it.
    await d.db.admin.query(
      `INSERT INTO consent_state (workspace_id, profile_id, purpose, channel, status, basis, source, updated_at)
       VALUES ($1, $2, 'ad_measurement', '', 'withdrawn', 'consent', 'unsubscribe', now())`,
      [ws, q],
    );
    await clickIdHook({ db: d.db })(ws, resolved);
    expect(await clickIdOwner(gclid, d.db.admin)).toBeNull();
  }, 60_000);

  it('skips a person erased between resolution and the hook', async () => {
    const p = newId('prf');
    await seedProfile(p, { anonymous: `anon-${p}` }, new Date(Date.UTC(2026, 3, 2)));
    const gclid = newId('clk');
    const resolved = resolvedFor(p, gclid);
    const prepared = await prepareErasure(d.db, ws, kp);
    try {
      await d.db.withWorkspace(ws, (tx) =>
        eraseProfileStage(tx, {
          workspaceId: ws,
          profileId: p,
          requestedBy: 'user_test',
          reason: 'click id after erasure',
          prepared,
        }),
      );
    } finally {
      disposeErasure(prepared);
    }
    await expect(clickIdHook({ db: d.db })(ws, resolved)).resolves.toBeUndefined();
    expect(await clickIdOwner(gclid)).toBeNull();
  }, 60_000);
});
