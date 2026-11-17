import { createExecutor, userPrincipal } from '@agentic-marketing/commands';
import { claimErasureCleanupJobs } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import type { HotState } from '@agentic-marketing/hotstate';
import { assertNoProviderCalls, localKeyProvider, recordingKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { eraseProfile, erasureStatus } from '../src/commands';
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
  const events = {
    async deleteEventsOf(workspaceId: string, ids: { anonymousIds: string[]; userIds: string[]; profileIds?: string[] }) {
      calls.push({ workspaceId, ...ids });
    },
  } as unknown as EventStore;
  return { events, calls };
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
    selectors: Buffer | null;
    selector_key: Buffer | null;
    selector_kek: string | null;
    profile_ids: string[];
  }>('SELECT * FROM erasure_cleanup_jobs WHERE workspace_id = $1 AND erasure_id = $2', [d.workspace, erasureId]);
  return rows[0] ?? null;
};

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

    const result = await runErasureCleanupOnce({ db: d.db, kp: keyProvider, events, hot });
    expect(result).toMatchObject({ claimed: 1, completed: 1 });
    expect(eventCalls).toEqual([
      {
        workspaceId: d.workspace,
        anonymousIds: [`${profile}-anon`],
        userIds: [`${profile}-user`],
        profileIds: [profile],
      },
    ]);
    expect(hotCalls).toEqual([{ workspaceId: d.workspace, anonymousIds: [`${profile}-anon`], userIds: [`${profile}-user`] }]);

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
    // Nothing ran in that process; a later worker claims the committed job.
    const { events, calls } = fakeEvents();
    const { hot } = fakeHot();
    const result = await runErasureCleanupOnce({ db: d.db, kp: keyProvider, events, hot });
    expect(result.completed).toBe(1);
    expect(calls).toHaveLength(1);
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
    const first = await runErasureCleanupOnce({ db: d.db, kp: keyProvider, events, hot }, { outboxWaitSeconds: 0 });
    expect(first).toMatchObject({ claimed: 1, deferred: 1, completed: 0 });
    expect(calls).toHaveLength(0);
    expect((await job(erasedId))?.state).toBe('pending_external');

    // The publisher commits its event; the next claim sweeps it and completes.
    await d.db.admin.query("UPDATE outbox SET state = 'delivered' WHERE operation_key = 'erasure-inflight'");
    await d.db.admin.query('UPDATE erasure_cleanup_jobs SET next_attempt_at = now() WHERE workspace_id = $1 AND erasure_id = $2', [
      d.workspace,
      erasedId,
    ]);
    const second = await runErasureCleanupOnce({ db: d.db, kp: keyProvider, events, hot }, { outboxWaitSeconds: 0 });
    expect(second).toMatchObject({ claimed: 1, completed: 1 });
    expect(calls).toHaveLength(1);
    expect((await job(erasedId))?.state).toBe('complete');
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

    const result = await runErasureCleanupOnce({ db: d.db, kp: keyProvider, events, hot });
    expect(result.completed).toBe(1);
    // The rerun repeated the same idempotent deletion, then checkpointed and completed.
    expect(calls).toHaveLength(2);
    expect((await job(erasedId))?.state).toBe('complete');
  });
});
