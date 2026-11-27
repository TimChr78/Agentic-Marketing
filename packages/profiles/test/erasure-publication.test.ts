import { createHash } from 'node:crypto';
import { newUuid } from '@agentic-marketing/core';
import {
  enqueueUnpublishedErasures,
  erasureLedgerChecker,
  readErasureLog,
  replayErasures,
  runErasurePublicationBacklog,
} from '@agentic-marketing/db';
import { clickHouseStore, type EventStore, migrateClickHouse, resetClickHouse } from '@agentic-marketing/events';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { runScoped } from '../../db/test/run';
import { disposeErasure, eraseProfileStage, prepareErasure } from '../src/erasure';
import { runErasureCleanupOnce } from '../src/erasureCleanup';
import { subjectKeyHasher } from '../src/exclusion';

// #1037 part 2: after the erasure's SQL stage commits, the cleanup job publishes its ledger to
// ClickHouse's erased subjects before touching anything else, under a new per-workspace
// generation, and records the generation only after a FINAL read shows every key. The tests drive
// the production worker and the production hasher, so the published hashes are the ones a writer
// stores.

const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const CH_DB = runScoped('am_test_erasure_publication');
const MASTER_KEY = Buffer.alloc(32, 29).toString('base64');

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let keyProvider: ReturnType<typeof localKeyProvider>;
let store: EventStore;

/** A stable 64-hex stand-in for a keyed hash; the ledger only stores strings. */
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

const deps = (events: Pick<EventStore, 'deleteEventsOf' | 'publishErasedSubjects' | 'erasedSubjectsVisible'>) =>
  ({ db: d.db, kp: keyProvider, events }) as unknown as Parameters<typeof runErasureCleanupOnce>[0];

async function seedPerson(profileId: string) {
  await d.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [d.workspace, profileId]);
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
}

/** One user id and many long anonymous ids, so the ledger and the selector list outgrow one field. */
async function seedLargePerson(workspaceId: string, profileId: string, prefix: string, anonymousIds: number) {
  await d.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [workspaceId, profileId]);
  await d.db.admin.query('INSERT INTO identifiers (workspace_id, profile_id, type, value) VALUES ($1, $2, $3, $4)', [
    workspaceId,
    profileId,
    'user_id',
    `${profileId}-user`,
  ]);
  await d.db.admin.query(
    `INSERT INTO identifiers (workspace_id, profile_id, type, value)
     SELECT $1, $2, 'anonymous_id', $3 || g || '-' || repeat('a', 64) FROM generate_series(1, $4::int) AS g`,
    [workspaceId, profileId, prefix, anonymousIds],
  );
}

async function erase(profileId: string, workspaceId = d.workspace): Promise<string> {
  const prepared = await prepareErasure(d.db, workspaceId, keyProvider);
  try {
    const result = await d.db.withWorkspace(workspaceId, (tx) =>
      eraseProfileStage(tx, {
        workspaceId,
        profileId,
        requestedBy: 'user_test',
        reason: 'publication test',
        prepared,
      }),
    );
    return result.erasureId;
  } finally {
    disposeErasure(prepared);
  }
}

async function job(erasureId: string, workspaceId = d.workspace) {
  const { rows } = await d.db.admin.query<{
    state: string;
    attempts: number;
    published_generation: number | string | null;
    published_at: Date | null;
    last_error: string | null;
    clickhouse_done: boolean;
  }>('SELECT * FROM erasure_cleanup_jobs WHERE workspace_id = $1 AND erasure_id = $2', [workspaceId, erasureId]);
  const row = rows[0];
  return row ? { ...row, published_generation: row.published_generation === null ? null : Number(row.published_generation) } : null;
}

/** The workspace's current generation, so a test asserts a step, not an absolute value. */
async function generation(): Promise<number> {
  const { rows } = await d.db.admin.query<{ generation: number | string }>(
    'SELECT COALESCE(MAX(generation), 0) AS generation FROM erasure_generations WHERE workspace_id = $1',
    [d.workspace],
  );
  return Number(rows[0]?.generation ?? 0);
}

async function testRows<T>(query: string, params: Record<string, unknown> = {}, workspaceId = d.workspace): Promise<T[]> {
  const settings = await store.settingsFor(workspaceId);
  const rs = await store.client.query({
    query,
    query_params: { ws: workspaceId, ...params },
    format: 'JSONEachRow',
    clickhouse_settings: settings,
  });
  return rs.json<T>();
}

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('erasure_publication');
  keyProvider = localKeyProvider(MASTER_KEY);
  await resetClickHouse(CH_URL, CH_DB);
  await migrateClickHouse(CH_URL, CH_DB);
  store = clickHouseStore({ url: CH_URL, database: CH_DB, subjectKeys: subjectKeyHasher({ db: d.db, kp: keyProvider }) });
}, 180_000);

afterAll(async () => {
  await store?.close();
  await d?.close();
});

describe.skipIf(!hasTestDatabase())('durable exclusion publication (#1037 part 2)', () => {
  it('publishes the committed ledger before any sweep and records the confirmed generation', async () => {
    const profile = 'prf_0000000000000000000000000000c001';
    await seedPerson(profile);
    const erasureId = await erase(profile);

    const ledger = await d.db.admin.query<{ kind: string; key_value: string }>(
      "SELECT kind, key_value FROM erasure_keys WHERE workspace_id = $1 AND erasure_id = $2 AND coverage = 'full'",
      [d.workspace, erasureId],
    );
    expect(ledger.rowCount).toBeGreaterThan(0);

    const first = await runErasureCleanupOnce(deps(store), { finalSweepMs: 1_000 });
    expect(first.claimed).toBe(1);

    const published = await job(erasureId);
    expect(published).toMatchObject({ published_generation: 1 });
    expect(published!.published_at).not.toBeNull();

    const erased = await testRows<{ key: string; generation: number | string; key_version: string }>(
      `SELECT key, generation, key_version FROM erased_subjects FINAL WHERE workspace_id = {ws:UUID}`,
    );
    expect(erased.map((row) => row.key).sort()).toEqual(ledger.rows.map((row) => row.key_value).sort());
    expect(new Set(erased.map((row) => row.generation))).toEqual(new Set([1]));

    // A row written after publication is invisible to a protected read, even though the sweep has
    // not run again: exclusion is read-time state, not a retention side effect.
    await store.insert([
      {
        workspaceId: d.workspace,
        sourceId: 'src_pub',
        messageId: newUuid(),
        type: 'track',
        name: 'Late Purchase',
        anonymousId: `${profile}-anon`,
        userId: '',
        profileId: '',
        timestamp: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        properties: {},
        traits: {},
        piiTraits: {},
        context: {},
        consent: {},
      },
    ]);
    expect(await store.eventsOf(d.workspace, { anonymousIds: [`${profile}-anon`], userIds: [] })).toEqual([]);
  }, 120_000);

  it('publishes and sweeps a ledger larger than one query parameter', async () => {
    // Its own workspace keeps the erased_subjects count below exact: other tests in this file
    // publish into the shared workspace.
    const workspace = newUuid();
    await d.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Large ledger', 'none')", [workspace]);
    const profile = 'prf_0000000000000000000000000000c002';
    const anonymousIds = 2_500;
    await seedLargePerson(workspace, profile, 'large-publication-', anonymousIds);
    const erasureId = await erase(profile, workspace);

    const ledger = await d.db.admin.query<{ n: string }>(
      "SELECT count(*) AS n FROM erasure_keys WHERE workspace_id = $1 AND erasure_id = $2 AND coverage = 'full'",
      [workspace, erasureId],
    );
    const keys = Number(ledger.rows[0]!.n);
    // The erasure's ledger and the sweep's anonymous-id selector are both past one HTTP field (128
    // KiB). The publication's FINAL check and the sweep must move in bounded requests, and only then
    // may the job record its publication and checkpoint the ClickHouse half.
    expect(keys).toBeGreaterThan(3_000);

    // Other due jobs in this file's workspace may be claimed in the same round; this job's own
    // record is what proves its publication and sweep finished.
    await runErasureCleanupOnce(deps(store), { finalSweepMs: 1_000 });
    const published = await job(erasureId, workspace);
    expect(published).toMatchObject({ clickhouse_done: true });
    expect(published!.published_at).not.toBeNull();

    const erased = await testRows<{ n: number | string }>(
      'SELECT count() AS n FROM erased_subjects FINAL WHERE workspace_id = {ws:UUID}',
      {},
      workspace,
    );
    expect(Number(erased[0]?.n ?? 0)).toBe(keys);
  }, 240_000);

  it('re-publishes after a restore: a pending job with no recorded publication publishes again', async () => {
    const profile = 'prf_0000000000000000000000000000c101';
    await seedPerson(profile);
    const erasureId = await erase(profile);
    await runErasureCleanupOnce(deps(store), { finalSweepMs: 1_000 });
    const before = await generation();
    expect((await job(erasureId))!.published_generation).toBe(before);

    // A restore replays the erasure as a fresh pending job and may restore ClickHouse to a snapshot
    // without the exclusions. Both halves are simulated: the job loses its publication record and
    // the ClickHouse rows are gone.
    await store.client.command({
      query: 'DELETE FROM erased_subjects WHERE workspace_id = {ws:UUID}',
      query_params: { ws: d.workspace },
      clickhouse_settings: await store.settingsFor(d.workspace),
    });
    await d.db.admin.query(
      `UPDATE erasure_cleanup_jobs
          SET state = 'pending_external', attempts = 0, next_attempt_at = now(), lease_until = NULL, claim_token = NULL,
              clickhouse_done = false, hotstate_done = false, published_generation = NULL, published_at = NULL
        WHERE workspace_id = $1 AND erasure_id = $2`,
      [d.workspace, erasureId],
    );

    await runErasureCleanupOnce(deps(store), { finalSweepMs: 1_000 });
    const again = await job(erasureId);
    // The generation moves forward: a republished exclusion is never older than what was visible.
    expect(again).toMatchObject({ published_generation: before + 1 });
    expect(again!.published_at).not.toBeNull();
    const erased = await testRows<{ generation: number | string }>(
      `SELECT generation FROM erased_subjects FINAL WHERE workspace_id = {ws:UUID}`,
    );
    expect(erased.length).toBeGreaterThan(0);
    expect(new Set(erased.map((row) => Number(row.generation)))).toEqual(new Set([before + 1]));
  }, 120_000);

  it('records generation 0 for an erasure whose ledger has nothing publishable', async () => {
    const erasureId = 'era_0000000000000000000000000000c201';
    await d.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs (workspace_id, erasure_id, profile_ids)
       VALUES ($1, $2, '{}') ON CONFLICT DO NOTHING`,
      [d.workspace, erasureId],
    );
    await runErasureCleanupOnce(deps(store), { finalSweepMs: 1_000 });
    expect(await job(erasureId)).toMatchObject({ published_generation: 0 });
  }, 60_000);

  it('does not sweep or record publication when the FINAL read does not show the keys', async () => {
    const profile = 'prf_0000000000000000000000000000c301';
    await seedPerson(profile);
    const erasureId = await erase(profile);
    const swept: string[] = [];
    const invisible = {
      async deleteEventsOf() {
        swept.push('sweep');
      },
      // The insert "succeeded" but a replica never shows it: publication must not be recorded.
      async publishErasedSubjects() {},
      async erasedSubjectsVisible() {
        return false;
      },
    };
    await runErasureCleanupOnce(deps(invisible), { finalSweepMs: 0, maxAttempts: 1 });
    expect(swept).toEqual([]);
    const failed = await job(erasureId);
    expect(failed).toMatchObject({ state: 'failed', published_generation: null, published_at: null, clickhouse_done: false });
    expect(failed!.last_error).toMatch(/^clickhouse_error/);
  }, 60_000);

  it('fails closed from the committed ledger, before any generation or publication exists', async () => {
    // The read boundary is the durable ledger written by the erasure's SQL transaction, not the
    // cleanup worker's allocation: an erasure recorded by an older release, or restored from a
    // snapshot, has ledger rows and must already take the protected path.
    const workspace = newUuid();
    await d.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Ledger', 'none')", [workspace]);
    const checker = erasureLedgerChecker(d.db);
    const scoped = clickHouseStore({
      url: CH_URL,
      database: CH_DB,
      subjectKeys: subjectKeyHasher({ db: d.db, kp: keyProvider }),
      hasErasures: checker,
    });
    const anonymousId = `ledger-anon-${newUuid()}`;
    try {
      const hasher = await subjectKeyHasher({ db: d.db, kp: keyProvider })(workspace);
      const key = await hasher.hash('anonymous_id', anonymousId);
      hasher.dispose();
      await scoped.insert([
        {
          workspaceId: workspace,
          sourceId: 'src_ledger',
          messageId: newUuid(),
          type: 'track',
          name: 'Ledger Event',
          anonymousId,
          userId: '',
          profileId: '',
          timestamp: new Date().toISOString(),
          receivedAt: new Date().toISOString(),
          properties: {},
          traits: {},
          piiTraits: {},
          context: {},
          consent: {},
        },
      ]);
      // No ledger row yet: the fast path is correct and the row is visible.
      expect(await checker(workspace)).toBe(false);
      expect(await scoped.eventsOf(workspace, { anonymousIds: [anonymousId], userIds: [] })).toHaveLength(1);

      // The erasure's SQL stage commits its ledger; publication has not run (no job, no generation,
      // no `published_at`). The next read must already be protected, and with the exclusion
      // published it excludes the row.
      await d.db.admin.query(
        `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, coverage)
         VALUES ($1, 'anonymous_id', $2, 'dk_exclusion_test', 'era_ledger', 'full')`,
        [workspace, key],
      );
      await scoped.publishErasedSubjects([
        {
          workspaceId: workspace,
          kind: 'anonymous_id',
          key,
          keyVersion: 'dk_exclusion_test',
          erasureId: 'era_ledger',
          generation: 1,
          recordedAt: new Date().toISOString(),
        },
      ]);
      expect(await checker(workspace)).toBe(true);
      expect(await scoped.eventsOf(workspace, { anonymousIds: [anonymousId], userIds: [] })).toEqual([]);
      const generations = await d.db.admin.query('SELECT 1 FROM erasure_generations WHERE workspace_id = $1', [workspace]);
      expect(generations.rowCount).toBe(0);
    } finally {
      await scoped.close();
    }
  }, 60_000);

  it('re-enqueues erasures that have ledger rows but were never published', async () => {
    const workspace = newUuid();
    await d.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Backlog', 'none')", [workspace]);
    const insertErasure = (id: string) =>
      d.db.admin.query(
        `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
         VALUES ($1, $2, '{}', 'user_test', 'backlog test', '{}')`,
        [workspace, id],
      );
    const insertKey = (eraser: string) =>
      d.db.admin.query(
        `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, coverage)
         VALUES ($1, 'profile', $2, 'dk_exclusion_test', $3, 'full')`,
        [workspace, hash(`backlog-${eraser}`), eraser],
      );
    // (1) a job that completed before publication existed, (2) an erasure with no job at all,
    // (3) an already-published job, (4) a running job with a live lease, (5) a queued job.
    for (const id of ['era_backlog_old', 'era_backlog_none', 'era_backlog_done', 'era_backlog_running', 'era_backlog_pending']) {
      await insertErasure(id);
      await insertKey(id);
    }
    await d.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs (workspace_id, erasure_id, profile_ids, state, completed_at)
       VALUES ($1, 'era_backlog_old', '{}', 'complete', now())`,
      [workspace],
    );
    await d.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs (workspace_id, erasure_id, profile_ids, state, completed_at, published_generation, published_at)
       VALUES ($1, 'era_backlog_done', '{}', 'complete', now(), 3, now())`,
      [workspace],
    );
    await d.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs
         (workspace_id, erasure_id, profile_ids, state, claim_token, lease_until, clickhouse_done, hotstate_done, attempts)
       VALUES ($1, 'era_backlog_running', '{}', 'running', 'claim-live', now() + interval '5 minutes', true, true, 2)`,
      [workspace],
    );
    await d.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs (workspace_id, erasure_id, profile_ids, state, next_attempt_at)
       VALUES ($1, 'era_backlog_pending', '{}', 'pending_external', now() + interval '1 hour')`,
      [workspace],
    );

    // The pass is cross-tenant by design, so other workspaces' leftovers may be re-opened too;
    // this workspace's rows are what the test pins.
    expect(await enqueueUnpublishedErasures(d.db)).toBeGreaterThanOrEqual(2);
    const rows = await d.db.admin.query<{
      erasure_id: string;
      state: string;
      published_at: Date | null;
      claim_token: string | null;
      lease_until: Date | null;
      clickhouse_done: boolean;
    }>(
      `SELECT erasure_id, state, published_at, claim_token, lease_until, clickhouse_done
         FROM erasure_cleanup_jobs WHERE workspace_id = $1 ORDER BY erasure_id`,
      [workspace],
    );
    expect(rows.rows).toEqual([
      {
        erasure_id: 'era_backlog_done',
        state: 'complete',
        published_at: expect.any(Date),
        claim_token: null,
        lease_until: null,
        clickhouse_done: false,
      },
      {
        erasure_id: 'era_backlog_none',
        state: 'pending_external',
        published_at: null,
        claim_token: null,
        lease_until: null,
        clickhouse_done: false,
      },
      {
        erasure_id: 'era_backlog_old',
        state: 'pending_external',
        published_at: null,
        claim_token: null,
        lease_until: null,
        clickhouse_done: false,
      },
      {
        erasure_id: 'era_backlog_pending',
        state: 'pending_external',
        published_at: null,
        claim_token: null,
        lease_until: null,
        clickhouse_done: false,
      },
      {
        erasure_id: 'era_backlog_running',
        state: 'running',
        published_at: null,
        claim_token: 'claim-live',
        lease_until: expect.any(Date),
        clickhouse_done: true,
      },
    ]);
    // Idempotent: a second pass re-opens nothing and does not disturb the running job.
    await enqueueUnpublishedErasures(d.db);
    const again = await d.db.admin.query<{ erasure_id: string; state: string; claim_token: string | null }>(
      'SELECT erasure_id, state, claim_token FROM erasure_cleanup_jobs WHERE workspace_id = $1 ORDER BY erasure_id',
      [workspace],
    );
    expect(again.rows).toEqual([
      { erasure_id: 'era_backlog_done', state: 'complete', claim_token: null },
      { erasure_id: 'era_backlog_none', state: 'pending_external', claim_token: null },
      { erasure_id: 'era_backlog_old', state: 'pending_external', claim_token: null },
      { erasure_id: 'era_backlog_pending', state: 'pending_external', claim_token: null },
      { erasure_id: 'era_backlog_running', state: 'running', claim_token: 'claim-live' },
    ]);
  }, 60_000);

  it('re-opens a failed publication job on a later pass and stops on abort (#1062)', async () => {
    const workspace = newUuid();
    const erasureId = 'era_backlog_failed';
    await d.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Failed backlog', 'none')", [workspace]);
    await d.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, $2, '{}', 'user_test', 'failed publication', '{}')`,
      [workspace, erasureId],
    );
    await d.db.admin.query(
      `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, coverage)
       VALUES ($1, 'profile', $2, 'dk_exclusion_test', $3, 'full')`,
      [workspace, hash('failed-publication'), erasureId],
    );
    await d.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs
         (workspace_id, erasure_id, profile_ids, state, attempts, last_error, clickhouse_done, hotstate_done)
       VALUES ($1, $2, '{}', 'failed', 36, 'ClickHouse unavailable', true, true)`,
      [workspace, erasureId],
    );
    const controller = new AbortController();
    const running = runErasurePublicationBacklog({ db: d.db }, controller.signal, { tickMs: 5 });
    const deadline = Date.now() + 10_000;
    let state = 'failed';
    while (Date.now() < deadline) {
      const { rows } = await d.db.admin.query<{ state: string }>(
        'SELECT state FROM erasure_cleanup_jobs WHERE workspace_id = $1 AND erasure_id = $2',
        [workspace, erasureId],
      );
      state = rows[0]?.state ?? 'missing';
      if (state === 'pending_external') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    await running;
    expect(state).toBe('pending_external');
    const { rows } = await d.db.admin.query<{ state: string; published_at: Date | null; clickhouse_done: boolean; attempts: number }>(
      'SELECT state, published_at, clickhouse_done, attempts FROM erasure_cleanup_jobs WHERE workspace_id = $1 AND erasure_id = $2',
      [workspace, erasureId],
    );
    // Re-opened for a fresh publication: the earlier sweep checkpoints and publication do not count,
    // and the job gets a whole retry budget instead of one attempt (#1219).
    expect(rows[0]).toMatchObject({ state: 'pending_external', published_at: null, clickhouse_done: false, attempts: 0 });
  }, 60_000);

  it('keeps a restored workspace on the protected path with ledger rows but no generation row', async () => {
    // A snapshot can hold `erasure_keys` rows whose workspace never got a generation (part-1
    // erasures, or a restore between publication attempts). The fast path must still fail closed,
    // and the exclusions retained in ClickHouse must still apply after the replay.
    const restored = await createDisposableDb('erasure_ledger_restore');
    try {
      const workspace = newUuid();
      await d.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Restore source', 'none')", [workspace]);
      for (const id of ['era_restore_ledger', 'era_restore_no_keys']) {
        await d.db.admin.query(
          `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
           VALUES ($1, $2, '{}', 'user_test', 'restore test', '{}')`,
          [workspace, id],
        );
      }
      const anonymousId = `restore-anon-${newUuid()}`;
      const hasher = await subjectKeyHasher({ db: d.db, kp: keyProvider })(workspace);
      const key = await hasher.hash('anonymous_id', anonymousId);
      hasher.dispose();
      await d.db.admin.query(
        `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, coverage)
         VALUES ($1, 'anonymous_id', $2, 'dk_exclusion_test', 'era_restore_ledger', 'full')`,
        [workspace, key],
      );
      const log = await readErasureLog(d.url.toString());
      // ClickHouse is not part of the Postgres restore: its exclusions are retained.
      const writer = clickHouseStore({
        url: CH_URL,
        database: CH_DB,
        subjectKeys: subjectKeyHasher({ db: d.db, kp: keyProvider }),
      });
      try {
        await writer.publishErasedSubjects([
          {
            workspaceId: workspace,
            kind: 'anonymous_id',
            key,
            keyVersion: 'dk_exclusion_test',
            erasureId: 'era_restore_ledger',
            generation: 1,
            recordedAt: new Date().toISOString(),
          },
        ]);
        await writer.insert([
          {
            workspaceId: workspace,
            sourceId: 'src_restore',
            messageId: newUuid(),
            type: 'track',
            name: 'Restored Event',
            anonymousId,
            userId: '',
            profileId: '',
            timestamp: new Date().toISOString(),
            receivedAt: new Date().toISOString(),
            properties: {},
            traits: {},
            piiTraits: {},
            context: {},
            consent: {},
          },
        ]);
      } finally {
        await writer.close();
      }

      // The restored snapshot has the workspace but no ledger and no generation row.
      await restored.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Restored', 'none')", [workspace]);
      const replayed = await replayErasures(restored.url.toString(), log);
      expect(replayed.keys).toBe(1);
      // The erasure had no captured job; its own ledger row still enqueues one so it publishes
      // again. The workspace's other erasure has no keys of its own, so it gets no job.
      expect(replayed.cleanupJobs).toBe(1);
      expect(await restored.db.admin.query('SELECT 1 FROM erasure_generations WHERE workspace_id = $1', [workspace])).toMatchObject({
        rowCount: 0,
      });

      const checker = erasureLedgerChecker(restored.db);
      const scoped = clickHouseStore({ url: CH_URL, database: CH_DB, hasErasures: checker });
      try {
        expect(await checker(workspace)).toBe(true);
        expect(await scoped.eventsOf(workspace, { anonymousIds: [anonymousId], userIds: [] })).toEqual([]);
      } finally {
        await scoped.close();
      }
    } finally {
      await restored.close();
    }
  }, 120_000);

  it('keeps the published generation monotonic when two erasures publish', async () => {
    for (const profile of ['prf_0000000000000000000000000000c401', 'prf_0000000000000000000000000000c402']) await seedPerson(profile);
    const start = await generation();
    const first = await erase('prf_0000000000000000000000000000c401');
    const second = await erase('prf_0000000000000000000000000000c402');
    await runErasureCleanupOnce(deps(store), { finalSweepMs: 1_000 });
    const generations = [Number((await job(first))!.published_generation), Number((await job(second))!.published_generation)].sort(
      (a, b) => a - b,
    );
    // Two erasures, two distinct generations, both above the state before them. The values need not
    // be consecutive: another due job of this workspace can publish in the same round.
    expect(generations[0]).toBeGreaterThan(start);
    expect(generations[1]).toBeGreaterThan(generations[0]!);
  }, 120_000);
});
