import { DEFAULT_PURPOSES } from '@agentic-marketing/artifacts';
import { newId, newUuid } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { type BusEvent, CONSENT_EVENT, type EventBus, type EventStore } from '@agentic-marketing/events';
import type { HotState } from '@agentic-marketing/hotstate';
import {
  applyEvents,
  assertIdentityLock,
  consentStateOf,
  disposeErasure,
  eraseProfileStage,
  IdentityLockTimeoutError,
  identityLockHeld,
  identityLockSnapshot,
  mergedFamily,
  personCrypto,
  prepareErasure,
  profileIdsForBatch,
  recordConsentEvidence,
  resetIdentityLockMetrics,
  runErasureCleanupOnce,
  runProfileWorkers,
  withIdentityLock,
  withIdentityLocks,
} from '@agentic-marketing/profiles';
import { assertNoProviderCalls, localKeyProvider, prepareKeys, recordingKeyProvider, withPreparedKeys } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { barrier, identityHolders, waitFor, waitForAdvisoryHolderBlocked, waitForIdentityWaiter } from './lockSupport';

// #978 part 3: the consent, identity and erasure lock protocol. These tests use the production
// entry points (the profile worker, the erasure stage and the consent helpers it calls), real
// PostgreSQL transactions and `pg_locks`; barriers decide when each transaction may continue, so
// no test depends on timing.

const MASTER_KEY = Buffer.alloc(32, 41).toString('base64');

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let kp: ReturnType<typeof localKeyProvider>;
let recorder: ReturnType<typeof recordingKeyProvider>;
let ws: string;
/** The profile worker's consumer, captured from the real `runProfileWorkers` wiring. */
let consume!: (events: BusEvent[]) => Promise<void>;
let clock = 0;

const at = () => new Date(Date.UTC(2026, 0, 1, 0, clock++)).toISOString();

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('lock_protocol');
  kp = localKeyProvider(MASTER_KEY);
  recorder = recordingKeyProvider(kp);
  ws = d.workspace;
  const bus = {
    consume(_opts: unknown, handler: (events: BusEvent[]) => Promise<void>) {
      consume ??= handler;
      // The worker loop runs until the signal aborts; a promise that never resolves is enough for
      // the tests, which call the captured handler directly.
      return new Promise<void>(() => {});
    },
  } as unknown as EventBus;
  runProfileWorkers({ bus, db: d.db, kp, after: [] }, new AbortController().signal);
}, 120_000);

afterAll(async () => {
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

async function seedProfile(id: string, idents: { anonymous?: string; user?: string; email?: string }, opts: { createdAt?: Date } = {}) {
  await d.db.withWorkspace(ws, async (tx) => {
    await tx.insert(schema.profiles).values({ workspaceId: ws, id, createdAt: opts.createdAt });
    const rows = [];
    if (idents.anonymous) rows.push({ workspaceId: ws, profileId: id, type: 'anonymous_id' as const, value: idents.anonymous });
    if (idents.user) rows.push({ workspaceId: ws, profileId: id, type: 'user_id' as const, value: idents.user });
    if (idents.email) rows.push({ workspaceId: ws, profileId: id, type: 'email' as const, value: idents.email });
    if (rows.length) await tx.insert(schema.identifiers).values(rows);
  });
}

async function seedMessage(profileId: string) {
  const id = newId('msg');
  await d.db.admin.query(
    `INSERT INTO messages (workspace_id, id, idempotency_key, channel, purpose, profile_id, status)
     VALUES ($1, $2, $3, 'email', 'marketing_email', $4, 'sent')`,
    [ws, id, `idem_${id}`, profileId],
  );
  return id;
}

/** One batch through the real profile worker: prepare, then the locked transaction. */
const runBatch = (events: BusEvent[]) => consume(events);

const consentOf = (profileId: string) =>
  d.db.withWorkspace(ws, async (tx) => (await consentStateOf(tx, ws, profileId)).filter((r) => r.purpose === 'marketing_email'));

/** The workspace's evidence rows, optionally only those of the given merged families. */
const ledger = async (...families: string[][]) => {
  const res = await d.db.admin.query<{ profile_id: string; status: string }>(
    'SELECT profile_id, status FROM consent_records WHERE workspace_id = $1 ORDER BY id',
    [ws],
  );
  if (!families.length) return res.rows;
  const allowed = new Set(families.flat());
  return res.rows.filter((r) => allowed.has(r.profile_id));
};

const familyOf = (profileId: string) => d.db.withWorkspace(ws, (tx) => mergedFamily(tx, ws, profileId));

describe.skipIf(!hasTestDatabase())('identity lock protocol (#978 part 3)', () => {
  it('serialises two consent writers: both evidence rows survive and the state is right', async () => {
    const profileId = newId('prf');
    await seedProfile(profileId, { anonymous: `anon-${profileId}` });

    // Writer A records a grant and then waits before committing, as a slow request would.
    const first = barrier(1);
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const a = d.db.withWorkspace(ws, (tx) =>
      withIdentityLock(tx, ws, async () => {
        await recordConsentEvidence(tx, ws, profileId, DEFAULT_PURPOSES, [
          { purpose: 'marketing_email', channel: '', status: 'granted', source: 'form', recordedAt: new Date(at()) },
        ]);
        await first();
        await firstMayFinish;
      }),
    );
    const probe = await d.db.admin.connect();
    let b: Promise<number> | undefined;
    try {
      await waitFor('writer A to hold the identity lock', async () => (await identityHolders(probe, ws)).length > 0);
      // Writer B starts while A holds the lock. Without the lock it would rebuild consent_state
      // from a ledger that cannot see A's uncommitted grant, and either lose the grant or fail the
      // unique insert; with it, B waits and reads both rows.
      b = d.db.withWorkspace(ws, (tx) =>
        withIdentityLock(tx, ws, () =>
          recordConsentEvidence(tx, ws, profileId, DEFAULT_PURPOSES, [
            { purpose: 'marketing_email', channel: '', status: 'withdrawn', source: 'unsubscribe', recordedAt: new Date(at()) },
          ]),
        ),
      );
      await waitForIdentityWaiter(probe, ws);
    } finally {
      releaseFirst();
    }
    await a;
    await b;
    probe.release();

    expect(await ledger()).toEqual([
      { profile_id: profileId, status: 'granted' },
      { profile_id: profileId, status: 'withdrawn' },
    ]);
    expect(await consentOf(profileId)).toMatchObject([{ status: 'withdrawn' }]);
  }, 60_000);

  it('a SDK consent batch that starts after a P→Q merge lands on Q', async () => {
    const q = newId('prf');
    const p = newId('prf');
    await seedProfile(q, { user: `user-${q}` }, { createdAt: new Date(Date.UTC(2026, 0, 1)) });
    await seedProfile(p, { anonymous: `anon-${p}` }, { createdAt: new Date(Date.UTC(2026, 0, 2)) });

    // The merge: an event naming P's anonymous id and Q's user id folds P into Q (oldest wins).
    await runBatch([event({ anonymousId: `anon-${p}`, userId: `user-${q}` })]);
    await runBatch([event({ anonymousId: `anon-${p}`, name: CONSENT_EVENT, consent: { marketing_email: true } })]);

    expect((await ledger(await familyOf(q))).map((r) => r.profile_id)).toEqual([q]);
    expect(await consentOf(q)).toMatchObject([{ status: 'granted' }]);
  }, 60_000);

  it('a SDK consent batch already in flight when a merge starts keeps its refusal and the merge reaches Q', async () => {
    const q = newId('prf');
    const p = newId('prf');
    await seedProfile(q, { user: `user-${q}` }, { createdAt: new Date(Date.UTC(2026, 0, 1)) });
    await seedProfile(p, { anonymous: `anon-${p}` }, { createdAt: new Date(Date.UTC(2026, 0, 2)) });

    // Pause the consent batch after it holds the identity lock but before it writes: the merge
    // then cannot run, and once released the consent commits first and the merge rebuilds Q from
    // the whole family, which includes the refusal written on P.
    const probe = await d.db.admin.connect();
    let merge: Promise<unknown> | undefined;
    try {
      await probe.query('BEGIN');
      await probe.query('SELECT 1 FROM profiles WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [ws, p]);
      const consent = runBatch([event({ anonymousId: `anon-${p}`, name: CONSENT_EVENT, consent: { marketing_email: false } })]);
      await waitForAdvisoryHolderBlocked(probe, ws);
      merge = runBatch([event({ anonymousId: `anon-${p}`, userId: `user-${q}` })]);
      await waitForIdentityWaiter(probe, ws);
      await probe.query('COMMIT');
      await consent;
    } finally {
      await probe.query('ROLLBACK').catch(() => {});
      probe.release();
    }
    await merge;

    const family = await familyOf(q);
    expect(family).toEqual(expect.arrayContaining([p, q]));
    // The SDK labels a negative action "denied" while the ledger has no grant; both are refusals
    // (ADR-0014), and the point here is that the refusal reaches the survivor.
    expect(await consentOf(q)).toMatchObject([{ status: 'denied' }]);
    expect((await ledger(family)).map((r) => r.status)).toEqual(['denied']);
  }, 60_000);

  it('takes the identity lock before the first UPDATE of a mixed batch and does not deadlock with a merge', async () => {
    const s = newId('prf');
    const t = newId('prf');
    await seedProfile(s, { anonymous: `anon-${s}` });
    await seedProfile(t, { user: `user-${t}` }, { createdAt: new Date(Date.UTC(2026, 0, 1)) });
    await d.db.admin.query('UPDATE profiles SET last_seen = $1 WHERE workspace_id = $2 AND id = $3', [
      new Date(Date.UTC(2025, 0, 1)),
      ws,
      s,
    ]);

    const probe = await d.db.admin.connect();
    let batch: Promise<unknown> | undefined;
    let merge: Promise<unknown> | undefined;
    try {
      await probe.query('BEGIN');
      await probe.query('SELECT 1 FROM profiles WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [ws, s]);
      // The first event is the fast path (`touch`): the batch must already hold the identity lock
      // when that UPDATE waits on this row lock.
      batch = runBatch([
        event({ anonymousId: `anon-${s}` }),
        event({ anonymousId: `anon-${s}`, name: CONSENT_EVENT, consent: { marketing_email: true } }),
      ]);
      await waitFor('the mixed batch to hold the lock and wait for the profile row', async () => {
        const holders = await identityHolders(probe, ws);
        if (!holders.length) return false;
        const { rows } = await probe.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity a
            WHERE a.wait_event_type = 'Lock' AND a.pid = ANY($1::int[])`,
          [holders],
        );
        return (rows[0]?.n ?? 0) > 0;
      });
      // A merge that starts now waits for the batch instead of interleaving with it.
      merge = runBatch([event({ anonymousId: `anon-${s}`, userId: `user-${t}` })]);
      await waitForIdentityWaiter(probe, ws);
      await probe.query('COMMIT');
      await batch;
    } finally {
      await probe.query('ROLLBACK').catch(() => {});
      probe.release();
    }
    await merge;

    // The consent committed before the merge: its row stays on S, and the survivor's rebuild
    // includes it, so T's effective consent is the grant.
    expect(await consentOf(t)).toMatchObject([{ status: 'granted' }]);
    expect((await ledger(await familyOf(t))).map((r) => r.profile_id)).toEqual([s]);
    expect(await consentOf(s)).toEqual([]);
  }, 60_000);

  it('takes every requested workspace lock and asserts per workspace', async () => {
    const second = `ws-${newUuid()}`;
    const third = `ws-${newUuid()}`;
    await d.db.withWorkspace(ws, (tx) =>
      withIdentityLocks(tx, [ws, second], async () => {
        const first = await identityHolders(d.db.admin, ws);
        const other = await identityHolders(d.db.admin, second);
        // A transaction that holds one workspace's lock is not considered to hold another's: both
        // keys are really taken (an old bug only locked the first sorted workspace).
        expect(first.length).toBeGreaterThan(0);
        expect(other.sort()).toEqual(first.sort());
        expect(identityLockHeld(tx, ws)).toBe(true);
        expect(identityLockHeld(tx, second)).toBe(true);
        expect(() => assertIdentityLock(tx, second, 'test')).not.toThrow();
        expect(() => assertIdentityLock(tx, third, 'test')).toThrow(/identity lock/);
        expect(await identityHolders(d.db.admin, third)).toEqual([]);
      }),
    );
  }, 60_000);

  it('makes a merge wait for an erasure that commits first, then erases the family', async () => {
    const p = newId('prf');
    const q = newId('prf');
    await seedProfile(q, { user: `user-${q}` }, { createdAt: new Date(Date.UTC(2026, 0, 1)) });
    await seedProfile(p, { anonymous: `anon-${p}` }, { createdAt: new Date(Date.UTC(2026, 0, 2)) });
    const messageId = await seedMessage(p);
    const prepared = await prepareErasure(d.db, ws, kp);
    const probe = await d.db.admin.connect();
    let erased: Promise<{ profileIds: string[] }> | undefined;
    let mergeBatch: Promise<unknown> | undefined;
    try {
      // The erasure takes the identity lock and stops at its first row delete.
      await probe.query('BEGIN');
      await probe.query('SELECT 1 FROM messages WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [ws, messageId]);
      erased = d.db.withWorkspace(ws, (tx) =>
        eraseProfileStage(tx, {
          workspaceId: ws,
          profileId: p,
          requestedBy: 'user_test',
          reason: 'erase racing merge',
          prepared,
        }),
      );
      await waitForAdvisoryHolderBlocked(probe, ws);
      mergeBatch = runBatch([event({ anonymousId: `anon-${p}`, userId: `user-${q}` })]);
      await waitForIdentityWaiter(probe, ws);
      await probe.query('COMMIT');
    } finally {
      await probe.query('ROLLBACK').catch(() => {});
      probe.release();
      try {
        if (erased) await erased;
      } finally {
        disposeErasure(prepared);
      }
    }
    await mergeBatch;
    const result = await erased!;
    expect(result.profileIds).toEqual([p]);
    const left = await d.db.admin.query('SELECT 1 FROM profiles WHERE workspace_id = $1 AND id = ANY($2)', [ws, [p, q]]);
    expect(left.rowCount).toBe(1); // Q survives; the erased person does not
  }, 60_000);

  it('erases the survivor family when a merge commits before the erasure starts', async () => {
    const p = newId('prf');
    const q = newId('prf');
    await seedProfile(q, { user: `user-${q}` }, { createdAt: new Date(Date.UTC(2026, 0, 1)) });
    await seedProfile(p, { anonymous: `anon-${p}` }, { createdAt: new Date(Date.UTC(2026, 0, 2)) });
    const prepared = await prepareErasure(d.db, ws, kp);
    const probe = await d.db.admin.connect();
    let mergeBatch: Promise<unknown> | undefined;
    let erased: Promise<{ profileIds: string[] }> | undefined;
    try {
      // The merge takes the identity lock and stops at the survivor's profile row.
      await probe.query('BEGIN');
      await probe.query('SELECT 1 FROM profiles WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [ws, q]);
      mergeBatch = runBatch([event({ anonymousId: `anon-${p}`, userId: `user-${q}` })]);
      await waitForAdvisoryHolderBlocked(probe, ws);
      erased = d.db.withWorkspace(ws, (tx) =>
        eraseProfileStage(tx, {
          workspaceId: ws,
          profileId: p,
          requestedBy: 'user_test',
          reason: 'erase after merge racing',
          prepared,
        }),
      );
      await waitForIdentityWaiter(probe, ws);
      await probe.query('COMMIT');
    } finally {
      await probe.query('ROLLBACK').catch(() => {});
      probe.release();
    }
    await mergeBatch;
    const result = await erased!;
    disposeErasure(prepared);
    expect(result.profileIds.sort()).toEqual([p, q].sort());
    const left = await d.db.admin.query('SELECT 1 FROM profiles WHERE workspace_id = $1 AND id = ANY($2)', [ws, [p, q]]);
    expect(left.rowCount).toBe(0);
  }, 60_000);

  it('lets another identify complete while the real erasure cleanup worker waits on ClickHouse', async () => {
    const erased = newId('prf');
    await seedProfile(erased, { anonymous: `anon-${erased}` });
    const prepared = await prepareErasure(d.db, ws, kp);
    let erasureId = '';
    try {
      erasureId = (
        await d.db.withWorkspace(ws, (tx) =>
          eraseProfileStage(tx, {
            workspaceId: ws,
            profileId: erased,
            requestedBy: 'user_test',
            reason: 'cleanup worker',
            prepared,
          }),
        )
      ).erasureId;
    } finally {
      disposeErasure(prepared);
    }

    // The staged erasure must have a publishable ledger row, or the worker would skip publication
    // and the first barrier below would never open.
    const ledger = await d.db.admin.query('SELECT 1 FROM erasure_keys WHERE workspace_id = $1 AND erasure_id = $2 AND coverage = $3', [
      ws,
      erasureId,
      'full',
    ]);
    expect(ledger.rowCount).toBeGreaterThan(0);

    // Two store barriers: publication (before any sweep) and the ClickHouse delete itself. Neither
    // may hold an identity lock, and both run on the real worker path.
    let publishEntered!: () => void;
    const inPublication = new Promise<void>((resolve) => {
      publishEntered = resolve;
    });
    let publishMayFinish!: () => void;
    const publicationMayFinish = new Promise<void>((resolve) => {
      publishMayFinish = resolve;
    });
    let deleteEntered!: () => void;
    const inDelete = new Promise<void>((resolve) => {
      deleteEntered = resolve;
    });
    let deleteMayFinish!: () => void;
    const deleteMayResolve = new Promise<void>((resolve) => {
      deleteMayFinish = resolve;
    });
    const eventStore = {
      async publishErasedSubjects() {
        publishEntered();
        await publicationMayFinish;
      },
      async erasedSubjectsVisible() {
        return true;
      },
      // This workspace has no uncovered historical rows, so the completion gate (#1037 part 3)
      // clears on the final round; the lock assertions are about publication and the delete.
      async subjectKeyCoverage() {
        return { pending: 0, tables: [] };
      },
      async deleteEventsOf() {
        deleteEntered();
        await deleteMayResolve;
      },
    } as unknown as EventStore;
    const hot = { async tombstone() {}, async deleteSnapshot() {} } as unknown as HotState;
    // The real scheduler path: claim the committed job and block inside publication first.
    // The interval is zero here so the test can drive the distinct final pass immediately.
    const worker = runErasureCleanupOnce({ db: d.db, kp, events: eventStore, hot }, { finalSweepMs: 0 });
    await inPublication;

    // Another identify completes while the erasure's publication is in flight: publication is
    // ClickHouse I/O and holds no identity lock.
    const duringPublication = `anon-${newId('prf')}`;
    await runBatch([event({ anonymousId: duringPublication })]);
    expect(
      (
        await d.db.admin.query(
          `SELECT p.id FROM profiles p JOIN identifiers i ON i.profile_id = p.id AND i.workspace_id = p.workspace_id
            WHERE p.workspace_id = $1 AND i.type = 'anonymous_id' AND i.value = $2`,
          [ws, duringPublication],
        )
      ).rowCount,
    ).toBe(1);
    publishMayFinish();
    await inDelete;

    // And another one completes while the sweep waits on ClickHouse — the original assertion.
    const fresh = `anon-${newId('prf')}`;
    await runBatch([event({ anonymousId: fresh })]);
    const created = await d.db.admin.query(
      `SELECT p.id FROM profiles p JOIN identifiers i ON i.profile_id = p.id AND i.workspace_id = p.workspace_id
        WHERE p.workspace_id = $1 AND i.type = 'anonymous_id' AND i.value = $2`,
      [ws, fresh],
    );
    expect(created.rowCount).toBe(1);

    deleteMayFinish();
    const first = await worker;
    expect(first.claimed).toBeGreaterThanOrEqual(1);
    // The first successful sweep is the checkpoint; the distinct final pass completes the job.
    await d.db.admin.query('UPDATE erasure_cleanup_jobs SET next_attempt_at = now() WHERE workspace_id = $1 AND erasure_id = $2', [
      ws,
      erasureId,
    ]);
    const result = await runErasureCleanupOnce({ db: d.db, kp, events: eventStore, hot }, { finalSweepMs: 0 });
    expect(result.completed).toBeGreaterThanOrEqual(1);
    const job = await d.db.admin.query<{ state: string; published_at: Date | null }>(
      'SELECT state, published_at FROM erasure_cleanup_jobs WHERE workspace_id = $1 AND erasure_id = $2',
      [ws, erasureId],
    );
    expect(job.rows[0]?.state).toBe('complete');
    expect(job.rows[0]?.published_at).toBeInstanceOf(Date);
  }, 60_000);

  it('rolls back and re-prepares when the matching key changes between preparation and the lock', async () => {
    const profileId = newId('prf');
    await seedProfile(profileId, { anonymous: `anon-${profileId}` });
    let preparations = 0;
    recorder.reset();
    const batch = [event({ anonymousId: `anon-${profileId}`, piiTraits: { email: 'rotated@example.com' } })];
    const result = await withPreparedKeys(
      async () => {
        const profileIds = await d.db.withWorkspace(ws, (tx) => profileIdsForBatch(tx, ws, batch, personCrypto(tx, ws, kp)));
        const prepared = await prepareKeys(d.db, ws, recorder, { profileIds });
        preparations++;
        if (preparations === 1) {
          // A rotation between prepare and the locked transaction: the protected block must fail
          // with KeysChangedError, roll back, and the retry must prepare the new key.
          const wrapped = await kp.wrap(Buffer.alloc(32, 77));
          await d.db.admin.query("UPDATE data_keys SET active = false WHERE workspace_id = $1 AND purpose = 'matching' AND active", [ws]);
          await d.db.admin.query(
            `INSERT INTO data_keys (workspace_id, id, kek_id, wrapped_key, purpose, active)
             VALUES ($1, $2, $3, $4, 'matching', true)`,
            [ws, newId('dk'), kp.id, wrapped],
          );
        }
        return prepared;
      },
      (prepared) => {
        // Count only the protected block's provider calls: preparation legitimately unwraps.
        recorder.reset();
        return assertNoProviderCalls(recorder, () =>
          d.db.withWorkspace(ws, (tx) => applyEvents(tx, ws, batch, { prepared, purposes: async () => DEFAULT_PURPOSES })),
        );
      },
      { attempts: 2 },
    );
    expect(preparations).toBe(2);
    expect(result).toHaveLength(1);
    // The protected transaction used only the prepared provider (assertNoProviderCalls would have
    // thrown otherwise); nothing reached the recorder during it.
    expect(recorder.calls).toHaveLength(0);
  }, 60_000);

  it('refuses a consent helper call from a transaction that does not hold the lock', async () => {
    const profileId = newId('prf');
    await seedProfile(profileId, { anonymous: `anon-${profileId}` });
    await expect(
      d.db.withWorkspace(ws, (tx) =>
        recordConsentEvidence(tx, ws, profileId, DEFAULT_PURPOSES, [
          { purpose: 'marketing_email', channel: '', status: 'granted', source: 'form', recordedAt: new Date() },
        ]),
      ),
    ).rejects.toThrow(/identity lock/i);
  });

  it('refuses a bounded identity-lock wait and records the refusal (#1074)', async () => {
    resetIdentityLockMetrics();
    const probe = await d.db.admin.connect();
    const waitMs = 100;
    try {
      await probe.query('BEGIN');
      await probe.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`identity:${ws}`]);
      const started = Date.now();
      await expect(d.db.withWorkspace(ws, (tx) => withIdentityLock(tx, ws, async () => undefined, { waitMs }))).rejects.toBeInstanceOf(
        IdentityLockTimeoutError,
      );
      // The bound is the configured timeout plus slack, never a wall-clock constant.
      expect(Date.now() - started).toBeLessThan(waitMs + 2_000);
      const snapshot = identityLockSnapshot();
      expect(snapshot.timeouts).toBe(1);
      // A shed wait is still observed, so the histogram does not hide refusals.
      expect(snapshot.wait.count).toBe(1);
    } finally {
      await probe.query('ROLLBACK').catch(() => {});
      probe.release();
    }

    // Once the holder is gone the same bounded call succeeds.
    await expect(d.db.withWorkspace(ws, (tx) => withIdentityLock(tx, ws, async () => undefined, { waitMs }))).resolves.toBeUndefined();
  }, 60_000);

  it('reports wait and hold timings without a workspace in the labels', async () => {
    resetIdentityLockMetrics();
    const profileId = newId('prf');
    await seedProfile(profileId, { anonymous: `anon-${profileId}` });
    await runBatch([event({ anonymousId: `anon-${profileId}`, traits: { plan: 'team' } })]);
    const snapshot = identityLockSnapshot();
    expect(snapshot.acquisitions).toBeGreaterThan(0);
    expect(snapshot.hold.count).toBeGreaterThan(0);
    expect(snapshot.hold.buckets).toHaveLength(snapshot.buckets.length);
    expect(JSON.stringify(snapshot)).not.toContain(ws);
  });
});
