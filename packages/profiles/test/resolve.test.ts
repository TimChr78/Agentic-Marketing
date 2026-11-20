import { DEFAULT_PURPOSES } from '@agentic-marketing/artifacts';
import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import type { BusEvent } from '@agentic-marketing/events';
import { localKeyProvider, prepareKeys, withPreparedKeys } from '@agentic-marketing/secrets';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { personCrypto } from '../src/crypto';
import { applyEvents, profileIdsForBatch } from '../src/resolve';

// #1141: group traits describe a company and must not become the person's profile traits.
// #1142: an alias that names itself (previousId === anonymousId/userId) used to insert the same
// identifier twice and poison the worker batch with a 23505, so every delivery failed again.

const MASTER_KEY = Buffer.alloc(32, 45).toString('base64');

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let kp: ReturnType<typeof localKeyProvider>;
let ws: string;
let clock = 0;

const at = () => new Date(Date.UTC(2026, 0, 1, 0, clock++)).toISOString();

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('profiles_resolve');
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
    sourceId: 'src_resolve_test',
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

const runBatch = (events: BusEvent[]) =>
  withPreparedKeys(
    async () => {
      const profileIds = await d.db.withWorkspace(ws, (tx) => profileIdsForBatch(tx, ws, events, personCrypto(tx, ws, kp)));
      return prepareKeys(d.db, ws, kp, { profileIds });
    },
    (prepared) => d.db.withWorkspace(ws, (tx) => applyEvents(tx, ws, events, { prepared, purposes: async () => DEFAULT_PURPOSES })),
  );

const traitsOf = async (profileId: string) => {
  const [row] = await d.db.withWorkspace(ws, (tx) =>
    tx
      .select({ traits: schema.profiles.traits })
      .from(schema.profiles)
      .where(and(eq(schema.profiles.workspaceId, ws), eq(schema.profiles.id, profileId))),
  );
  return row?.traits;
};

const identifiersOf = async (profileId: string) =>
  d.db.withWorkspace(ws, (tx) =>
    tx
      .select({ type: schema.identifiers.type, value: schema.identifiers.value })
      .from(schema.identifiers)
      .where(and(eq(schema.identifiers.workspaceId, ws), eq(schema.identifiers.profileId, profileId))),
  );

describe.skipIf(!hasTestDatabase())('identity resolution', () => {
  it('does not merge group traits into the person’s profile (#1141)', async () => {
    const [person] = await runBatch([event({ type: 'identify', userId: 'u-group', traits: { plan: 'pro' } })]);
    expect(person?.profileId).toMatch(/^prf_/);

    const [group] = await runBatch([
      event({
        type: 'group',
        userId: 'u-group',
        groupId: 'grp_1',
        traits: { plan: 'enterprise', industry: 'Software' },
      }),
    ]);
    expect(group?.profileId).toBe(person?.profileId);
    expect(await traitsOf(person!.profileId)).toEqual({ plan: 'pro' });
  });

  it('resolves an alias whose previousId is its own anonymous id (#1142)', async () => {
    const [resolved] = await runBatch([event({ type: 'alias', anonymousId: 'anon-self', previousId: 'anon-self' })]);
    expect(resolved?.profileId).toMatch(/^prf_/);
    expect(await identifiersOf(resolved!.profileId)).toEqual([{ type: 'anonymous_id', value: 'anon-self' }]);
  });

  it('resolves an alias whose previousId is its own user id (#1142)', async () => {
    const [person] = await runBatch([event({ type: 'identify', userId: 'user-self' })]);
    const [resolved] = await runBatch([event({ type: 'alias', userId: 'user-self', previousId: 'user-self' })]);
    expect(resolved?.profileId).toBe(person?.profileId);
    expect(await identifiersOf(person!.profileId)).toContainEqual({ type: 'user_id', value: 'user-self' });
  });
});
