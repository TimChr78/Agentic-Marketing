import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimErasureCleanupJobs,
  completeErasureCleanup,
  deferErasureCleanup,
  dropErasedProfileOutbox,
  enqueueErasureCleanupJob,
  erasureCleanupRetrySeconds,
  erasureOutboxOutstanding,
  failErasureCleanup,
  markErasureCleanupCheckpoint,
  renewErasureCleanupLease,
  resetErasureCleanupCheckpoints,
} from '../src/erasureCleanup';
import { createDb } from '../src/pool';
import { APP_ROLE, createDisposableDb, hasTestDatabase } from './disposable';

// Durable erasure cleanup (#978 part 2b): one SQL row per erasure, claimed with a lease and a
// fencing token, checkpointed per external store, and completed only by the claim that still owns
// it. The tests move `next_attempt_at` and `lease_until` themselves, so no wall-clock sleep is
// involved.

let d: Awaited<ReturnType<typeof createDisposableDb>>;
const selectors = Buffer.from('sealed selectors');
const selectorKey = Buffer.from('wrapped service key');

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('erasure_cleanup');
}, 120_000);

afterAll(async () => {
  await d?.close();
});

const erasure = (id: string) =>
  d.db.admin.query(
    `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
     VALUES ($1, $2, $3, 'tester', 'cleanup test', '{"profiles":1}')`,
    [d.workspace, id, [`prf_${id}`]],
  );

const enqueue = async (id: string, profiles = [`prf_${id}`]) => {
  await erasure(id);
  await d.db.withWorkspace(d.workspace, (tx) =>
    enqueueErasureCleanupJob(tx, d.workspace, {
      erasureId: id,
      profileIds: profiles,
      selectors,
      selectorKey,
      selectorKek: 'local-test',
    }),
  );
};

const row = async (id: string) => {
  const { rows } = await d.db.admin.query<{
    erasure_id: string;
    state: string;
    attempts: number;
    next_attempt_at: Date;
    lease_until: Date | null;
    claim_token: string | null;
    clickhouse_done: boolean;
    hotstate_done: boolean;
    selectors: Buffer | null;
    selector_key: Buffer | null;
    selector_kek: string | null;
    last_error: string | null;
    completed_at: Date | null;
  }>('SELECT * FROM erasure_cleanup_jobs WHERE workspace_id = $1 AND erasure_id = $2', [d.workspace, id]);
  return rows[0] ?? null;
};

const makeDue = (id: string) =>
  d.db.admin.query(
    `UPDATE erasure_cleanup_jobs SET next_attempt_at = now() - interval '1 second'
     WHERE workspace_id = $1 AND erasure_id = $2`,
    [d.workspace, id],
  );

const expireLease = (id: string) =>
  d.db.admin.query(
    `UPDATE erasure_cleanup_jobs SET lease_until = now() - interval '1 second'
     WHERE workspace_id = $1 AND erasure_id = $2`,
    [d.workspace, id],
  );

const claimFor = async (id: string, opts: { limit?: number } = {}) => {
  const claims = await claimErasureCleanupJobs(d.db, { limit: opts.limit ?? 100, leaseMs: 60_000 });
  return claims.find((c) => c.erasureId === id);
};

describe.skipIf(!hasTestDatabase())('durable erasure cleanup (#978 part 2b)', () => {
  it('enqueues one job per erasure, and nothing when the transaction rolls back', async () => {
    await erasure('era_rollback');
    await expect(
      d.db.withWorkspace(d.workspace, async (tx) => {
        await enqueueErasureCleanupJob(tx, d.workspace, { erasureId: 'era_rollback', profileIds: ['prf_1'] });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await row('era_rollback')).toBeNull();

    await enqueue('era_once');
    // A repeated enqueue is a no-op: the erasure id is the job's identity.
    await d.db.withWorkspace(d.workspace, (tx) =>
      enqueueErasureCleanupJob(tx, d.workspace, { erasureId: 'era_once', profileIds: ['prf_else'] }),
    );
    expect(await row('era_once')).not.toBeNull();
    const { rows } = await d.db.admin.query<{ profile_ids: string[] }>(
      'SELECT profile_ids FROM erasure_cleanup_jobs WHERE workspace_id = $1 AND erasure_id = $2',
      [d.workspace, 'era_once'],
    );
    expect(rows[0]?.profile_ids).toEqual(['prf_era_once']);
  });

  it('claims with a lease, checkpoints each store, and purges the selectors when complete', async () => {
    await enqueue('era_claim');
    const claim = (await claimFor('era_claim'))!;
    expect(claim).toMatchObject({ workspaceId: d.workspace, erasureId: 'era_claim', attempts: 1 });
    expect(claim.claimToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(claim.selectors).toEqual(selectors);
    expect(claim.selectorKey).toEqual(selectorKey);
    expect(claim.selectorKek).toBe('local-test');
    const claimed = (await row('era_claim'))!;
    expect(claimed.state).toBe('running');
    expect(claimed.lease_until!.getTime()).toBeGreaterThan(Date.now());
    expect(claimed.claim_token).toBe(claim.claimToken);

    await expect(markErasureCleanupCheckpoint(d.db, claim, 'clickhouse')).resolves.toBe(true);
    expect((await row('era_claim'))?.clickhouse_done).toBe(true);
    await expect(markErasureCleanupCheckpoint(d.db, claim, 'hotstate')).resolves.toBe(true);
    expect((await row('era_claim'))?.hotstate_done).toBe(true);

    await expect(completeErasureCleanup(d.db, claim)).resolves.toBe(true);
    const done = (await row('era_claim'))!;
    expect(done.state).toBe('complete');
    expect(done.completed_at).not.toBeNull();
    expect(done.lease_until).toBeNull();
    expect(done.claim_token).toBeNull();
    expect(done.selectors).toBeNull();
    expect(done.selector_key).toBeNull();
    expect(done.selector_kek).toBeNull();
    // A second completion is a no-op, not a new terminal write.
    await expect(completeErasureCleanup(d.db, claim)).resolves.toBe(false);
  });

  it('resumes a crashed claim on another worker and keeps its checkpoints', async () => {
    await enqueue('era_crash');
    const first = (await claimFor('era_crash'))!;
    expect(first.attempts).toBe(1);
    await markErasureCleanupCheckpoint(d.db, first, 'clickhouse');
    // The worker died after the ClickHouse deletion: the lease expires and another one claims it.
    await expireLease('era_crash');
    const second = (await claimFor('era_crash'))!;
    expect(second.attempts).toBe(2);
    expect(second.claimToken).not.toBe(first.claimToken);
    expect(second.clickhouseDone).toBe(true);
    expect(second.hotstateDone).toBe(false);
    await expect(completeErasureCleanup(d.db, second)).resolves.toBe(true);
  });

  it('fences a stale claim: it can neither renew, checkpoint, complete nor fail the reclaimer’s row', async () => {
    await enqueue('era_stale');
    const first = (await claimFor('era_stale'))!;
    await expireLease('era_stale');
    const second = (await claimFor('era_stale'))!;
    expect(second.claimToken).not.toBe(first.claimToken);

    await expect(renewErasureCleanupLease(d.db, first, 60_000)).resolves.toBe(false);
    await expect(markErasureCleanupCheckpoint(d.db, first, 'clickhouse')).resolves.toBe(false);
    await expect(completeErasureCleanup(d.db, first)).resolves.toBe(false);
    await expect(failErasureCleanup(d.db, first, new Error('the old worker failed late'))).resolves.toBe('stale');
    const owned = (await row('era_stale'))!;
    expect(owned.state).toBe('running');
    expect(owned.claim_token).toBe(second.claimToken);
    expect(owned.last_error).toBeNull();

    await expect(completeErasureCleanup(d.db, second)).resolves.toBe(true);
    expect((await row('era_stale'))?.state).toBe('complete');
  });

  it('backs off after a failure and stops after the attempt bound', async () => {
    await enqueue('era_retry');
    const first = (await claimFor('era_retry'))!;
    await failErasureCleanup(d.db, first, new Error('ClickHouse unavailable\n\tretry later'));
    const retried = (await row('era_retry'))!;
    expect(retried.state).toBe('pending_external');
    expect(retried.last_error).toBe('ClickHouse unavailable retry later');
    expect(retried.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
    // Attempt 1 backs off 5 s, and checkpoints are kept for the rerun.
    expect(await claimFor('era_retry')).toBeUndefined();

    await makeDue('era_retry');
    const second = (await claimFor('era_retry'))!;
    expect(second.attempts).toBe(2);
    await failErasureCleanup(d.db, second, new Error('still broken'), { maxAttempts: 2 });
    const failed = (await row('era_retry'))!;
    expect(failed.state).toBe('failed');
    expect(failed.attempts).toBe(2);
    expect(await claimFor('era_retry')).toBeUndefined();
  });

  it('defers a blocked job without spending its attempt budget', async () => {
    await enqueue('era_defer');
    const claim = (await claimFor('era_defer'))!;
    await markErasureCleanupCheckpoint(d.db, claim, 'clickhouse');
    await expect(deferErasureCleanup(d.db, claim, 30)).resolves.toBe(true);
    const deferred = (await row('era_defer'))!;
    expect(deferred.state).toBe('pending_external');
    expect(deferred.attempts).toBe(0);
    expect(deferred.clickhouse_done).toBe(true);
    expect(deferred.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
    await makeDue('era_defer');
    expect((await claimFor('era_defer'))?.attempts).toBe(1);
  });

  it('resets checkpoints when a late publisher needs the sweep again', async () => {
    await enqueue('era_reset');
    const claim = (await claimFor('era_reset'))!;
    await markErasureCleanupCheckpoint(d.db, claim, 'clickhouse');
    await resetErasureCleanupCheckpoints(d.db, claim);
    const reset = (await row('era_reset'))!;
    expect(reset.clickhouse_done).toBe(false);
    expect(reset.hotstate_done).toBe(false);
  });

  it('waits for undelivered outbox rows for the erased profiles, then drops only failed ones', async () => {
    await enqueue('era_barrier', ['prf_erased_a', 'prf_erased_b']);
    await d.db.admin.query(
      `INSERT INTO outbox (workspace_id, id, kind, payload, operation_key, state)
       VALUES
         ($1, 'obx_pending_event', 'message_event',
          '{"events":[{"profileId":"prf_erased_a"}]}', 'barrier-a', 'pending'),
         ($1, 'obx_delivering_doi', 'doi_send',
          '{"profileId":"prf_erased_b","idempotencyKey":"doi:x"}', 'barrier-b', 'delivering'),
         ($1, 'obx_failed_event', 'message_event',
          '{"events":[{"profileId":"prf_erased_a"}]}', 'barrier-c', 'failed'),
         ($1, 'obx_other', 'message_event',
          '{"events":[{"profileId":"prf_someone_else"}]}', 'barrier-d', 'pending'),
         ($1, 'obx_doi_other', 'doi_send', '{"profileId":"prf_someone_else"}', 'barrier-e', 'delivering')`,
      [d.workspace],
    );
    await expect(erasureOutboxOutstanding(d.db, d.workspace, ['prf_erased_a', 'prf_erased_b'])).resolves.toBe(2);

    await d.db.admin.query("UPDATE outbox SET state = 'delivered' WHERE operation_key = 'barrier-a'");
    await expect(erasureOutboxOutstanding(d.db, d.workspace, ['prf_erased_a', 'prf_erased_b'])).resolves.toBe(1);

    // A failed row cannot block completion, but it must not be requeued later either.
    await expect(dropErasedProfileOutbox(d.db, d.workspace, ['prf_erased_a', 'prf_erased_b'])).resolves.toBe(1);
    const left = await d.db.admin.query<{ operation_key: string }>(
      `SELECT operation_key FROM outbox WHERE workspace_id = $1 ORDER BY operation_key`,
      [d.workspace],
    );
    expect(left.rows.map((r) => r.operation_key)).toEqual(['barrier-a', 'barrier-b', 'barrier-d', 'barrier-e']);
  });

  it('backs off on a bounded schedule', () => {
    expect(erasureCleanupRetrySeconds(1)).toBe(5);
    expect(erasureCleanupRetrySeconds(2)).toBe(10);
    expect(erasureCleanupRetrySeconds(20)).toBe(3600);
  });

  it('isolates jobs per workspace under row-level security', async () => {
    const other = '00000000-0000-4000-8000-0000000000bb';
    await d.db.admin.query("INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, 'Other', 'none')", [other]);
    await d.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, 'era_other', '{prf_other}', 'tester', 'other', '{"profiles":1}')`,
      [other],
    );
    await d.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs (workspace_id, erasure_id, profile_ids, selectors, selector_key, selector_kek)
       VALUES ($1, 'era_other', '{prf_other}', $2, $3, 'local-test')`,
      [other, selectors, selectorKey],
    );

    const appUrl = new URL(d.url.toString());
    appUrl.username = APP_ROLE.appRole;
    appUrl.password = APP_ROLE.appRolePassword;
    const appDb = createDb({ adminUrl: d.url.toString(), appUrl: appUrl.toString(), poolSize: 1 });
    const pool = new pg.Pool({ connectionString: appUrl.toString() });
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [d.workspace]);
        const own = await client.query<{ erasure_id: string }>('SELECT erasure_id FROM erasure_cleanup_jobs ORDER BY erasure_id');
        expect(own.rows.map((r) => r.erasure_id)).not.toContain('era_other');
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      // The app role cannot delete another workspace's job even by naming it.
      const deleted = await appDb.withWorkspace(d.workspace, (tx) =>
        tx.execute(sql`DELETE FROM erasure_cleanup_jobs WHERE erasure_id = 'era_other'`),
      );
      expect(Number((deleted as { rowCount?: number }).rowCount ?? 0)).toBe(0);
    } finally {
      await pool.end();
      await appDb.close();
    }
    const still = await d.db.admin.query("SELECT 1 FROM erasure_cleanup_jobs WHERE workspace_id = $1 AND erasure_id = 'era_other'", [
      other,
    ]);
    expect(still.rowCount).toBe(1);
  });
});
