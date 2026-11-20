import { canonicalPeople, DEFAULT_PURPOSES } from '@agentic-marketing/artifacts';
import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import type { BusEvent, EventStore } from '@agentic-marketing/events';
import { applyEvents, lockProfileRows, personCrypto, profileIdsForBatch, type ResolvedEvent } from '@agentic-marketing/profiles';
import { localKeyProvider, prepareKeys, withPreparedKeys } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { journeyHook, sweep } from '../src/runtime';

// #1011 review: the sweep's candidate window and the journey hook's retry behaviour.
//   - a batch of one must not be defeated by the first candidate's locked profile row, and due time
//     decides which person moves first (not the profile id);
//   - an event that is delivered again must not enrol the same participant twice after it left the
//     journey, and must not satisfy a wait it created itself;
//   - a person a merge folded away between the sweep's lookup and its profile lock is deferred, never
//     locked and claimed (which would write the survivor without holding it).

const MASTER_KEY = Buffer.alloc(32, 45).toString('base64');

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let kp: ReturnType<typeof localKeyProvider>;
let ws: string;
let clock = 0;

const eventStore = { async insertJourneyEvents() {} } as unknown as EventStore;
const deps = () => ({ kp, events: eventStore });

const at = () => new Date(Date.UTC(2026, 0, 1, 0, clock++)).toISOString();

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('journey_sweep_redelivery');
  kp = localKeyProvider(MASTER_KEY);
  ws = d.workspace;
}, 120_000);

beforeEach(async () => {
  if (!hasTestDatabase()) return;
  // Each case owns the workspace's participants, so a due row from an earlier case cannot change
  // which people a batch of one selects (and the processed-event log starts empty again).
  await d.db.admin.query('DELETE FROM journey_participants WHERE workspace_id = $1', [ws]);
  await d.db.admin.query('DELETE FROM journey_processed_events WHERE workspace_id = $1', [ws]);
});

afterAll(async () => {
  await d?.close();
});

const event = (over: Partial<BusEvent>): BusEvent => {
  const timestamp = at();
  return {
    workspaceId: ws,
    sourceId: 'src_sweep_redelivery',
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

const runBatch = (events: BusEvent[]): Promise<ResolvedEvent[]> =>
  withPreparedKeys(
    async () => {
      const profileIds = await d.db.withWorkspace(ws, (tx) => profileIdsForBatch(tx, ws, events, personCrypto(tx, ws, kp)));
      return prepareKeys(d.db, ws, kp, { profileIds });
    },
    (prepared) => d.db.withWorkspace(ws, (tx) => applyEvents(tx, ws, events, { prepared, purposes: async () => DEFAULT_PURPOSES })),
  );

async function seedProfile(id: string, idents: { anonymous?: string; user?: string } = {}) {
  await d.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.profiles).values({ workspaceId: ws, id });
    const rows = [];
    if (idents.anonymous) rows.push({ workspaceId: ws, profileId: id, type: 'anonymous_id' as const, value: idents.anonymous });
    if (idents.user) rows.push({ workspaceId: ws, profileId: id, type: 'user_id' as const, value: idents.user });
    if (rows.length) await tx.insert(schema.identifiers).values(rows);
  });
}

/** A published journey built from the given nodes. */
async function publishJourney(nodes: unknown[]): Promise<string> {
  const journeyId = newId('jrn');
  await d.db.admin.query(
    `INSERT INTO artifacts (workspace_id, id, type, name, latest_version, published_version)
     VALUES ($1, $2, 'journey', $3, 1, 1)`,
    [ws, journeyId, `Journey ${journeyId}`],
  );
  await d.db.admin.query(
    `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
     VALUES ($1, $2, 1, 'published', $3, $4, 'user', 'user_test')`,
    [ws, journeyId, JSON.stringify({ purpose: 'marketing_email', nodes }), `hash_${journeyId}`],
  );
  return journeyId;
}

const packJourney = (traitKey = 'pack') =>
  publishJourney([
    { id: 'start', kind: 'trigger', label: 'Start', config: { event: 'Sweep Pack' }, next: [{ to: 'done' }] },
    { id: 'done', kind: 'updateProfile', label: 'Set trait', config: { trait: traitKey, value: true }, next: [] },
  ]);

/** Purchase then wait for another Purchase: the event that enrolled must not wake its own wait. */
const purchaseJourney = (name: string) =>
  publishJourney([
    { id: 'start', kind: 'trigger', label: 'Bought', config: { event: name }, next: [{ to: 'wait' }] },
    { id: 'wait', kind: 'waitEvent', label: 'Wait', config: { event: name, timeout: 'P1D' }, next: [{ to: 'done' }] },
    { id: 'done', kind: 'exit', label: 'Done', config: {} },
  ]);

/** Waits for the same event twice: the event that satisfies the first wait must not satisfy the second. */
const twiceJourney = (name: string) =>
  publishJourney([
    { id: 'start', kind: 'trigger', label: 'Start', config: { event: name }, next: [{ to: 'first' }] },
    { id: 'first', kind: 'waitEvent', label: 'First wait', config: { event: name, timeout: 'P30D' }, next: [{ to: 'second' }] },
    { id: 'second', kind: 'waitEvent', label: 'Second wait', config: { event: name, timeout: 'P30D' }, next: [{ to: 'done' }] },
    { id: 'done', kind: 'exit', label: 'Done', config: {} },
  ]);

/** A wait followed by a goal on the same event name: the goal must only see a later delivery. */
const waitThenGoalJourney = (name: string) =>
  publishJourney([
    { id: 'start', kind: 'trigger', label: 'Start', config: { event: name }, next: [{ to: 'gate' }] },
    { id: 'gate', kind: 'waitEvent', label: 'Gate', config: { event: name, timeout: 'P30D' }, next: [{ to: 'goal' }] },
    {
      id: 'goal',
      kind: 'goal',
      label: 'Goal',
      config: { event: name, within: 'P30D' },
      next: [{ to: 'won' }, { to: 'lost' }],
    },
    { id: 'won', kind: 'exit', label: 'Converted', config: {} },
    { id: 'lost', kind: 'exit', label: 'Missed', config: {} },
  ]);

/** Re-entry after exit: once the participant leaves, another delivery of the same event is allowed. */
const signupJourney = (name: string) =>
  publishJourney([
    { id: 'start', kind: 'trigger', label: 'Signed up', config: { event: name, reentry: 'after_exit' }, next: [{ to: 'done' }] },
    { id: 'done', kind: 'exit', label: 'Done', config: {} },
  ]);

/** A participant due at the given time, as the hook leaves one. */
async function dueParticipant(journeyId: string, profileId: string, dueAt: Date): Promise<number> {
  const [row] = await d.db.withWorkspace(ws, (tx) =>
    tx
      .insert(schema.journeyParticipants)
      .values({
        workspaceId: ws,
        journeyId,
        version: 1,
        profileId,
        entryKey: `test:${profileId}:${journeyId}`,
        node: 'start',
        status: 'ready',
        dueAt,
      })
      .returning({ id: schema.journeyParticipants.id }),
  );
  return row!.id;
}

const participant = async (id: number) => {
  const { rows } = await d.db.admin.query<{ status: string; matched: boolean; node: string }>(
    'SELECT status, matched, node FROM journey_participants WHERE workspace_id = $1 AND id = $2',
    [ws, id],
  );
  return rows[0];
};

const mergedInto = async (profileId: string): Promise<string | null> => {
  const { rows } = await d.db.admin.query<{ merged_into: string | null }>(
    'SELECT merged_into FROM profiles WHERE workspace_id = $1 AND id = $2',
    [ws, profileId],
  );
  return rows[0]?.merged_into ?? null;
};

const participantsOf = async (journeyId: string) => {
  const { rows } = await d.db.admin.query<{ status: string; matched: boolean; node: string }>(
    'SELECT status, matched, node FROM journey_participants WHERE workspace_id = $1 AND journey_id = $2 ORDER BY id',
    [ws, journeyId],
  );
  return rows;
};

describe.skipIf(!hasTestDatabase())('journey sweep candidate selection (#1011 review)', () => {
  it('skips a locked person instead of returning an empty batch', async () => {
    const ids = [newId('prf'), newId('prf')].sort();
    const [lockedId, freeId] = ids as [string, string];
    await seedProfile(lockedId);
    await seedProfile(freeId);
    const journeyId = await packJourney();
    const lockedParticipant = await dueParticipant(journeyId, lockedId, new Date(Date.UTC(2025, 10, 1)));
    const freeParticipant = await dueParticipant(journeyId, freeId, new Date(Date.UTC(2025, 10, 2)));

    const probe = await d.db.admin.connect();
    let moved = 0;
    try {
      await probe.query('BEGIN');
      await probe.query('SELECT 1 FROM profiles WHERE workspace_id = $1 AND id = $2 FOR NO KEY UPDATE', [ws, lockedId]);
      // A batch of one, and the first candidate (lowest profile id) is the person a batch is
      // writing right now: the sweep must look past them and move the next due participant.
      moved = await sweep(d.db, deps(), { batch: 1 });
    } finally {
      await probe.query('ROLLBACK').catch(() => {});
      probe.release();
    }

    expect(moved).toBe(1);
    expect(await participant(lockedParticipant)).toMatchObject({ status: 'ready' });
    expect(await participant(freeParticipant)).toMatchObject({ status: 'completed' });
  }, 120_000);

  it('moves the oldest due participant first, not the lowest profile id', async () => {
    const ids = [newId('prf'), newId('prf')].sort();
    const [laterId, earlierId] = ids as [string, string];
    await seedProfile(laterId);
    await seedProfile(earlierId);
    const journeyId = await packJourney();
    const laterParticipant = await dueParticipant(journeyId, laterId, new Date(Date.UTC(2025, 11, 2)));
    const earlierParticipant = await dueParticipant(journeyId, earlierId, new Date(Date.UTC(2025, 11, 1)));

    const moved = await sweep(d.db, deps(), { batch: 1 });

    expect(moved).toBe(1);
    // The lower profile id is due later; due time, not the id order, decides.
    expect(await participant(laterParticipant)).toMatchObject({ status: 'ready' });
    expect(await participant(earlierParticipant)).toMatchObject({ status: 'completed' });
  }, 120_000);
});

describe.skipIf(!hasTestDatabase())('a journey event is applied once (#1011 review)', () => {
  it('does not wake a wait with the event that created it when the event is delivered again', async () => {
    const person = newId('prf');
    await seedProfile(person, { anonymous: `anon-${person}` });
    const journeyId = await purchaseJourney('Purchase Again');
    const resolved = await runBatch([event({ anonymousId: `anon-${person}`, name: 'Purchase Again' })]);
    const hook = journeyHook(d.db, deps());

    await hook(ws, resolved);
    // The sweeper advances the new participant to its wait before the event could be seen again.
    await sweep(d.db, deps());
    expect(await participantsOf(journeyId)).toMatchObject([{ status: 'waiting', matched: false }]);

    // At-least-once delivery: the same event arrives again.
    await hook(ws, resolved);
    await sweep(d.db, deps());

    // It waits for the *next* purchase, not the one that enrolled it.
    expect(await participantsOf(journeyId)).toMatchObject([{ status: 'waiting', matched: false }]);
  }, 120_000);

  it('does not wake a later wait with a redelivery of the event that satisfied the first wait (#1052)', async () => {
    const person = newId('prf');
    await seedProfile(person, { anonymous: `anon-${person}` });
    const journeyId = await twiceJourney('Repeat Click');
    const hook = journeyHook(d.db, deps());

    // The trigger enrols the person; the sweeper moves them to the first wait.
    await hook(ws, await runBatch([event({ anonymousId: `anon-${person}`, name: 'Repeat Click' })]));
    await sweep(d.db, deps());
    expect(await participantsOf(journeyId)).toMatchObject([{ status: 'waiting', node: 'first', matched: false }]);

    // A genuinely new click satisfies the first wait and moves the person to the second.
    const click = await runBatch([event({ anonymousId: `anon-${person}`, name: 'Repeat Click' })]);
    await hook(ws, click);
    await sweep(d.db, deps());
    expect(await participantsOf(journeyId)).toMatchObject([{ status: 'waiting', node: 'second', matched: false }]);

    // The same click delivered again is the event that already spent itself on the first wait.
    await hook(ws, click);
    await sweep(d.db, deps());

    expect(await participantsOf(journeyId)).toMatchObject([{ status: 'waiting', node: 'second', matched: false }]);
  }, 120_000);

  it('does not satisfy a goal with a redelivery of the event that satisfied the earlier wait (#1052)', async () => {
    const person = newId('prf');
    await seedProfile(person, { anonymous: `anon-${person}` });
    const journeyId = await waitThenGoalJourney('Repeat Goal');
    const hook = journeyHook(d.db, deps());

    await hook(ws, await runBatch([event({ anonymousId: `anon-${person}`, name: 'Repeat Goal' })]));
    await sweep(d.db, deps());
    expect(await participantsOf(journeyId)).toMatchObject([{ status: 'waiting', node: 'gate', matched: false }]);

    // This event satisfies the gate; the person now waits at the goal on the same event name.
    const goalEvent = await runBatch([event({ anonymousId: `anon-${person}`, name: 'Repeat Goal' })]);
    await hook(ws, goalEvent);
    await sweep(d.db, deps());
    expect(await participantsOf(journeyId)).toMatchObject([{ status: 'waiting', node: 'goal', matched: false }]);

    // Its redelivery must not convert the person at the goal.
    await hook(ws, goalEvent);
    await sweep(d.db, deps());

    expect(await participantsOf(journeyId)).toMatchObject([{ status: 'waiting', node: 'goal', matched: false }]);
    const { rows } = await d.db.admin.query<{ converted: boolean }>(
      'SELECT converted FROM journey_participants WHERE workspace_id = $1 AND journey_id = $2',
      [ws, journeyId],
    );
    expect(rows).toEqual([{ converted: false }]);
  }, 120_000);

  it('does not enrol one event twice after its participant left the journey', async () => {
    const person = newId('prf');
    await seedProfile(person, { anonymous: `anon-${person}` });
    const journeyId = await signupJourney('Signup Again');
    const resolved = await runBatch([event({ anonymousId: `anon-${person}`, name: 'Signup Again' })]);
    const hook = journeyHook(d.db, deps());

    await hook(ws, resolved);
    await sweep(d.db, deps());
    expect((await participantsOf(journeyId)).map((row) => row.status)).toEqual(['completed']);

    // after_exit allows another *event* to enrol the person again; the same event must not.
    await hook(ws, resolved);
    await sweep(d.db, deps());

    expect(await participantsOf(journeyId)).toHaveLength(1);
  }, 120_000);

  it('records the person and the caller-supplied event id on the marker', async () => {
    const person = newId('prf');
    await seedProfile(person, { anonymous: `anon-${person}` });
    await signupJourney('Signup Marker');
    // An event id is caller-supplied and can name the person: it must not outlive them (see the
    // erasure tests), and it must name who the event enrolled.
    const messageId = 'customer@example.test:purchase-1';
    const resolved = await runBatch([event({ anonymousId: `anon-${person}`, name: 'Signup Marker', messageId })]);

    await journeyHook(d.db, deps())(ws, resolved);

    const { rows } = await d.db.admin.query<{ profile_id: string }>(
      'SELECT profile_id FROM journey_processed_events WHERE workspace_id = $1 AND event_id = $2',
      [ws, messageId],
    );
    expect(rows).toEqual([{ profile_id: person }]);
  }, 120_000);
});

describe.skipIf(!hasTestDatabase())('the sweep never locks a folded-away person (#1011 review)', () => {
  it('defers a person a merge folded away after the sweep looked them up', async () => {
    const folded = newId('prf');
    const survivor = newId('prf');
    await seedProfile(survivor, { user: `user-${survivor}` });
    await seedProfile(folded, { anonymous: `anon-${folded}` });
    // The sweep's canonical lookup runs now: `folded` is the person today.
    const looked = await d.db.withWorkspace(ws, (tx) => canonicalPeople(tx, ws, [folded]));
    expect(looked.get(folded)).toBe(folded);

    // A merge commits between that lookup and the profile lock.
    await runBatch([event({ anonymousId: `anon-${folded}`, userId: `user-${survivor}` })]);
    expect(await mergedInto(folded)).toBe(survivor);

    // The lock must not hand the folded-away row back. Claiming a participant row with it would
    // write the survivor's profile without holding the survivor, which is the cycle with a merge.
    const stale = await d.db.withWorkspace(ws, (tx) => lockProfileRows(tx, ws, [...new Set(looked.values())]));
    expect(stale).toEqual([]);

    // The next sweep's lookup finds the survivor, and that row is locked.
    const next = await d.db.withWorkspace(ws, (tx) => canonicalPeople(tx, ws, [folded]));
    expect(next.get(folded)).toBe(survivor);
    expect(await d.db.withWorkspace(ws, (tx) => lockProfileRows(tx, ws, [...new Set(next.values())]))).toEqual([survivor]);
  }, 120_000);
});
