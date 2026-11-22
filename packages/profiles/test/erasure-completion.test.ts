import { newUuid } from '@agentic-marketing/core';
import { claimErasurePurges, erasureLedgerCoverage, erasurePurgeProgress, recordErasurePurgeSweep } from '@agentic-marketing/db';
import { clickHouseStore, type EventStore, migrateClickHouse, resetClickHouse } from '@agentic-marketing/events';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { runScoped } from '../../db/test/run';
import { disposeErasure, eraseProfileStage, prepareErasure } from '../src/erasure';
import { runErasureCleanupOnce } from '../src/erasureCleanup';
import { runErasurePurgeOnce } from '../src/erasurePurge';
import { subjectKeyHasher } from '../src/exclusion';

// #1037 part 3: logical completion is gated on the published, visible ledger and on the workspace's
// subject-key coverage count. Physical purge is separate and keeps running after completion. The
// tests drive the production worker and the real ClickHouse store.

const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const CH_DB = runScoped('am_test_erasure_completion');
const MASTER_KEY = Buffer.alloc(32, 31).toString('base64');

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let keyProvider: ReturnType<typeof localKeyProvider>;
let store: EventStore;

async function seedPerson(profileId: string) {
  await d.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [d.workspace, profileId]);
  for (const [type, value] of [
    ['user_id', `${profileId}-user`],
    ['anonymous_id', `${profileId}-anon`],
  ] as const)
    await d.db.admin.query('INSERT INTO identifiers (workspace_id, profile_id, type, value) VALUES ($1, $2, $3, $4)', [
      d.workspace,
      profileId,
      type,
      value,
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
        reason: 'completion test',
        prepared,
      }),
    );
    return result.erasureId;
  } finally {
    disposeErasure(prepared);
  }
}

const job = async (erasureId: string) => {
  const { rows } = await d.db.admin.query<{
    state: string;
    published_at: Date | null;
    coverage_cleared_at: Date | null;
    completion_reason: string | null;
    purged_generation: string | number | null;
  }>(
    `SELECT state, published_at, coverage_cleared_at, completion_reason,
            (SELECT purged_generation FROM erasure_generations g WHERE g.workspace_id = j.workspace_id) AS purged_generation
       FROM erasure_cleanup_jobs j WHERE workspace_id = $1 AND erasure_id = $2`,
    [d.workspace, erasureId],
  );
  return rows[0] ?? null;
};

const ready = async () =>
  d.db.admin.query(
    `UPDATE erasure_cleanup_jobs SET next_attempt_at = now()
      WHERE workspace_id = $1 AND state <> 'complete'`,
    [d.workspace],
  );

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('erasure_completion');
  keyProvider = localKeyProvider(MASTER_KEY);
  await resetClickHouse(CH_URL, CH_DB);
  await migrateClickHouse(CH_URL, CH_DB);
  store = clickHouseStore({ url: CH_URL, database: CH_DB, subjectKeys: subjectKeyHasher({ db: d.db, kp: keyProvider }) });
}, 180_000);

afterAll(async () => {
  await store?.close();
  await d?.close();
});

describe.skipIf(!hasTestDatabase())('erasure logical completion and physical purge (#1037 part 3)', () => {
  it('refuses complete while subject-key coverage is non-zero, with a reason, then completes at zero', async () => {
    const profile = 'prf_0000000000000000000000000000e001';
    await seedPerson(profile);
    const erasureId = await erase(profile);
    let pending = 1;
    const deps = {
      db: d.db,
      kp: keyProvider,
      events: {
        ...store,
        async subjectKeyCoverage() {
          return { pending, tables: pending ? [{ table: 'events', workspaceId: d.workspace, pending }] : [] };
        },
      } as unknown as EventStore,
    };
    const first = await runErasureCleanupOnce(deps, { finalSweepMs: 0, coverageWaitSeconds: 0 });
    expect(first).toMatchObject({ claimed: 1, deferred: 1, completed: 0 });
    await ready();
    const blocked = await runErasureCleanupOnce(deps, { finalSweepMs: 0, coverageWaitSeconds: 0 });
    expect(blocked).toMatchObject({ claimed: 1, deferred: 1, completed: 0 });
    const waiting = await job(erasureId);
    expect(waiting).toMatchObject({ state: 'pending_external', completion_reason: 'subject_key_coverage', coverage_cleared_at: null });
    // The ledger is already published: the wait is the coverage gate, not publication.
    expect(waiting!.published_at).not.toBeNull();

    pending = 0;
    await ready();
    const done = await runErasureCleanupOnce(deps, { finalSweepMs: 0, coverageWaitSeconds: 0 });
    expect(done).toMatchObject({ claimed: 1, completed: 1 });
    expect(await job(erasureId)).toMatchObject({ state: 'complete', coverage_cleared_at: expect.anything() });
  }, 120_000);

  it('reports partial exclusion for an unrecoverable e-mail identifier instead of silently claiming full', async () => {
    const profile = 'prf_0000000000000000000000000000e101';
    await seedPerson(profile);
    const erasureId = await erase(profile);
    // A legacy e-mail identifier kept only its matching-key HMAC (no sealed plaintext), so the
    // erasure stage records coverage `unavailable`.
    await d.db.admin.query(
      `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, coverage)
       VALUES ($1, 'email', 'matching-hash-only', 'dk_exclusion_test', $2, 'unavailable')`,
      [d.workspace, erasureId],
    );
    const coverage = await d.db.withWorkspace(d.workspace, (tx) => erasureLedgerCoverage(tx, d.workspace, erasureId));
    expect(coverage).toMatchObject({ unavailable: 1, unavailableKinds: ['email'] });
    expect(coverage.full).toBeGreaterThan(0);
  }, 60_000);

  it('purges late rows after completion, keeps the exclusion state, and reports purge progress', async () => {
    const profile = 'prf_0000000000000000000000000000e201';
    await seedPerson(profile);
    const erasureId = await erase(profile);
    for (let round = 0; round < 4; round++) {
      const result = await runErasureCleanupOnce({ db: d.db, kp: keyProvider, events: store, hot: undefined }, { finalSweepMs: 0 });
      if (result.completed) break;
      await ready();
    }
    expect((await job(erasureId))?.state).toBe('complete');

    // A row that arrives after completion is still physically present; reads exclude it, and the
    // recurring purge must eventually catch it.
    await store.insert([
      {
        workspaceId: d.workspace,
        sourceId: 'src_completion',
        messageId: newUuid(),
        type: 'track',
        name: 'Late Purchase',
        anonymousId: `${profile}-anon`,
        userId: `${profile}-user`,
        profileId: profile,
        timestamp: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        properties: {},
        traits: {},
        piiTraits: {},
        context: {},
        consent: {},
      },
    ]);
    const baseCount = async () => {
      const settings = await store.settingsFor(d.workspace);
      const rs = await store.client.query({
        query: 'SELECT count() AS n FROM events FINAL WHERE workspace_id = {ws:UUID}',
        query_params: { ws: d.workspace },
        format: 'JSONEachRow',
        clickhouse_settings: settings,
      });
      return Number((await rs.json<{ n: number }>())[0]?.n ?? 0);
    };
    expect(await baseCount()).toBe(1);
    expect(await store.eventsOf(d.workspace, { anonymousIds: [`${profile}-anon`], userIds: [] })).toEqual([]);

    const purge = await runErasurePurgeOnce({ db: d.db, events: store }, { batchSize: 100 });
    expect(purge).toMatchObject({ claimed: 1, completed: 1, deleted: 1 });
    expect(await baseCount()).toBe(0);
    // Selectors and published exclusions survive the physical purge.
    const kept = await d.db.admin.query('SELECT count(*)::int AS n FROM erasure_keys WHERE workspace_id = $1', [d.workspace]);
    expect(kept.rows[0]?.n).toBeGreaterThan(0);
    const published = await store.erasedSubjectKeys(d.workspace);
    expect(published.size).toBeGreaterThan(0);
    const progress = await d.db.withWorkspace(d.workspace, (tx) => erasurePurgeProgress(tx, d.workspace, 1));
    expect(progress.state).toBe('done');
    expect(progress.lastSweepAt).not.toBeNull();
    expect(progress.deletedRows).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('claims a purge only after the publication generation exists and fences its progress', async () => {
    const workspace = newUuid();
    await d.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Purge claim', 'none')", [workspace]);
    await d.db.admin.query(`INSERT INTO erasure_generations (workspace_id, generation, visible_publications) VALUES ($1, 3, 1)`, [
      workspace,
    ]);
    const claimed = (await claimErasurePurges(d.db, { intervalSeconds: 0 })).find((c) => c.workspaceId === workspace)!;
    expect(claimed).toMatchObject({ generation: 3, purgedGeneration: 0 });
    await d.db.admin.query("UPDATE erasure_generations SET purge_lease_until = now() - interval '1 second' WHERE workspace_id = $1", [
      workspace,
    ]);
    const reclaimed = (await claimErasurePurges(d.db, { intervalSeconds: 0 })).find((c) => c.workspaceId === workspace)!;
    expect(reclaimed.claimToken).not.toBe(claimed.claimToken);
    await expect(recordErasurePurgeSweep(d.db, claimed, { generation: 3, deletedRows: 0, complete: true })).resolves.toBe(false);
    await expect(recordErasurePurgeSweep(d.db, reclaimed, { generation: 3, deletedRows: 0, complete: true })).resolves.toBe(true);
    const rows = await d.db.admin.query<{ purged_generation: string | number }>(
      'SELECT purged_generation FROM erasure_generations WHERE workspace_id = $1',
      [workspace],
    );
    expect(Number(rows.rows[0]?.purged_generation)).toBe(3);
  }, 60_000);

  it('renews the purge lease between batches and stops when another replica takes over', async () => {
    const workspace = newUuid();
    await d.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Purge lease', 'none')", [workspace]);
    await d.db.admin.query('INSERT INTO erasure_generations (workspace_id, generation, visible_publications) VALUES ($1, 1, 1)', [
      workspace,
    ]);
    // A full-coverage key makes the workspace eligible for the physical sweep.
    await d.db.admin.query(
      `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, coverage)
       VALUES ($1, 'profile', 'lease-key', 'dk_exclusion_test', 'era_lease', 'full')`,
      [workspace],
    );

    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const slowBatch = new Promise<void>((resolve) => {
      release = resolve;
    });
    let checks = 0;
    const events = {
      async purgeErasedSubjects(id: string, _keys: string[], opts: { checkpoint?: () => Promise<boolean> }) {
        if (id !== workspace) return { deleted: 0, complete: true, tables: [] };
        // The first batch renews and mutates.
        expect(await opts.checkpoint?.()).toBe(true);
        checks++;
        started();
        // A slow batch: the 60 s lease can be reclaimed while this is still running.
        await slowBatch;
        // At the next batch boundary the worker must renew and see the takeover before mutating.
        expect(await opts.checkpoint?.()).toBe(false);
        checks++;
        return { deleted: 0, complete: false, tables: [{ table: 'events', deleted: 0, remaining: true }] };
      },
    } as unknown as EventStore;

    const running = runErasurePurgeOnce({ db: d.db, events }, { batch: 100 });
    await startedPromise;
    // Expire the lease and let a second replica claim it; its token fences the first worker.
    await d.db.admin.query("UPDATE erasure_generations SET purge_lease_until = now() - interval '1 second' WHERE workspace_id = $1", [
      workspace,
    ]);
    const second = (await claimErasurePurges(d.db, { intervalSeconds: 0, limit: 100 })).find((c) => c.workspaceId === workspace)!;
    expect(second).toBeDefined();
    release();
    const result = await running;

    expect(checks).toBe(2);
    expect(result).toMatchObject({ deleted: 0, completed: 0 });
    const row = await d.db.admin.query<{ purged_generation: string | number; purge_claim_token: string | null }>(
      'SELECT purged_generation, purge_claim_token FROM erasure_generations WHERE workspace_id = $1',
      [workspace],
    );
    // The stale worker neither advanced the obligation nor cleared the new owner's claim.
    expect(Number(row.rows[0]?.purged_generation)).toBe(0);
    expect(row.rows[0]?.purge_claim_token).toBe(second.claimToken);
  }, 60_000);

  it('keeps its purge claim after a failure, so an in-flight mutation is not overlapped', async () => {
    const workspace = newUuid();
    await d.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Purge failure', 'none')", [workspace]);
    await d.db.admin.query('INSERT INTO erasure_generations (workspace_id, generation, visible_publications) VALUES ($1, 1, 1)', [
      workspace,
    ]);
    await d.db.admin.query(
      `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, coverage)
       VALUES ($1, 'profile', 'failure-key', 'dk_exclusion_test', 'era_failure', 'full')`,
      [workspace],
    );
    const events = {
      async purgeErasedSubjects(id: string) {
        if (id === workspace) throw new Error('clickhouse unavailable');
        return { deleted: 0, complete: true, tables: [] };
      },
    } as unknown as EventStore;

    const result = await runErasurePurgeOnce({ db: d.db, events }, { batch: 100 });
    expect(result.failed).toBeGreaterThanOrEqual(1);
    const row = await d.db.admin.query<{ purge_claim_token: string | null; purge_lease_until: Date | null }>(
      'SELECT purge_claim_token, purge_lease_until FROM erasure_generations WHERE workspace_id = $1',
      [workspace],
    );
    // Releasing the claim here would let another replica submit a second mutation while the failed
    // one may still be running; the lease expires on its own instead.
    expect(row.rows[0]?.purge_claim_token).not.toBeNull();
    expect(row.rows[0]?.purge_lease_until?.getTime() ?? 0).toBeGreaterThan(Date.now());
  }, 60_000);
});
