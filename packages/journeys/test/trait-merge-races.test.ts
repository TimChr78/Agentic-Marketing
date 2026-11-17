import { DEFAULT_PURPOSES } from '@agentic-marketing/artifacts';
import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import type { BusEvent, EventStore } from '@agentic-marketing/events';
import { applyEvents, personCrypto, profileIdsForBatch, type ResolvedEvent } from '@agentic-marketing/profiles';
import { localKeyProvider, prepareKeys, withPreparedKeys } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { journeyHook, sweep } from '../src/runtime';
import {
  blockedBy,
  dropIdentifierPause,
  dropMergeCommitPause,
  holdPause,
  IDENTIFIER_PAUSE_KEY,
  identityHolders,
  installIdentifierPause,
  installMergeCommitPause,
  MERGE_COMMIT_PAUSE_KEY,
  releasePause,
  waitFor,
  waitForAdvisoryHolderBlocked,
  waitForIdentityWaiter,
} from './raceSupport';

// #1011: journey trait writes around a merge. Every case runs the production entry points (the
// profile worker batch that merges, the post-resolve journey hook and the journey sweep) against
// real PostgreSQL transactions. A pause trigger stops the merge at a named point and a barrier
// decides when the other path may continue, so no test depends on timing.

const MASTER_KEY = Buffer.alloc(32, 43).toString('base64');

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let kp: ReturnType<typeof localKeyProvider>;
let ws: string;
let clock = 0;

/** A store that records nothing: these journeys have no wait-until condition or holdout report. */
const eventStore = { async insertJourneyEvents() {} } as unknown as EventStore;
const deps = () => ({ kp, events: eventStore });

const at = () => new Date(Date.UTC(2026, 0, 1, 0, clock++)).toISOString();

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('journey_trait_races');
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
    sourceId: 'src_journey_race',
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

/** One real profile-worker batch: prepare the keys, then the identity-locked transaction. */
const runBatch = (events: BusEvent[]): Promise<ResolvedEvent[]> =>
  withPreparedKeys(
    async () => {
      const profileIds = await d.db.withWorkspace(ws, (tx) => profileIdsForBatch(tx, ws, events, personCrypto(tx, ws, kp)));
      return prepareKeys(d.db, ws, kp, { profileIds });
    },
    (prepared) => d.db.withWorkspace(ws, (tx) => applyEvents(tx, ws, events, { prepared, purposes: async () => DEFAULT_PURPOSES })),
  );

/** A published journey: trigger on `trigger`, then one updateProfile step, then exit. */
async function publishedJourney(trigger: string, trait: string, value: string | number | boolean): Promise<string> {
  const journeyId = newId('jrn');
  await d.db.admin.query(
    `INSERT INTO artifacts (workspace_id, id, type, name, latest_version, published_version)
     VALUES ($1, $2, 'journey', $3, 1, 1)`,
    [ws, journeyId, `Journey ${journeyId}`],
  );
  await d.db.admin.query(
    `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
     VALUES ($1, $2, 1, 'published', $3, $4, 'user', 'user_test')`,
    [
      ws,
      journeyId,
      JSON.stringify({
        purpose: 'marketing_email',
        nodes: [
          { id: 'start', kind: 'trigger', label: 'Start', config: { event: trigger }, next: [{ to: 'trait' }] },
          { id: 'trait', kind: 'updateProfile', label: 'Set trait', config: { trait, value }, next: [{ to: 'done' }] },
          { id: 'done', kind: 'exit', label: 'Done', config: {} },
        ],
      }),
      `hash_${journeyId}`,
    ],
  );
  return journeyId;
}

/** A participant the sweep must advance now, sitting on `profileId` as the hook left it. */
async function dueParticipant(journeyId: string, profileId: string): Promise<string> {
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
        dueAt: new Date(Date.UTC(2025, 11, 1)),
      })
      .returning({ id: schema.journeyParticipants.id }),
  );
  return String(row!.id);
}

const participant = async (id: string) => {
  const { rows } = await d.db.admin.query<{ profile_id: string; status: string; seq: number; error: string | null }>(
    'SELECT profile_id, status, seq, error FROM journey_participants WHERE workspace_id = $1 AND id = $2',
    [ws, id],
  );
  return rows[0];
};

const participantsOf = async (journeyId: string) => {
  const { rows } = await d.db.admin.query<{ profile_id: string; status: string }>(
    'SELECT profile_id, status FROM journey_participants WHERE workspace_id = $1 AND journey_id = $2 ORDER BY id',
    [ws, journeyId],
  );
  return rows;
};

const traitsOf = async (profileId: string): Promise<Record<string, unknown>> => {
  const { rows } = await d.db.admin.query<{ traits: Record<string, unknown> }>(
    'SELECT traits FROM profiles WHERE workspace_id = $1 AND id = $2',
    [ws, profileId],
  );
  return rows[0]?.traits ?? {};
};

const mergedInto = async (profileId: string): Promise<string | null> => {
  const { rows } = await d.db.admin.query<{ merged_into: string | null }>(
    'SELECT merged_into FROM profiles WHERE workspace_id = $1 AND id = $2',
    [ws, profileId],
  );
  return rows[0]?.merged_into ?? null;
};

/** A younger profile P merged into the older Q by one real batch. */
async function pair() {
  const q = newId('prf');
  const p = newId('prf');
  await seedProfile(q, { user: `user-${q}` }, new Date(Date.UTC(2026, 0, 1)));
  await seedProfile(p, { anonymous: `anon-${p}` }, new Date(Date.UTC(2026, 0, 2)));
  return { p, q, anon: `anon-${p}`, user: `user-${q}` };
}

describe.skipIf(!hasTestDatabase())('journey trait writes around a merge (#1011)', () => {
  it('a trait step after the merge follows the survivor instead of updating zero rows', async () => {
    const { p, q, anon, user } = await pair();
    const journeyId = await publishedJourney('Trait After Merge', 'plan', 'gold');
    // The merge commits first; a participant row left on the folded-away id is what the hook used to
    // insert (#1010 already stopped the trait step from writing it, and reported success anyway).
    await runBatch([event({ anonymousId: anon, userId: user })]);
    expect(await mergedInto(p)).toBe(q);
    const id = await dueParticipant(journeyId, p);

    await sweep(d.db, deps());

    expect(await participant(id)).toMatchObject({ status: 'completed', profile_id: p });
    // The survivor holds the trait; the merged-away row keeps nothing.
    expect(await traitsOf(q)).toMatchObject({ plan: 'gold' });
    expect(await traitsOf(p)).toEqual({});
  }, 120_000);

  it('a trait step that commits before the merge keeps the trait on the survivor', async () => {
    const { p, q, anon, user } = await pair();
    const journeyId = await publishedJourney('Trait Before Merge', 'tier', 'gold');
    const id = await dueParticipant(journeyId, p);

    await sweep(d.db, deps());
    expect(await traitsOf(p)).toMatchObject({ tier: 'gold' });

    await runBatch([event({ anonymousId: anon, userId: user })]);

    expect(await participant(id)).toMatchObject({ status: 'completed', profile_id: q });
    expect(await traitsOf(q)).toMatchObject({ tier: 'gold' });
  }, 120_000);

  it('a trait written while a merge is in flight is not overwritten by the merge', async () => {
    const { p, q, anon, user } = await pair();
    const journeyId = await publishedJourney('Trait During Merge', 'plan', 'gold');
    const id = await dueParticipant(journeyId, p);
    // One connection lifetime and one finally: the pause lock is released, the merge settled and the
    // client given back whatever the test does (#1011 review).
    const probe = await d.db.admin.connect();
    let merge: Promise<unknown> | undefined;
    let mergeError: unknown;
    try {
      await installIdentifierPause(probe);
      await holdPause(probe, IDENTIFIER_PAUSE_KEY);
      // The merge locks the profile rows and stops while it moves identifiers: the trait snapshot it
      // will write is already decided, and the participant row is still free.
      merge = runBatch([event({ anonymousId: anon, userId: user })]);
      await waitForAdvisoryHolderBlocked(probe, ws);

      // The sweep must not write a trait the merge is about to overwrite. Holding the profile row
      // makes it defer this participant to its next run instead of losing the write.
      await sweep(d.db, deps());
      expect(await participant(id)).toMatchObject({ status: 'ready' });
    } finally {
      await releasePause(probe, IDENTIFIER_PAUSE_KEY).catch(() => {});
      await dropIdentifierPause(probe).catch(() => {});
      const settled = await Promise.allSettled([merge]);
      mergeError = settled[0]?.status === 'rejected' ? settled[0].reason : undefined;
      probe.release();
    }
    expect(mergeError).toBeUndefined();
    expect(await mergedInto(p)).toBe(q);

    await sweep(d.db, deps());

    expect(await participant(id)).toMatchObject({ status: 'completed', profile_id: q });
    expect(await traitsOf(q)).toMatchObject({ plan: 'gold' });
  }, 120_000);

  it('an enrollment that races a merge enters on the survivor', async () => {
    const { p, q, anon, user } = await pair();
    const journeyId = await publishedJourney('Signup Race', 'signed_up', true);
    // The batch that the hook follows resolved the person before the merge exists.
    const resolved = await runBatch([event({ anonymousId: anon, name: 'Signup Race' })]);
    expect(resolved.map((r) => r.profileId)).toEqual([p]);
    const probe = await d.db.admin.connect();
    let merge: Promise<unknown> | undefined;
    let entered: Promise<void> | undefined;
    let failure: unknown;
    try {
      await installMergeCommitPause(probe);
      await holdPause(probe, MERGE_COMMIT_PAUSE_KEY);
      // The merge has moved the participant rows (there are none yet) and waits to commit.
      merge = runBatch([event({ anonymousId: anon, userId: user })]);
      await waitForAdvisoryHolderBlocked(probe, ws);

      // The hook starts while the merge is uncommitted. It must wait for the workspace identity
      // lock and then enroll on the survivor, never on the id the merge folds away.
      entered = journeyHook(d.db, deps())(ws, resolved);
      await Promise.race([entered.then(() => 'done'), waitForIdentityWaiter(probe, ws).then(() => 'queued')]);
    } finally {
      await releasePause(probe, MERGE_COMMIT_PAUSE_KEY).catch(() => {});
      await dropMergeCommitPause(probe).catch(() => {});
      const settled = await Promise.allSettled([merge, entered]);
      failure = settled.find((r) => r.status === 'rejected')?.reason;
      probe.release();
    }
    expect(failure).toBeUndefined();

    expect(await participantsOf(journeyId)).toEqual([{ profile_id: q, status: 'ready' }]);
  }, 120_000);

  it('a journey sweep and a merge in one SDK batch do not deadlock', async () => {
    const { p, q, anon, user } = await pair();
    const journeyId = await publishedJourney('Sweep Versus Merge', 'plan', 'gold');
    const id = await dueParticipant(journeyId, p);
    // An old last_seen makes the batch's first event take the fast-path row lock on P, which is the
    // lock the sweep used to wait for after it had claimed P's participant row.
    await d.db.admin.query('UPDATE profiles SET last_seen = $1 WHERE workspace_id = $2 AND id = $3', [
      new Date(Date.UTC(2025, 0, 1)),
      ws,
      p,
    ]);
    const probe = await d.db.admin.connect();
    const holders = await identityHolders(probe, ws);
    expect(holders).toEqual([]);
    let merge: Promise<unknown> | undefined;
    let swept: Promise<number> | undefined;
    let failure: unknown;
    try {
      await installIdentifierPause(probe);
      await holdPause(probe, IDENTIFIER_PAUSE_KEY);
      merge = runBatch([event({ anonymousId: anon }), event({ anonymousId: anon, userId: user })]);
      const batchPid = await waitForAdvisoryHolderBlocked(probe, ws);

      swept = sweep(d.db, deps());
      // Without the profile-before-participant order the sweep holds the participant row and waits
      // for P; releasing the merge then closes the cycle. With it, the sweep defers P and returns.
      let settled = false;
      void swept.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await waitFor('the sweep to finish or block', async () => settled || (await blockedBy(probe, batchPid)).length > 0);
    } finally {
      await releasePause(probe, IDENTIFIER_PAUSE_KEY).catch(() => {});
      await dropIdentifierPause(probe).catch(() => {});
      const settled = await Promise.allSettled([merge, swept]);
      failure = settled.find((r) => r.status === 'rejected')?.reason;
      probe.release();
    }
    // Both must finish: a deadlock would reject one of them with 40P01.
    expect(failure).toBeUndefined();
    expect(await participant(id)).toMatchObject({ status: 'ready', profile_id: q });

    await sweep(d.db, deps());

    expect(await participant(id)).toMatchObject({ status: 'completed', profile_id: q });
    expect(await traitsOf(q)).toMatchObject({ plan: 'gold' });
  }, 120_000);
});
