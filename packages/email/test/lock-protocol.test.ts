import { DEFAULT_PURPOSES } from '@agentic-marketing/artifacts';
import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import type { AdapterDeps, DeliveryEvent } from '@agentic-marketing/email';
import { applySmsOptOut, emailRoutes, linkSigner } from '@agentic-marketing/email';
import type { BusEvent, EventStore } from '@agentic-marketing/events';
import {
  applyEvents,
  canonicalProfile,
  consentStateOf,
  disposeErasure,
  eraseProfileStage,
  mergedFamily,
  personCrypto,
  prepareErasure,
  profileIdsForBatch,
  recordTopicPreference,
  topicChoicesOf,
} from '@agentic-marketing/profiles';
import { localKeyProvider, prepareKeys, withPreparedKeys } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import {
  barrier,
  dropConsentPause,
  holdConsentPause,
  identityHolders,
  installConsentPause,
  releaseConsentPause,
  waitForAdvisoryHolderBlocked,
  waitForIdentityWaiter,
} from '../../profiles/test/lockSupport';
import { applyDeliveryEvents } from '../src/deliveryEvents';

// #978 part 3: the delivery callback, one-click unsubscribe and SMS STOP/START take the workspace
// identity lock before their first write, so a withdrawal or suppression cannot land on a profile a
// merge just folded away. Real PostgreSQL transactions, `pg_locks` for observation, barriers for
// ordering: nothing waits on a clock.

const MASTER_KEY = Buffer.alloc(32, 43).toString('base64');

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let kp: ReturnType<typeof localKeyProvider>;
let ws: string;
let clock = 0;

const at = () => new Date(Date.UTC(2026, 1, 1, 0, clock++)).toISOString();

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('email_lock_protocol');
  kp = localKeyProvider(MASTER_KEY);
  ws = d.workspace;
  await installConsentPause(d.db.admin);
}, 120_000);

afterAll(async () => {
  if (d) await dropConsentPause(d.db.admin);
  await d?.close();
});

const event = (over: Partial<BusEvent>): BusEvent => {
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
    context: {},
    consent: {},
    ...over,
  };
};

async function seedProfile(id: string, idents: { anonymous?: string; user?: string; phone?: string }, createdAt: Date) {
  await d.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.profiles).values({ workspaceId: ws, id, createdAt });
    const rows = [];
    if (idents.anonymous) rows.push({ workspaceId: ws, profileId: id, type: 'anonymous_id' as const, value: idents.anonymous });
    if (idents.user) rows.push({ workspaceId: ws, profileId: id, type: 'user_id' as const, value: idents.user });
    if (idents.phone)
      rows.push({
        workspaceId: ws,
        profileId: id,
        type: 'phone' as const,
        value: await personCrypto(tx, ws, kp).matchHash('phone', idents.phone),
      });
    if (rows.length) await tx.insert(schema.identifiers).values(rows);
  });
}

async function seedMessage(profileId: string, opts: { status?: string; recipientHash?: string; channel?: 'email' | 'sms' } = {}) {
  const id = newId('msg');
  await d.db.admin.query(
    `INSERT INTO messages (workspace_id, id, idempotency_key, channel, purpose, profile_id, status, provider_message_id, recipient_hash)
     VALUES ($1, $2, $3, $4, 'marketing_email', $5, $6, $7, $8)`,
    [ws, id, `idem_${id}`, opts.channel ?? 'email', profileId, opts.status ?? 'sent', `provider-${id}`, opts.recipientHash ?? null],
  );
  return id;
}

const familyOf = (profileId: string) => d.db.withWorkspace(ws, (tx) => mergedFamily(tx, ws, profileId));
const stateOf = (profileId: string) =>
  d.db.withWorkspace(ws, async (tx) => (await consentStateOf(tx, ws, profileId)).filter((r) => r.purpose === 'marketing_email'));
/** Any refused purpose in the person's state; a STOP writes the marketing SMS purpose. */
const refusedState = async (profileId: string) =>
  d.db.withWorkspace(ws, async (tx) =>
    (await consentStateOf(tx, ws, profileId)).filter((r) => ['withdrawn', 'objected', 'denied'].includes(r.status)),
  );
const consentRows = async (families?: string[]) => {
  const res = await d.db.admin.query<{ profile_id: string; status: string }>(
    'SELECT profile_id, status FROM consent_records WHERE workspace_id = $1 ORDER BY id',
    [ws],
  );
  if (!families) return res.rows;
  const allowed = new Set(families.flat());
  return res.rows.filter((r) => allowed.has(r.profile_id));
};

/** A real merge through the profile worker's prepare-and-run pair. */
async function merge(p: { anonymous: string }, q: { user: string }) {
  const batch = [event({ anonymousId: p.anonymous, userId: q.user })];
  await withPreparedKeys(
    async () => {
      const ids = await d.db.withWorkspace(ws, (tx) => profileIdsForBatch(tx, ws, batch, personCrypto(tx, ws, kp)));
      return prepareKeys(d.db, ws, kp, { profileIds: ids });
    },
    (prepared) => d.db.withWorkspace(ws, (tx) => applyEvents(tx, ws, batch, { prepared, purposes: async () => DEFAULT_PURPOSES })),
  );
}

const deliver = (events: DeliveryEvent[]) => d.db.withWorkspace(ws, (tx) => applyDeliveryEvents(tx, events, 'test'));

const canonicalProfileInTx = (profileId: string) => d.db.withWorkspace(ws, (tx) => canonicalProfile(tx, ws, profileId));

describe.skipIf(!hasTestDatabase())('delivery, unsubscribe and SMS under the identity lock (#978 part 3)', () => {
  it('a callback batch updates a message and withdraws while a merge waits, then the merge includes it', async () => {
    const q = newId('prf');
    const p = newId('prf');
    await seedProfile(q, { user: `user-${q}` }, new Date(Date.UTC(2026, 1, 1)));
    await seedProfile(p, { anonymous: `anon-${p}` }, new Date(Date.UTC(2026, 1, 2)));
    const messageId = await seedMessage(p);
    const providerMessageId = `provider-${messageId}`;

    const probe = await d.db.admin.connect();
    let callback: Promise<unknown> | undefined;
    let mergeBatch: Promise<unknown> | undefined;
    try {
      // Hold the message row: the batch has taken the identity lock and stops at its first UPDATE,
      // with the withdrawal still ahead of it.
      await probe.query('BEGIN');
      await probe.query('SELECT 1 FROM messages WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [ws, messageId]);
      callback = deliver([
        { eventId: `${providerMessageId}:delivered`, type: 'delivered', providerMessageId, at: at() },
        { eventId: `${providerMessageId}:unsub`, type: 'unsubscribed', providerMessageId, at: at() },
      ]);
      await waitForAdvisoryHolderBlocked(probe, ws);
      mergeBatch = merge({ anonymous: `anon-${p}` }, { user: `user-${q}` });
      await waitForIdentityWaiter(probe, ws);
      await probe.query('COMMIT');
      await callback;
    } finally {
      await probe.query('ROLLBACK').catch(() => {});
      probe.release();
    }
    await mergeBatch;

    const msg = await d.db.admin.query<{ status: string; profile_id: string }>(
      'SELECT status, profile_id FROM messages WHERE workspace_id = $1 AND id = $2',
      [ws, messageId],
    );
    expect(msg.rows[0]).toEqual({ status: 'delivered', profile_id: q });
    const family = await familyOf(q);
    expect(family).toEqual(expect.arrayContaining([p, q]));
    expect((await consentRows(family)).map((r) => r.status)).toEqual(['withdrawn']);
    expect(await stateOf(q)).toMatchObject([{ status: 'withdrawn' }]);
  }, 60_000);

  it('a one-click unsubscribe racing a merge keeps the refusal for the survivor', async () => {
    const q = newId('prf');
    const p = newId('prf');
    await seedProfile(q, { user: `user-${q}` }, new Date(Date.UTC(2026, 1, 1)));
    await seedProfile(p, { anonymous: `anon-${p}` }, new Date(Date.UTC(2026, 1, 2)));
    const messageId = await seedMessage(p);

    const links = linkSigner('lock-protocol-secret');
    const app = emailRoutes({
      db: d.db,
      kp,
      events: {} as EventStore,
      email: {
        publicUrl: 'https://links.example.com',
        links,
        adapterDeps: {} as AdapterDeps,
        trackClicks: false,
      },
    });
    const token = links.sign({ w: ws, p, u: 'marketing_email', m: messageId });

    // Pause the unsubscribe after it resolved P, before its evidence row lands; a merge that starts
    // now must wait for it (the identity lock), not fold P away first.
    const probe = await d.db.admin.connect();
    let unsubscribe: Promise<Response> | undefined;
    let mergeBatch: Promise<unknown> | undefined;
    try {
      await holdConsentPause(probe);
      unsubscribe = Promise.resolve(app.request(`/u/${token}`, { method: 'POST' }));
      await waitForAdvisoryHolderBlocked(probe, ws);
      mergeBatch = merge({ anonymous: `anon-${p}` }, { user: `user-${q}` });
      await waitForIdentityWaiter(probe, ws);
    } finally {
      await releaseConsentPause(probe);
    }
    const response = await unsubscribe!;
    expect(response.status).toBe(200);
    await mergeBatch;
    probe.release();

    // A stale link was used before the merge; the evidence is on P and the survivor's state is the
    // refusal, not a lost one.
    const family = await familyOf(q);
    expect(family).toEqual(expect.arrayContaining([p, q]));
    expect((await consentRows(family)).map((r) => r.status)).toEqual(['withdrawn']);
    expect(await stateOf(q)).toMatchObject([{ status: 'withdrawn' }]);
  }, 60_000);

  it('a one-click unsubscribe used after a merge records on the survivor', async () => {
    const q = newId('prf');
    const p = newId('prf');
    await seedProfile(q, { user: `user-${q}` }, new Date(Date.UTC(2026, 1, 1)));
    await seedProfile(p, { anonymous: `anon-${p}` }, new Date(Date.UTC(2026, 1, 2)));
    const messageId = await seedMessage(p);
    await merge({ anonymous: `anon-${p}` }, { user: `user-${q}` });

    const links = linkSigner('lock-protocol-secret');
    const app = emailRoutes({
      db: d.db,
      kp,
      events: {} as EventStore,
      email: { publicUrl: 'https://links.example.com', links, adapterDeps: {} as AdapterDeps, trackClicks: false },
    });
    const token = links.sign({ w: ws, p, u: 'marketing_email', m: messageId });
    expect((await app.request(`/u/${token}`, { method: 'POST' })).status).toBe(200);

    expect(await canonicalProfileInTx(q)).toEqual({ id: q });
    expect((await consentRows([q, p])).map((r) => r.profile_id)).toEqual([q]);
    expect(await stateOf(q)).toMatchObject([{ status: 'withdrawn' }]);
  }, 60_000);

  it('a STOP records on the survivor whether it races a merge before or after', async () => {
    const phone = '+15550001111';
    const q = newId('prf');
    const p = newId('prf');
    await seedProfile(q, { user: `user-${q}` }, new Date(Date.UTC(2026, 1, 1)));
    await seedProfile(p, { anonymous: `anon-${p}`, phone }, new Date(Date.UTC(2026, 1, 2)));
    const preparedKeys = await prepareKeys(d.db, ws, kp, { purposes: ['matching'] });
    // STOP racing a merge: pause the STOP after it resolved the phone's profile, before its
    // evidence lands; the merge must wait while the writer holds the identity lock.
    const probe = await d.db.admin.connect();
    let stop: Promise<unknown> | undefined;
    let mergeBatch: Promise<unknown> | undefined;
    try {
      await holdConsentPause(probe);
      stop = d.db.withWorkspace(ws, (tx) =>
        applySmsOptOut(tx, {
          workspaceId: ws,
          providerId: 'twilio_test',
          keyword: 'STOP',
          intent: 'stop',
          phone,
          receivedAt: new Date(at()),
          prepared: preparedKeys,
        }),
      );
      await waitForAdvisoryHolderBlocked(probe, ws);
      mergeBatch = merge({ anonymous: `anon-${p}` }, { user: `user-${q}` });
      await waitForIdentityWaiter(probe, ws);
    } finally {
      await releaseConsentPause(probe);
    }
    await stop;
    await mergeBatch;
    probe.release();
    try {
      expect((await consentRows([q, p])).map((r) => r.status)).toEqual(['withdrawn']);
      expect((await refusedState(q)).length).toBeGreaterThan(0);
      const stopped = await d.db.admin.query<{ reason: string }>(
        'SELECT reason FROM suppressions WHERE workspace_id = $1 AND channel = $2',
        [ws, 'sms'],
      );
      expect(stopped.rows).toEqual([{ reason: 'stop' }]);

      // A second number: the merge commits first, then its STOP resolves straight to Q.
      const phone2 = '+15550002222';
      const q2 = newId('prf');
      const p2 = newId('prf');
      await seedProfile(q2, { user: `user-${q2}` }, new Date(Date.UTC(2026, 1, 1)));
      await seedProfile(p2, { anonymous: `anon-${p2}`, phone: phone2 }, new Date(Date.UTC(2026, 1, 2)));
      await merge({ anonymous: `anon-${p2}` }, { user: `user-${q2}` });
      await d.db.withWorkspace(ws, (tx) =>
        applySmsOptOut(tx, {
          workspaceId: ws,
          providerId: 'twilio_test',
          keyword: 'STOP',
          intent: 'stop',
          phone: phone2,
          receivedAt: new Date(at()),
          prepared: preparedKeys,
        }),
      );
      const second = (await consentRows([q2, p2])).filter((r) => r.status === 'withdrawn');
      expect(second.map((r) => r.profile_id)).toEqual([q2]);
      expect((await refusedState(q2)).length).toBeGreaterThan(0);
    } finally {
      preparedKeys.provider.dispose();
    }
  }, 60_000);

  it('a START racing a hard bounce never lifts the delivery fact', async () => {
    const phone = '+15550003333';
    const hash = await d.db.withWorkspace(ws, (tx) => personCrypto(tx, ws, kp).matchHash('phone', phone));
    const profileId = newId('prf');
    await seedProfile(profileId, { anonymous: `anon-${profileId}`, phone }, new Date(Date.UTC(2026, 1, 1)));
    const messageId = await seedMessage(profileId, { recipientHash: hash, channel: 'sms' });
    const preparedKeys = await prepareKeys(d.db, ws, kp, { purposes: ['matching'] });
    await d.db.admin.query(
      `INSERT INTO suppressions (workspace_id, channel, value_hash, reason, at) VALUES ($1, 'sms', $2, 'stop', now())`,
      [ws, hash],
    );
    try {
      // The bounce and the START race: the identity lock serialises them, and either order leaves
      // the stronger delivery fact in place (START deletes only a stop row).
      const start = barrier(2);
      const startFirst = d.db.withWorkspace(ws, async (tx) => {
        await start();
        return applySmsOptOut(tx, {
          workspaceId: ws,
          providerId: 'twilio_test',
          keyword: 'START',
          intent: 'start',
          phone,
          receivedAt: new Date(at()),
          prepared: preparedKeys,
        });
      });
      const bounce = (async () => {
        await start();
        return deliver([
          {
            eventId: `provider-${messageId}:bounce`,
            type: 'bounced',
            bounce: 'hard',
            providerMessageId: `provider-${messageId}`,
            at: at(),
          },
        ]);
      })();
      await Promise.all([startFirst, bounce]);

      const reason = await d.db.admin.query<{ reason: string }>(
        'SELECT reason FROM suppressions WHERE workspace_id = $1 AND value_hash = $2',
        [ws, hash],
      );
      expect(reason.rows).toEqual([{ reason: 'hard_bounce' }]);
      // START never grants consent, and the bounce never records one either.
      expect(await stateOf(profileId)).toEqual([]);
    } finally {
      preparedKeys.provider.dispose();
    }
  }, 60_000);

  it('a stale topic link cannot write a choice to a merged-away or erased person', async () => {
    const q = newId('prf');
    const p = newId('prf');
    await seedProfile(q, { user: `user-${q}` }, new Date(Date.UTC(2026, 1, 1)));
    await seedProfile(p, { anonymous: `anon-${p}` }, new Date(Date.UTC(2026, 1, 2)));
    await merge({ anonymous: `anon-${p}` }, { user: `user-${q}` });

    const recorded = await d.db.withWorkspace(ws, (tx) =>
      recordTopicPreference(tx, ws, p, 'marketing_email', 'news', 'unsubscribed', 'unsubscribe_link'),
    );
    expect(recorded).toBe(true);
    const choices = await d.db.withWorkspace(ws, (tx) => topicChoicesOf(tx, ws, q));
    expect(choices.map((c) => ({ topic: c.topic, status: c.status }))).toEqual([{ topic: 'news', status: 'unsubscribed' }]);
    expect(await d.db.withWorkspace(ws, (tx) => topicChoicesOf(tx, ws, p))).toEqual([]);

    // And a link that outlives an erasure records nothing: no choice and no row for the person.
    const prepared = await prepareErasure(d.db, ws, kp);
    try {
      await d.db.withWorkspace(ws, (tx) =>
        eraseProfileStage(tx, {
          workspaceId: ws,
          profileId: q,
          requestedBy: 'user_test',
          reason: 'stale topic link',
          prepared,
        }),
      );
    } finally {
      disposeErasure(prepared);
    }
    const afterErase = await d.db.withWorkspace(ws, (tx) =>
      recordTopicPreference(tx, ws, p, 'marketing_email', 'news', 'subscribed', 'unsubscribe_link'),
    );
    expect(afterErase).toBe(false);
    const topicRows = await d.db.admin.query('SELECT 1 FROM topic_preferences WHERE workspace_id = $1 AND topic = $2', [ws, 'news']);
    expect(topicRows.rowCount).toBe(0);
  }, 60_000);

  it('holds the identity lock before the first message row of a delivery batch', async () => {
    const profileId = newId('prf');
    await seedProfile(profileId, { anonymous: `anon-${profileId}` }, new Date(Date.UTC(2026, 1, 1)));
    const messageId = await seedMessage(profileId);
    const providerMessageId = `provider-${messageId}`;

    const probe = await d.db.admin.connect();
    let callback: Promise<unknown> | undefined;
    try {
      await probe.query('BEGIN');
      await probe.query('SELECT 1 FROM messages WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [ws, messageId]);
      callback = deliver([{ eventId: `${providerMessageId}:delivered`, type: 'delivered', providerMessageId, at: at() }]);
      // The batch is blocked on the message row and already holds the advisory lock. Without the
      // lock-first ordering it would be waiting with no lock held (and `waitFor` would time out).
      await waitForAdvisoryHolderBlocked(probe, ws);
      const holders = await identityHolders(probe, ws);
      expect(holders.length).toBeGreaterThan(0);
    } finally {
      await probe.query('COMMIT');
      probe.release();
    }
    await callback;
  }, 60_000);
});
