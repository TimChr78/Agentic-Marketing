import { createExecutor, userPrincipal } from '@agentic-marketing/commands';
import { claimErasureCleanupJobs } from '@agentic-marketing/db';
import type { BusEvent, EventStore } from '@agentic-marketing/events';
import type { HotState } from '@agentic-marketing/hotstate';
import { assertNoProviderCalls, localKeyProvider, recordingKeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { eraseProfile, erasureStatus } from '../src/commands';
import { dropErasedProfileRows, erasedEventFilter } from '../src/erasedEvents';
import { disposeErasure, eraseProfileStage, prepareErasure } from '../src/erasure';
import { runErasureCleanupOnce } from '../src/erasureCleanup';

// #978 part 2b: an erasure is one SQL transaction with no network I/O, then a durable job cleans
// the external stores. These tests use production entry points (the command executor, the stage
// and the worker) and move due times themselves, so nothing waits on a clock.

const MASTER_KEY = Buffer.alloc(32, 23).toString('base64');

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let recorder: ReturnType<typeof recordingKeyProvider>;
let keyProvider: ReturnType<typeof localKeyProvider>;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('durable_erasure');
  keyProvider = localKeyProvider(MASTER_KEY);
  recorder = recordingKeyProvider(keyProvider);
}, 120_000);

afterAll(async () => {
  await d?.close();
});

afterEach(async () => {
  if (d) await d.db.admin.query('DELETE FROM erasure_cleanup_jobs WHERE workspace_id = $1', [d.workspace]);
});

async function seedPerson(profileId: string, opts: { mergedFrom?: string[] } = {}) {
  await d.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [d.workspace, profileId]);
  for (const merged of opts.mergedFrom ?? []) {
    await d.db.admin.query('INSERT INTO profiles (workspace_id, id, merged_into) VALUES ($1, $2, $3)', [d.workspace, merged, profileId]);
    await d.db.admin.query("INSERT INTO profile_merges (workspace_id, from_id, into_id, reason) VALUES ($1, $2, $3, 'merge test')", [
      d.workspace,
      merged,
      profileId,
    ]);
    await d.db.admin.query('INSERT INTO identifiers (workspace_id, profile_id, type, value) VALUES ($1, $2, $3, $4)', [
      d.workspace,
      merged,
      'user_id',
      `${merged}-user`,
    ]);
  }
  await d.db.admin.query('INSERT INTO identifiers (workspace_id, profile_id, type, value) VALUES ($1, $2, $3, $4)', [
    d.workspace,
    profileId,
    'user_id',
    `${profileId}-user`,
  ]);
  await d.db.admin.query('INSERT INTO identifiers (workspace_id, profile_id, type, value) VALUES ($1, $2, $3, $4)', [
    d.workspace,
    profileId,
    'anonymous_id',
    `${profileId}-anon`,
  ]);
  await d.db.admin.query(
    `INSERT INTO consent_records (workspace_id, profile_id, purpose, channel, status, basis, source)
     VALUES ($1, $2, 'marketing_email', 'email', 'granted', 'consent', 'api')`,
    [d.workspace, profileId],
  );
}

const fakeEvents = () => {
  const calls: { workspaceId: string; anonymousIds: string[]; userIds: string[]; profileIds?: string[] }[] = [];
  const published: { workspaceId: string; kind: string; key: string; generation: number }[] = [];
  const events = {
    async deleteEventsOf(workspaceId: string, ids: { anonymousIds: string[]; userIds: string[]; profileIds?: string[] }) {
      calls.push({ workspaceId, ...ids });
    },
    // Publication (#1037 part 2) now runs before every sweep; the fake records it so a test can
    // still assert what the sweep itself did.
    async publishErasedSubjects(rows: { workspaceId: string; kind: string; key: string; generation: number }[]) {
      published.push(...rows);
    },
    async erasedSubjectsVisible() {
      return true;
    },
    // The completion gate (#1037 part 3) asks for the workspace's uncovered count; these tests run
    // against a workspace with no ClickHouse rows.
    async subjectKeyCoverage() {
      return { pending: 0, tables: [] };
    },
  } as unknown as EventStore;
  return { events, calls, published };
};

const fakeHot = () => {
  const calls: { workspaceId: string; anonymousIds: string[]; userIds: string[] }[] = [];
  const hot = {
    async deleteSnapshot(workspaceId: string, ids: { anonymousIds: string[]; userIds: string[] }) {
      calls.push({ workspaceId, ...ids });
    },
  } as unknown as HotState;
  return { hot, calls };
};

const services = (events: EventStore, hot: HotState) =>
  ({
    serverVersion: 'test',
    strictInputs: true,
    keyProvider: recorder,
    events,
    hot,
    // The command never touches the bus; review commands only require a service value.
    bus: {},
  }) as unknown as Parameters<typeof createExecutor>[1];

const job = async (erasureId: string) => {
  const { rows } = await d.db.admin.query<{
    state: string;
    attempts: number;
    clickhouse_done: boolean;
    hotstate_done: boolean;
    final_sweep_at: Date | null;
    first_sweep_done_at: Date | null;
    selectors: Buffer | null;
    selector_key: Buffer | null;
    selector_kek: string | null;
    profile_ids: string[];
    last_error: string | null;
  }>('SELECT * FROM erasure_cleanup_jobs WHERE workspace_id = $1 AND erasure_id = $2', [d.workspace, erasureId]);
  return rows[0] ?? null;
};

/** Makes every job of this workspace due now, so a test never waits on the retry schedule. */
const makeDue = () => d.db.admin.query('UPDATE erasure_cleanup_jobs SET next_attempt_at = now() WHERE workspace_id = $1', [d.workspace]);

describe.skipIf(!hasTestDatabase())('durable two-stage erasure (#978 part 2b)', () => {
  it('removes the whole merged family in one stage and writes the job in the same transaction', async () => {
    const survivor = 'prf_0000000000000000000000000000a001';
    const merged = 'prf_0000000000000000000000000000a002';
    await seedPerson(survivor, { mergedFrom: [merged] });
    const prepared = await prepareErasure(d.db, d.workspace, keyProvider);
    try {
      const result = await d.db.withWorkspace(d.workspace, (tx) =>
        eraseProfileStage(tx, {
          workspaceId: d.workspace,
          profileId: merged,
          requestedBy: 'user_test',
          reason: 'stage test',
          prepared,
        }),
      );
      expect(result.status).toBe('pending');
      expect(result.counts).toEqual({ profiles: 2, identifiers: 3, consentRecords: 1 });
      expect(result.profileIds.sort()).toEqual([survivor, merged].sort());
      const left = await d.db.admin.query('SELECT 1 FROM profiles WHERE workspace_id = $1 AND id = ANY($2)', [
        d.workspace,
        [survivor, merged],
      ]);
      expect(left.rowCount).toBe(0);
      expect(await job(result.erasureId)).toMatchObject({
        state: 'pending_external',
        profile_ids: result.profileIds,
        clickhouse_done: false,
        hotstate_done: false,
      });
      // The job carries sealed selectors and only a wrapped service key.
      const stored = (await job(result.erasureId))!;
      expect(stored.selectors).not.toBeNull();
      expect(stored.selector_key).not.toBeNull();
      expect(stored.selector_kek).toBe(keyProvider.id);
      expect(stored.selectors?.toString('utf8')).not.toContain('prf_0000000000000000000000000000a001');
      // The suppression list keeps the hashes, never a raw e-mail or phone.
      const suppressions = await d.db.admin.query<{ value_hash: string; reason: string }>(
        'SELECT value_hash, reason FROM suppressions WHERE workspace_id = $1',
        [d.workspace],
      );
      expect(suppressions.rows.every((r) => r.reason === 'erased')).toBe(true);
    } finally {
      disposeErasure(prepared);
    }
  });

  it('removes the journey event markers of the family, whose event ids can name the person', async () => {
    const survivor = 'prf_0000000000000000000000000000a201';
    const merged = 'prf_0000000000000000000000000000a202';
    await seedPerson(survivor, { mergedFrom: [merged] });
    // Event ids are caller-supplied and can carry an address, so they are personal data too; a
    // marker can sit on the merged-away id from before the merge.
    await d.db.admin.query(
      `INSERT INTO journey_processed_events (workspace_id, profile_id, event_id) VALUES
         ($1, $2, 'customer@example.test:purchase-1'),
         ($1, $3, 'customer@example.test:purchase-2')`,
      [d.workspace, survivor, merged],
    );
    const prepared = await prepareErasure(d.db, d.workspace, keyProvider);
    try {
      await d.db.withWorkspace(d.workspace, (tx) =>
        eraseProfileStage(tx, {
          workspaceId: d.workspace,
          profileId: merged,
          requestedBy: 'user_test',
          reason: 'marker erasure test',
          prepared,
        }),
      );
    } finally {
      disposeErasure(prepared);
    }
    const left = await d.db.admin.query('SELECT event_id FROM journey_processed_events WHERE workspace_id = $1', [d.workspace]);
    expect(left.rowCount).toBe(0);
  });

  it('rolls the whole SQL stage back: no profile, erasure, tombstone or job survives', async () => {
    const profile = 'prf_0000000000000000000000000000b001';
    await seedPerson(profile);
    await d.db.admin.query('DELETE FROM erasure_tombstones WHERE workspace_id = $1', [d.workspace]);
    const prepared = await prepareErasure(d.db, d.workspace, keyProvider);
    try {
      await expect(
        d.db.withWorkspace(d.workspace, async (tx) => {
          await eraseProfileStage(tx, {
            workspaceId: d.workspace,
            profileId: profile,
            requestedBy: 'user_test',
            reason: 'rollback test',
            prepared,
          });
          throw new Error('crash before commit');
        }),
      ).rejects.toThrow('crash before commit');
    } finally {
      disposeErasure(prepared);
    }
    const counts = await d.db.admin.query<{ profiles: number; erasures: number; tombstones: number; jobs: number }>(
      `SELECT
         (SELECT count(*)::int FROM profiles WHERE workspace_id = $1 AND id = $2) AS profiles,
         (SELECT count(*)::int FROM erasures WHERE workspace_id = $1 AND profile_ids @> ARRAY[$2]::text[]) AS erasures,
         (SELECT count(*)::int FROM erasure_tombstones WHERE workspace_id = $1) AS tombstones,
         (SELECT count(*)::int FROM erasure_cleanup_jobs WHERE workspace_id = $1 AND profile_ids @> ARRAY[$2]::text[]) AS jobs`,
      [d.workspace, profile],
    );
    expect(counts.rows[0]).toEqual({ profiles: 1, erasures: 0, tombstones: 0, jobs: 0 });
  });

  it('makes no key-provider call inside the SQL stage', async () => {
    const profile = 'prf_0000000000000000000000000000c001';
    await seedPerson(profile);
    const prepared = await prepareErasure(d.db, d.workspace, recorder);
    recorder.reset();
    try {
      await assertNoProviderCalls(recorder, () =>
        d.db.withWorkspace(d.workspace, (tx) =>
          eraseProfileStage(tx, {
            workspaceId: d.workspace,
            profileId: profile,
            requestedBy: 'user_test',
            reason: 'no provider calls',
            prepared,
          }),
        ),
      );
      expect(recorder.calls).toHaveLength(0);
    } finally {
      disposeErasure(prepared);
    }
  });

  it('returns pending, then the durable worker completes it and the status reads complete', async () => {
    const profile = 'prf_0000000000000000000000000000d001';
    await seedPerson(profile);
    const { events, calls: eventCalls } = fakeEvents();
    const { hot, calls: hotCalls } = fakeHot();
    const executor = createExecutor(d.db, services(events, hot));
    const principal = userPrincipal('user_test', d.workspace, 'owner');

    const erased = await executor.execute(eraseProfile, { profileId: profile, reason: 'command test' }, principal, { surface: 'rest' });
    expect(erased).toMatchObject({ status: 'pending', counts: { profiles: 1, identifiers: 2, consentRecords: 1 } });
    const pending = await executor.execute(erasureStatus, { erasureId: erased.erasureId }, principal, { surface: 'rest' });
    expect(pending).toMatchObject({ status: 'pending', checkpoints: { clickhouse: false, hotState: false }, attempts: 0 });

    const first = await runErasureCleanupOnce({ db: d.db, kp: keyProvider, events, hot }, { finalSweepMs: 0 });
    // The first successful sweep records its checkpoint and defers; a distinct final pass completes.
    expect(first).toMatchObject({ claimed: 1, deferred: 1, completed: 0 });
    await makeDue();
    const result = await runErasureCleanupOnce({ db: d.db, kp: keyProvider, events, hot }, { finalSweepMs: 0 });
    expect(result).toMatchObject({ claimed: 1, completed: 1 });
    expect(eventCalls).toHaveLength(2);
    expect(eventCalls[0]).toEqual({
      workspaceId: d.workspace,
      anonymousIds: [`${profile}-anon`],
      userIds: [`${profile}-user`],
      profileIds: [profile],
    });
    expect(hotCalls).toHaveLength(2);
    expect(hotCalls[0]).toEqual({ workspaceId: d.workspace, anonymousIds: [`${profile}-anon`], userIds: [`${profile}-user`] });

    const complete = await executor.execute(erasureStatus, { erasureId: erased.erasureId }, principal, { surface: 'rest' });
    expect(complete).toMatchObject({ status: 'complete', checkpoints: { clickhouse: true, hotState: true } });
    expect(complete.completedAt).not.toBeNull();
    // The sealed selectors and the service key are purged when the job completes.
    const stored = (await job(erased.erasureId))!;
    expect(stored.selectors).toBeNull();
    expect(stored.selector_key).toBeNull();
  });

  it('treats an erasure recorded before durable cleanup as complete', async () => {
    const old = 'era_00000000000000000000000000000001';
    await d.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, $2, ARRAY['prf_0000000000000000000000000000aa01']::text[], 'user_test', 'legacy erasure', '{"profiles":1}')`,
      [d.workspace, old],
    );
    const { events } = fakeEvents();
    const { hot } = fakeHot();
    const executor = createExecutor(d.db, services(events, hot));
    const status = await executor.execute(erasureStatus, { erasureId: old }, userPrincipal('user_test', d.workspace, 'owner'), {
      surface: 'rest',
    });
    expect(status).toMatchObject({ status: 'complete', attempts: 0, checkpoints: { clickhouse: true, hotState: true } });
  });

  it('resumes a job another worker committed but never ran', async () => {
    const profile = 'prf_0000000000000000000000000000e001';
    await seedPerson(profile);
    const prepared = await prepareErasure(d.db, d.workspace, keyProvider);
    let erasedId = '';
    try {
      erasedId = (
        await d.db.withWorkspace(d.workspace, (tx) =>
          eraseProfileStage(tx, {
            workspaceId: d.workspace,
            profileId: profile,
            requestedBy: 'user_test',
            reason: 'resume test',
            prepared,
          }),
        )
      ).erasureId;
    } finally {
      disposeErasure(prepared);
    }
    // Nothing ran in that process; a later worker claims the committed job, records the first
    // successful sweep and waits for the distinct final pass.
    const { events, calls } = fakeEvents();
    const { hot } = fakeHot();
    const first = await runErasureCleanupOnce({ db: d.db, kp: keyProvider, events, hot }, { finalSweepMs: 0 });
    expect(first).toMatchObject({ claimed: 1, deferred: 1, completed: 0 });
    expect(calls).toHaveLength(1);
    await makeDue();
    const second = await runErasureCleanupOnce({ db: d.db, kp: keyProvider, events, hot }, { finalSweepMs: 0 });
    expect(second).toMatchObject({ claimed: 1, completed: 1 });
    expect(calls).toHaveLength(2);
    expect((await job(erasedId))?.state).toBe('complete');
  });

  it('waits for an in-flight outbox publisher, then sweeps and leaves nothing behind', async () => {
    const profile = 'prf_0000000000000000000000000000f001';
    await seedPerson(profile);
    const prepared = await prepareErasure(d.db, d.workspace, keyProvider);
    let erasedId = '';
    try {
      erasedId = (
        await d.db.withWorkspace(d.workspace, (tx) =>
          eraseProfileStage(tx, {
            workspaceId: d.workspace,
            profileId: profile,
            requestedBy: 'user_test',
            reason: 'barrier test',
            prepared,
          }),
        )
      ).erasureId;
    } finally {
      disposeErasure(prepared);
    }
    await d.db.admin.query(
      `INSERT INTO outbox (workspace_id, id, kind, payload, operation_key, state)
       VALUES ($1, 'obx_erasure_inflight', 'message_event', $2, 'erasure-inflight', 'delivering')`,
      [d.workspace, JSON.stringify({ events: [{ profileId: profile }] })],
    );
    const { events, calls } = fakeEvents();
    const { hot } = fakeHot();
    const first = await runErasureCleanupOnce({ db: d.db, kp: keyProvider, events, hot }, { finalSweepMs: 0, outboxWaitSeconds: 0 });
    expect(first).toMatchObject({ claimed: 1, deferred: 1, completed: 0 });
    expect(calls).toHaveLength(0);
    expect((await job(erasedId))?.state).toBe('pending_external');

    // The publisher commits its event. The next claim makes the first successful sweep and records
    // its checkpoint, but it must not complete: no final pass has run yet.
    await d.db.admin.query("UPDATE outbox SET state = 'delivered' WHERE operation_key = 'erasure-inflight'");
    await makeDue();
    const second = await runErasureCleanupOnce({ db: d.db, kp: keyProvider, events, hot }, { finalSweepMs: 0, outboxWaitSeconds: 0 });
    expect(second).toMatchObject({ claimed: 1, deferred: 1, completed: 0 });
    expect(calls).toHaveLength(1);
    expect(await job(erasedId)).toMatchObject({
      state: 'pending_external',
      clickhouse_done: true,
      first_sweep_done_at: expect.any(Date),
    });

    // The distinct final pass, at least the sweep interval later, completes it.
    await makeDue();
    const third = await runErasureCleanupOnce({ db: d.db, kp: keyProvider, events, hot }, { finalSweepMs: 0, outboxWaitSeconds: 0 });
    expect(third).toMatchObject({ claimed: 1, completed: 1 });
    expect(calls).toHaveLength(2);
    expect((await job(erasedId))?.state).toBe('complete');
  });

  it('sweeps twice: the first pass deletes now, the final pass after the bound completes', async () => {
    const profile = 'prf_0000000000000000000000000000f101';
    await seedPerson(profile);
    const prepared = await prepareErasure(d.db, d.workspace, keyProvider);
    let erasedId = '';
    try {
      erasedId = (
        await d.db.withWorkspace(d.workspace, (tx) =>
          eraseProfileStage(tx, {
            workspaceId: d.workspace,
            profileId: profile,
            requestedBy: 'user_test',
            reason: 'two-phase sweep test',
            prepared,
          }),
        )
      ).erasureId;
    } finally {
      disposeErasure(prepared);
    }
    const { events, calls } = fakeEvents();
    const { hot } = fakeHot();
    const first = await runErasureCleanupOnce({ db: d.db, kp: keyProvider, events, hot }, { finalSweepMs: 60_000, outboxWaitSeconds: 0 });
    // The first pass removes what is in the store now, then the job waits for the final bound
    // without spending an attempt.
    expect(first).toMatchObject({ claimed: 1, deferred: 1, completed: 0 });
    expect(calls).toHaveLength(1);
    expect(await job(erasedId)).toMatchObject({
      state: 'pending_external',
      attempts: 0,
      clickhouse_done: true,
      hotstate_done: true,
      // The first claim, which is necessarily after the erasure committed, anchored the final sweep.
      final_sweep_at: expect.any(Date),
      // The successful first pass is the checkpoint the final pass must follow.
      first_sweep_done_at: expect.any(Date),
    });

    // A write that started before the erasure can land after the first pass. The final pass runs
    // even though the checkpoint is set, which is what makes `complete` truthful.
    await d.db.admin.query('UPDATE erasure_cleanup_jobs SET next_attempt_at = now() WHERE workspace_id = $1 AND erasure_id = $2', [
      d.workspace,
      erasedId,
    ]);
    const second = await runErasureCleanupOnce({ db: d.db, kp: keyProvider, events, hot }, { finalSweepMs: 0, outboxWaitSeconds: 0 });
    expect(second).toMatchObject({ claimed: 1, completed: 1 });
    expect(calls).toHaveLength(2);
    expect((await job(erasedId))?.state).toBe('complete');
  });

  it('does not complete on the first successful delete after an earlier failure', async () => {
    const profile = 'prf_0000000000000000000000000000f301';
    await seedPerson(profile);
    const prepared = await prepareErasure(d.db, d.workspace, keyProvider);
    let erasedId = '';
    try {
      erasedId = (
        await d.db.withWorkspace(d.workspace, (tx) =>
          eraseProfileStage(tx, {
            workspaceId: d.workspace,
            profileId: profile,
            requestedBy: 'user_test',
            reason: 'failed first sweep test',
            prepared,
          }),
        )
      ).erasureId;
    } finally {
      disposeErasure(prepared);
    }
    let attempts = 0;
    const events = {
      async deleteEventsOf() {
        attempts += 1;
        if (attempts === 1) throw new Error('the first delete failed');
      },
      async publishErasedSubjects() {},
      async erasedSubjectsVisible() {
        return true;
      },
      async subjectKeyCoverage() {
        return { pending: 0, tables: [] };
      },
    } as unknown as EventStore;
    const { hot } = fakeHot();

    const first = await runErasureCleanupOnce({ db: d.db, kp: keyProvider, events, hot }, { finalSweepMs: 0 });
    expect(first).toMatchObject({ claimed: 1, retried: 1, completed: 0 });
    expect(attempts).toBe(1);
    expect(await job(erasedId)).toMatchObject({ state: 'pending_external', first_sweep_done_at: null });

    // The next delete succeeds, but it is the first successful pass: it checkpoints and defers,
    // rather than completing on one sweep after a failure (#1037 review).
    await makeDue();
    const second = await runErasureCleanupOnce({ db: d.db, kp: keyProvider, events, hot }, { finalSweepMs: 0 });
    expect(second).toMatchObject({ claimed: 1, deferred: 1, completed: 0 });
    expect(attempts).toBe(2);
    expect(await job(erasedId)).toMatchObject({ state: 'pending_external', first_sweep_done_at: expect.any(Date) });

    await makeDue();
    const third = await runErasureCleanupOnce({ db: d.db, kp: keyProvider, events, hot }, { finalSweepMs: 0 });
    expect(third).toMatchObject({ claimed: 1, completed: 1 });
    expect(attempts).toBe(3);
    expect((await job(erasedId))?.state).toBe('complete');
  });

  it('never stores an event that names an erased person inside the grace window', async () => {
    const profile = 'prf_0000000000000000000000000000f201';
    await seedPerson(profile);
    const prepared = await prepareErasure(d.db, d.workspace, keyProvider);
    try {
      await d.db.withWorkspace(d.workspace, (tx) =>
        eraseProfileStage(tx, {
          workspaceId: d.workspace,
          profileId: profile,
          requestedBy: 'user_test',
          reason: 'sink filter test',
          prepared,
        }),
      );
    } finally {
      disposeErasure(prepared);
    }
    const event = (anonymousId: string, timestamp: string, over: Partial<BusEvent> = {}): BusEvent => ({
      workspaceId: d.workspace,
      sourceId: 'src_test',
      messageId: `m-${anonymousId}-${timestamp}`,
      type: 'track' as const,
      name: 'Page Viewed',
      anonymousId,
      userId: '',
      timestamp,
      receivedAt: timestamp,
      properties: {},
      traits: {},
      piiTraits: {},
      context: {},
      consent: {},
      ...over,
    });
    // A live person on the same device id as the erased person: the resolver accepts the event
    // because the user id belongs to a live profile, so the sink must not drop it (#1037 B1).
    const live = 'prf_0000000000000000000000000000f202';
    await seedPerson(live);
    const before = new Date(Date.now() - 60_000).toISOString();
    const afterGrace = new Date(Date.now() + 48 * 3_600_000).toISOString();
    const person = event(`${profile}-anon`, before);
    const late = event(`${profile}-anon`, afterGrace);
    const other = event('someone-else', before);
    const livePerson = event(`${profile}-anon`, before, { userId: `${live}-user` });
    const unknownUser = event(`${profile}-anon`, before, { userId: 'u-unknown' });
    const filter = erasedEventFilter({ db: d.db, kp: keyProvider });
    expect(await filter([person, late, other, livePerson, unknownUser])).toEqual([late, other, livePerson]);
  });

  it('drops an alias whose erased previous anonymous id has no live identity', async () => {
    const erasedProfile = 'prf_0000000000000000000000000000f203';
    const liveProfile = 'prf_0000000000000000000000000000f204';
    await seedPerson(erasedProfile);
    await seedPerson(liveProfile);
    const prepared = await prepareErasure(d.db, d.workspace, keyProvider);
    try {
      await d.db.withWorkspace(d.workspace, (tx) =>
        eraseProfileStage(tx, {
          workspaceId: d.workspace,
          profileId: erasedProfile,
          requestedBy: 'user_test',
          reason: 'alias filter test',
          prepared,
        }),
      );
    } finally {
      disposeErasure(prepared);
    }
    const base = (previousId: string): BusEvent => ({
      workspaceId: d.workspace,
      sourceId: 'src_test',
      messageId: `alias-${previousId}`,
      type: 'alias',
      name: 'alias',
      anonymousId: 'new-device',
      userId: 'new-user',
      previousId,
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      receivedAt: new Date().toISOString(),
      properties: {},
      traits: {},
      piiTraits: {},
      context: {},
      consent: {},
    });
    const filter = erasedEventFilter({ db: d.db, kp: keyProvider });
    const erasedAlias = base(`${erasedProfile}-anon`);
    const liveAlias = base(`${liveProfile}-anon`);
    // The resolver expands an unknown previous id to `anonymous_id` and applies the tombstone; a
    // previous id that still has an anonymous/user identifier row belongs to the live profile.
    expect(await filter([erasedAlias, liveAlias])).toEqual([liveAlias]);
  });

  it('handles a full 10,000-event sink batch without a parameter or stack limit', async () => {
    const profile = 'prf_0000000000000000000000000000f205';
    await seedPerson(profile);
    const prepared = await prepareErasure(d.db, d.workspace, keyProvider);
    try {
      await d.db.withWorkspace(d.workspace, (tx) =>
        eraseProfileStage(tx, {
          workspaceId: d.workspace,
          profileId: profile,
          requestedBy: 'user_test',
          reason: 'bulk filter test',
          prepared,
        }),
      );
    } finally {
      disposeErasure(prepared);
    }
    const timestamp = new Date(Date.now() - 60_000).toISOString();
    const events: BusEvent[] = Array.from({ length: 10_000 }, (_, index) => ({
      workspaceId: d.workspace,
      sourceId: 'src_test',
      messageId: `bulk-${index}`,
      type: 'track',
      name: 'Page Viewed',
      anonymousId: `bulk-anon-${index}`,
      userId: `bulk-user-${index}`,
      timestamp,
      receivedAt: timestamp,
      properties: {},
      traits: {},
      piiTraits: { email: `bulk-${index}@example.com`, phone: `+1555${index}` },
      context: {},
      consent: {},
    }));
    const filter = erasedEventFilter({ db: d.db, kp: keyProvider });
    // 10,000 events × four identifiers is the sink's supported maximum; the per-pair query list
    // used to hit PostgreSQL's parameter and stack limits here.
    expect(await filter(events)).toHaveLength(10_000);
  }, 120_000);

  it('drops only rows whose profile has an erasure record, never missing or profile-less rows', async () => {
    const erasedProfile = 'prf_0000000000000000000000000000f206';
    const liveProfile = 'prf_0000000000000000000000000000f207';
    await seedPerson(erasedProfile);
    await seedPerson(liveProfile);
    const prepared = await prepareErasure(d.db, d.workspace, keyProvider);
    try {
      await d.db.withWorkspace(d.workspace, (tx) =>
        eraseProfileStage(tx, {
          workspaceId: d.workspace,
          profileId: erasedProfile,
          requestedBy: 'user_test',
          reason: 'direct writer guard test',
          prepared,
        }),
      );
    } finally {
      disposeErasure(prepared);
    }
    const kept = await dropErasedProfileRows(d.db, d.workspace, [
      { profileId: erasedProfile },
      { profileId: liveProfile },
      { profileId: 'prf_missing' },
      { profileId: null },
      { profileId: '' },
    ]);
    // A missing profile row is not proof of erasure: only the erasure record drops the row.
    expect(kept).toEqual([{ profileId: liveProfile }, { profileId: 'prf_missing' }, { profileId: null }, { profileId: '' }]);
  });

  it('reruns the external deletion after a crash before the checkpoint, and it is idempotent', async () => {
    const profile = 'prf_0000000000000000000000000000a101';
    await seedPerson(profile);
    const prepared = await prepareErasure(d.db, d.workspace, keyProvider);
    let erasedId = '';
    try {
      erasedId = (
        await d.db.withWorkspace(d.workspace, (tx) =>
          eraseProfileStage(tx, {
            workspaceId: d.workspace,
            profileId: profile,
            requestedBy: 'user_test',
            reason: 'crash test',
            prepared,
          }),
        )
      ).erasureId;
    } finally {
      disposeErasure(prepared);
    }
    // A worker claims the job, deletes from ClickHouse and dies before writing its checkpoint.
    const { events, calls } = fakeEvents();
    const { hot } = fakeHot();
    await claimErasureCleanupJobs(d.db, { limit: 100 });
    await events.deleteEventsOf(d.workspace, {
      anonymousIds: [`${profile}-anon`],
      userIds: [`${profile}-user`],
      profileIds: [profile],
    });
    expect(calls).toHaveLength(1);
    await d.db.admin.query(
      "UPDATE erasure_cleanup_jobs SET lease_until = now() - interval '1 second' WHERE workspace_id = $1 AND erasure_id = $2",
      [d.workspace, erasedId],
    );

    const first = await runErasureCleanupOnce({ db: d.db, kp: keyProvider, events, hot }, { finalSweepMs: 0 });
    // The rerun repeated the same idempotent deletion and recorded the first-sweep checkpoint, but
    // it still waits for a distinct final pass.
    expect(first).toMatchObject({ claimed: 1, deferred: 1, completed: 0 });
    expect(calls).toHaveLength(2);
    expect(await job(erasedId)).toMatchObject({ state: 'pending_external', first_sweep_done_at: expect.any(Date) });

    await makeDue();
    const second = await runErasureCleanupOnce({ db: d.db, kp: keyProvider, events, hot }, { finalSweepMs: 0 });
    expect(second.completed).toBe(1);
    expect(calls).toHaveLength(3);
    expect((await job(erasedId))?.state).toBe('complete');
  });

  it('never stores or logs a raw external error that names the person', async () => {
    const profile = 'prf_0000000000000000000000000000e0e0';
    await seedPerson(profile);
    const prepared = await prepareErasure(d.db, d.workspace, keyProvider);
    let erasedId = '';
    try {
      erasedId = (
        await d.db.withWorkspace(d.workspace, (tx) =>
          eraseProfileStage(tx, {
            workspaceId: d.workspace,
            profileId: profile,
            requestedBy: 'user_test',
            reason: 'error text test',
            prepared,
          }),
        )
      ).erasureId;
    } finally {
      disposeErasure(prepared);
    }
    const secret = 'alice@example.com / anon-e0e0-secret';
    const events = {
      async deleteEventsOf() {
        throw new Error(`ClickHouse rejected the delete for ${secret}`);
      },
      async publishErasedSubjects() {},
      async erasedSubjectsVisible() {
        return true;
      },
    } as unknown as EventStore;
    const { hot } = fakeHot();
    const spy = vi.spyOn(logger, 'warn');
    try {
      const result = await runErasureCleanupOnce({ db: d.db, kp: keyProvider, events, hot }, { finalSweepMs: 0 });
      expect(result).toMatchObject({ claimed: 1, retried: 1 });
      const stored = (await job(erasedId))!;
      expect(stored.last_error).toMatch(/^clickhouse_error/);
      expect(stored.last_error).not.toContain('alice@example.com');
      expect(stored.last_error).not.toContain('anon-e0e0-secret');

      const { events: okEvents } = fakeEvents();
      const executor = createExecutor(d.db, services(okEvents, hot));
      const status = await executor.execute(erasureStatus, { erasureId: erasedId }, userPrincipal('user_test', d.workspace, 'owner'), {
        surface: 'rest',
      });
      expect(status.status).toBe('pending');
      expect(status.lastError).toBe(stored.last_error);
      expect(JSON.stringify(status)).not.toContain('alice@example.com');
      expect(JSON.stringify(status)).not.toContain('anon-e0e0-secret');
      expect(JSON.stringify(spy.mock.calls)).not.toContain('alice@example.com');
      expect(JSON.stringify(spy.mock.calls)).not.toContain('anon-e0e0-secret');
    } finally {
      spy.mockRestore();
    }
  });
});
