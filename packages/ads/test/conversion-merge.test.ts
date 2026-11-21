import { newId } from '@agentic-marketing/core';
import { type Db, migrate, schema } from '@agentic-marketing/db';
import type { BusEvent } from '@agentic-marketing/events';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { countsFor } from '../src/audiences';
import { conversionHook } from '../src/conversions';

// #1155: conversionHook built its idempotency key without the destination action, so two rules on
// one event and one connection collided and all but the first were dropped. It also checked
// consent and recorded the profile id on the raw resolved id, which a merge can have folded away.
// countsFor added orphaned intents to a pending count that already included them.

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let ws: string;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('ads_conversion_merge');
  ws = d.workspace;
}, 120_000);

afterAll(async () => {
  await d?.close();
});

const event = (over: Partial<BusEvent> = {}): BusEvent => {
  const timestamp = new Date('2026-05-01T00:00:00.000Z').toISOString();
  return {
    workspaceId: ws,
    sourceId: 'src_ads_test',
    messageId: newId('evt'),
    type: 'track',
    name: 'Order Completed',
    anonymousId: '',
    userId: '',
    timestamp,
    receivedAt: timestamp,
    properties: { total: 99 },
    traits: {},
    piiTraits: {},
    context: {},
    consent: {},
    ...over,
  };
};

async function publishMap(rules: unknown[], opts: { target?: { db: Db; ws: string }; replaces?: boolean } = {}) {
  const target = opts.target ?? { db: d.db, ws };
  const id = newId('cvm');
  await target.db.withWorkspace(target.ws, async (tx) => {
    // conversion_map is a singleton: replace the previous test's published map and deliveries.
    if (opts.replaces !== false) {
      await tx.delete(schema.deliveries).where(eq(schema.deliveries.workspaceId, target.ws));
      await tx
        .delete(schema.artifacts)
        .where(and(eq(schema.artifacts.workspaceId, target.ws), eq(schema.artifacts.type, 'conversion_map')));
    }
    await tx.insert(schema.artifacts).values({
      workspaceId: target.ws,
      id,
      type: 'conversion_map',
      name: 'Conversions',
      latestVersion: 1,
      publishedVersion: 1,
    });
    await tx.insert(schema.artifactVersions).values({
      workspaceId: target.ws,
      artifactId: id,
      number: 1,
      state: 'published',
      content: { rules },
      contentHash: `hash_${id}`,
      authorType: 'user',
      authorId: 'user_test',
    });
  });
  return id;
}

async function seedProfile(id: string, mergedInto: string | null = null, target: { db: Db; ws: string } = { db: d.db, ws }) {
  await target.db.withWorkspace(target.ws, async (tx) => {
    await tx.insert(schema.profiles).values({ workspaceId: target.ws, id, mergedInto });
    if (mergedInto)
      await tx.insert(schema.profileMerges).values({ workspaceId: target.ws, fromId: id, intoId: mergedInto, reason: 'test merge' });
  });
}

const deliveries = async (target: { db: Db; ws: string } = { db: d.db, ws }) =>
  (
    await target.db.admin.query<{ idempotency_key: string; profile_id: string | null }>(
      'SELECT idempotency_key, profile_id FROM deliveries WHERE workspace_id = $1 ORDER BY idempotency_key',
      [target.ws],
    )
  ).rows;

describe.skipIf(!hasTestDatabase())('ads conversionHook (#1155)', () => {
  it('queues every rule on the same event and connection instead of dropping all but the first', async () => {
    const connection = newId('con');
    await publishMap([
      { event: 'Order Completed', meta: { connection, eventName: 'Purchase' } },
      { event: 'Order Completed', meta: { connection, eventName: 'Lead' } },
    ]);
    const profileId = newId('prf');
    await seedProfile(profileId);

    await conversionHook({ db: d.db })(ws, [
      { event: event({ context: { consent: { categoryPreferences: { ad_measurement: true } } } }), profileId },
    ]);

    const rows = await deliveries();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.idempotency_key)).size).toBe(2);
    expect(rows.every((r) => r.profile_id === profileId)).toBe(true);
  }, 60_000);

  it('checks consent and records the canonical survivor for a merged-away id', async () => {
    const connection = newId('con');
    await publishMap([{ event: 'Order Completed', meta: { connection, eventName: 'Purchase' } }]);
    const survivor = newId('prf');
    const alias = newId('prf');
    await seedProfile(survivor);
    await seedProfile(alias, survivor);
    // Only the survivor holds the ledger grant; the merged-away alias no longer has a row.
    await d.db.withWorkspace(ws, (tx) =>
      tx.insert(schema.consentState).values({
        workspaceId: ws,
        profileId: survivor,
        purpose: 'ad_measurement',
        status: 'granted',
        basis: 'consent',
        source: 'sdk',
        updatedAt: new Date('2026-05-01T00:00:00.000Z'),
      }),
    );

    await conversionHook({ db: d.db })(ws, [{ event: event({ context: {} }), profileId: alias }]);

    const rows = await deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.profile_id).toBe(survivor);
  }, 60_000);
});

describe.skipIf(!hasTestDatabase())('audience countsFor (#1155)', () => {
  it('counts an orphaned write intent once, not twice', async () => {
    const syncId = newId('aud');
    const destinationKey = 'destination-1';
    await d.db.withWorkspace(ws, async (tx) => {
      await tx.insert(schema.audienceMembers).values([
        {
          workspaceId: ws,
          syncId,
          platform: 'meta',
          destinationKey,
          connectionId: newId('con'),
          destinationId: '123',
          operatingAccountId: '',
          destinationKnown: true,
          profileId: newId('prf'),
          hashes: { email: 'e1' },
        },
        {
          workspaceId: ws,
          syncId,
          platform: 'meta',
          destinationKey,
          connectionId: newId('con'),
          destinationId: '123',
          operatingAccountId: '',
          destinationKnown: true,
          orphanedAt: new Date('2026-05-01T00:00:00.000Z'),
          profileId: newId('prf'),
          hashes: { email: 'e2' },
        },
      ]);
      await tx.insert(schema.audienceWriteIntents).values([
        {
          workspaceId: ws,
          syncId,
          platform: 'meta',
          destinationKey,
          connectionId: newId('con'),
          destinationId: '123',
          operatingAccountId: '',
          profileId: newId('prf'),
          op: 'add',
          hashes: { email: 'e3' },
          orphanedAt: new Date('2026-05-01T00:00:00.000Z'),
        },
        {
          workspaceId: ws,
          syncId,
          platform: 'meta',
          destinationKey,
          connectionId: newId('con'),
          destinationId: '123',
          operatingAccountId: '',
          profileId: newId('prf'),
          op: 'add',
          hashes: { email: 'e4' },
        },
      ]);
    });

    const counts = await countsFor(d.db, ws, syncId, 'meta', null);

    // One orphaned member plus two pending intents; the orphaned intent is part of pending.
    expect(counts).toEqual({ members: 2, unresolved: 3, pending: 2 });
  }, 60_000);
});

describe.skipIf(!hasTestDatabase())('conversion keys queued before 0.17.6 (#1155)', () => {
  it('rewrites an old-format key and keeps a redelivery after the migration to one delivery', async () => {
    // The key gained the destination action, so a batch processed before the upgrade and
    // redelivered after it would queue the conversion a second time unless the stored key moves.
    const before = await createDisposableDb('ads_conversion_keys', { upTo: '0117_stranded_segment_memberships.sql' });
    const target = { db: before.db, ws: before.workspace };
    try {
      const connection = newId('con');
      const profileId = newId('prf');
      // The event that was queued before the upgrade and is redelivered after it.
      const kept = newId('evt');
      // A conversion already redelivered: the new worker queued the new-format row next to the old.
      const replays = newId('evt');

      await before.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [target.ws, profileId]);
      const seed = (key: string, eventId: string) =>
        before.db.admin.query(
          `INSERT INTO deliveries (workspace_id, id, kind, target_id, action, payload, status, idempotency_key, profile_id)
           VALUES ($1, $2, 'ad_conversion', $3, 'meta', $4::jsonb, 'pending', $5, $6)`,
          [
            target.ws,
            newId('dlv'),
            connection,
            JSON.stringify({ eventId, profileId, destination: { connection, eventName: 'Purchase' } }),
            key,
            profileId,
          ],
        );
      await seed(`adc:meta:${connection}:${kept}`, kept);
      await seed(`adc:meta:${connection}:${replays}`, replays);
      await seed(`adc:meta:${connection}:Purchase:${replays}`, replays);

      await migrate(before.db.admin, APP_ROLE);

      expect(await deliveries(target)).toEqual([
        { idempotency_key: `adc:meta:${connection}:Purchase:${kept}`, profile_id: profileId },
        { idempotency_key: `adc:meta:${connection}:Purchase:${replays}`, profile_id: profileId },
      ]);

      await publishMap([{ event: 'Order Completed', meta: { connection, eventName: 'Purchase' } }], {
        target,
        replaces: false,
      });
      await before.db.withWorkspace(target.ws, (tx) =>
        tx.insert(schema.consentState).values({
          workspaceId: target.ws,
          profileId,
          purpose: 'ad_measurement',
          status: 'granted',
          basis: 'consent',
          source: 'sdk',
          updatedAt: new Date('2026-05-01T00:00:00.000Z'),
        }),
      );

      // The redelivery computes today's key; it must find the rewritten row, not queue a second one.
      await conversionHook({ db: before.db })(target.ws, [
        {
          event: event({
            workspaceId: target.ws,
            messageId: kept,
            context: { consent: { categoryPreferences: { ad_measurement: true } } },
          }),
          profileId,
        },
      ]);

      expect(await deliveries(target)).toEqual([
        { idempotency_key: `adc:meta:${connection}:Purchase:${kept}`, profile_id: profileId },
        { idempotency_key: `adc:meta:${connection}:Purchase:${replays}`, profile_id: profileId },
      ]);
    } finally {
      await before.close();
    }
  }, 180_000);
});
