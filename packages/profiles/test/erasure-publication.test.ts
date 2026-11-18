import { newUuid } from '@agentic-marketing/core';
import { erasureAllocationChecker, nextErasureGeneration } from '@agentic-marketing/db';
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

async function erase(profileId: string): Promise<string> {
  const prepared = await prepareErasure(d.db, d.workspace, keyProvider);
  try {
    const result = await d.db.withWorkspace(d.workspace, (tx) =>
      eraseProfileStage(tx, {
        workspaceId: d.workspace,
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

async function job(erasureId: string) {
  const { rows } = await d.db.admin.query<{
    state: string;
    attempts: number;
    published_generation: number | string | null;
    published_at: Date | null;
    last_error: string | null;
    clickhouse_done: boolean;
  }>('SELECT * FROM erasure_cleanup_jobs WHERE workspace_id = $1 AND erasure_id = $2', [d.workspace, erasureId]);
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

async function testRows<T>(query: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const settings = await store.settingsFor(d.workspace);
  const rs = await store.client.query({
    query,
    query_params: { ws: d.workspace, ...params },
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

  it('switches a workspace to the protected path as soon as a generation is allocated', async () => {
    // The fast path reads base tables for a workspace that never allocated an erasure. Allocation
    // happens before the ClickHouse insert, so a read issued while publication is in flight must
    // already take the protected path — the allocation counter is the signal, not the confirmed
    // epoch and not `published_at`.
    // A fresh workspace: the other tests in this file already allocated generations here.
    const workspace = newUuid();
    await d.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Allocation', 'none')", [workspace]);
    const checker = erasureAllocationChecker(d.db);
    const scoped = clickHouseStore({
      url: CH_URL,
      database: CH_DB,
      subjectKeys: subjectKeyHasher({ db: d.db, kp: keyProvider }),
      hasErasures: checker,
    });
    const anonymousId = `alloc-anon-${newUuid()}`;
    try {
      const hasher = await subjectKeyHasher({ db: d.db, kp: keyProvider })(workspace);
      const key = await hasher.hash('anonymous_id', anonymousId);
      hasher.dispose();
      await scoped.insert([
        {
          workspaceId: workspace,
          sourceId: 'src_alloc',
          messageId: newUuid(),
          type: 'track',
          name: 'Allocated',
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
      // The exclusion is visible, but no generation has been allocated yet: nothing can be excluded.
      await scoped.publishErasedSubjects([
        {
          workspaceId: workspace,
          kind: 'anonymous_id',
          key,
          keyVersion: 'dk_exclusion_test',
          erasureId: 'era_alloc',
          generation: 1,
          recordedAt: new Date().toISOString(),
        },
      ]);
      expect(await checker(workspace)).toBe(false);
      expect(await scoped.eventsOf(workspace, { anonymousIds: [anonymousId], userIds: [] })).toHaveLength(1);

      // Allocation only: no FINAL confirmation, no `published_at`, no visible epoch.
      await nextErasureGeneration(d.db, workspace);
      expect(await checker(workspace)).toBe(true);
      expect(await scoped.eventsOf(workspace, { anonymousIds: [anonymousId], userIds: [] })).toEqual([]);
    } finally {
      await scoped.close();
    }
  }, 60_000);

  it('keeps the published generation monotonic when two erasures publish', async () => {
    for (const profile of ['prf_0000000000000000000000000000c401', 'prf_0000000000000000000000000000c402']) await seedPerson(profile);
    const start = await generation();
    const first = await erase('prf_0000000000000000000000000000c401');
    const second = await erase('prf_0000000000000000000000000000c402');
    await runErasureCleanupOnce(deps(store), { finalSweepMs: 1_000 });
    const generations = [Number((await job(first))!.published_generation), Number((await job(second))!.published_generation)].sort(
      (a, b) => a - b,
    );
    // Two erasures, two distinct generations, both above the state before them.
    expect(generations).toEqual([start + 1, start + 2]);
  }, 120_000);
});
