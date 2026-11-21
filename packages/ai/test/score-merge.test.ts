import { DEFAULT_PURPOSES } from '@agentic-marketing/artifacts';
import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import type { BusEvent } from '@agentic-marketing/events';
import { applyEvents, personCrypto, profileIdsForBatch } from '@agentic-marketing/profiles';
import { localKeyProvider, prepareKeys, withPreparedKeys } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { calibration, profileScores } from '../src/score';

// #1144: an identity merge moved identifiers, journeys, messages and list memberships but left
// `profile_scores` behind on the merged-away profile. Segmentation, journeys and profiles.scores
// read only the canonical id, so the score vanished; ai.calibration then read the orphan row and
// found no identifiers for it, counting every merged-away prediction as a miss.

const MASTER_KEY = Buffer.alloc(32, 61).toString('base64');

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let kp: ReturnType<typeof localKeyProvider>;
let ws: string;
let clock = 0;

const at = () => new Date(Date.UTC(2026, 4, 1, 0, clock++)).toISOString();

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('ai_score_merge');
  kp = localKeyProvider(MASTER_KEY);
  ws = d.workspace;
}, 120_000);

afterAll(async () => {
  await d?.close();
});

const event = (over: Partial<BusEvent>): BusEvent => {
  const timestamp = at();
  return {
    workspaceId: ws,
    sourceId: 'src_score_merge',
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

async function seedProfile(id: string, idents: { anonymous?: string; user?: string }, createdAt: Date) {
  await d.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.profiles).values({ workspaceId: ws, id, createdAt });
    const rows = [];
    if (idents.anonymous) rows.push({ workspaceId: ws, profileId: id, type: 'anonymous_id' as const, value: idents.anonymous });
    if (idents.user) rows.push({ workspaceId: ws, profileId: id, type: 'user_id' as const, value: idents.user });
    if (rows.length) await tx.insert(schema.identifiers).values(rows);
  });
}

async function score(profileId: string, key: string, value: number, createdAt: Date) {
  await d.db.withWorkspace(ws, (tx) =>
    tx.insert(schema.profileScores).values({
      workspaceId: ws,
      profileId,
      key,
      value,
      probabilities: {},
      model: 'test-model',
      modelVersion: 'v1',
      createdAt,
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    }),
  );
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

describe.skipIf(!hasTestDatabase())('an identity merge moves profile_scores (#1144)', () => {
  it('keeps the newer score per key on the survivor and leaves no orphan row', async () => {
    const survivor = newId('prf');
    const alias = newId('prf');
    await seedProfile(survivor, { user: `user-${survivor}` }, new Date(Date.UTC(2026, 4, 1)));
    await seedProfile(alias, { anonymous: `anon-${alias}` }, new Date(Date.UTC(2026, 4, 2)));
    // The survivor's propensity is older, so the alias's newer value wins; the churn score only
    // exists on the alias and must move as it is.
    await score(survivor, 'propensity', 0.5, new Date(Date.UTC(2026, 4, 3)));
    await score(alias, 'propensity', 0.77, new Date(Date.UTC(2026, 4, 4)));
    await score(alias, 'churn', 0.2, new Date(Date.UTC(2026, 4, 4)));

    await merge(`anon-${alias}`, `user-${survivor}`);

    const rows = await d.db.admin.query<{ profile_id: string; key: string; value: number }>(
      'SELECT profile_id, key, value FROM profile_scores WHERE workspace_id = $1 ORDER BY key',
      [ws],
    );
    expect(rows.rows).toEqual([
      { profile_id: survivor, key: 'churn', value: 0.2 },
      { profile_id: survivor, key: 'propensity', value: 0.77 },
    ]);
  }, 60_000);

  it('resolves the canonical profile for profiles.scores and ai.calibration', async () => {
    const survivor = newId('prf');
    const alias = newId('prf');
    await seedProfile(survivor, { user: `user-${survivor}` }, new Date(Date.UTC(2026, 4, 10)));
    await seedProfile(alias, { anonymous: `anon-${alias}` }, new Date(Date.UTC(2026, 4, 11)));
    // Both profiles hold a score under the same key, and the alias's is the newer one: a read that
    // follows the merge without a move would answer the survivor's stale 0.4, and calibration would
    // count the alias row as a second prediction with no identifiers.
    await score(survivor, 'conversion_propensity', 0.4, new Date(Date.UTC(2026, 4, 12)));
    await score(alias, 'conversion_propensity', 0.6, new Date(Date.UTC(2026, 4, 13)));

    await merge(`anon-${alias}`, `user-${survivor}`);

    const rows = await d.db.admin.query<{ profile_id: string; value: number }>(
      `SELECT profile_id, value FROM profile_scores WHERE workspace_id = $1 AND key = 'conversion_propensity'`,
      [ws],
    );
    expect(rows.rows).toEqual([{ profile_id: survivor, value: 0.6 }]);

    const scores = await d.db.withWorkspace(ws, (tx) =>
      profileScores.handler({ profileId: alias }, { tx, principal: { workspaceId: ws } } as never),
    );
    expect(scores.scores).toMatchObject([{ key: 'conversion_propensity', value: 0.6 }]);

    const report = await d.db.withWorkspace(ws, (tx) =>
      calibration.handler({ scoreKey: 'conversion_propensity', event: 'Order Completed', withinDays: 14, bins: 10, limit: 20_000 }, {
        tx,
        principal: { workspaceId: ws },
        services: { events: { conversionEvents: async () => [] } },
      } as never),
    );
    // Before the merge was followed, the orphan row was a second prediction with no identifiers.
    expect(report.predictions).toBe(1);
    expect(report.positives).toBe(0);
  }, 60_000);
});
