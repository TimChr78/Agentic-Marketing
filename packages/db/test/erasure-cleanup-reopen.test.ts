import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { claimErasureCleanupJobs, enqueueUnpublishedErasures, runErasurePublicationBacklog } from '../src/erasureCleanup';
import { createDisposableDb, type DisposableDb, hasTestDatabase } from './disposable';

// #1219: a cleanup job that failed AFTER its exclusion was published had no exit from `failed`.
// `am doctor` and docs/deployment/operations.md told an operator to fix Valkey or ClickHouse and
// restart the scheduler role, but the only start-up pass required `published_at IS NULL` and the
// claim only takes `pending_external`/`running`. A scheduler start now re-opens exactly those jobs,
// with a fresh retry budget, once — not on every periodic pass, so a permanent outage is retried per
// start rather than forever.

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const open: DisposableDb[] = [];

afterAll(async () => {
  for (const db of open) await db.close().catch(() => {});
});

async function seedPublishedFailure(d: DisposableDb, erasureId: string, profile: string) {
  const workspace = d.workspace;
  await d.db.admin.query(
    `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
     VALUES ($1, $2, ARRAY[$3]::text[], 'user_test', 'reopen test', '{"profiles":1}')`,
    [workspace, erasureId, profile],
  );
  await d.db.admin.query(
    `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, coverage)
     VALUES ($1, 'profile', $2, 'dk_exclusion_test', $3, 'full')`,
    [workspace, hash(`${erasureId}:${profile}`), erasureId],
  );
  // Published on the first attempt, then the sweep or hot-state step failed until the budget ran
  // out, as after a Valkey outage.
  await d.db.admin.query(
    `INSERT INTO erasure_cleanup_jobs
       (workspace_id, erasure_id, profile_ids, state, attempts, last_error,
        published_generation, published_at, clickhouse_done, hotstate_done)
     VALUES ($1, $2, ARRAY[$3]::text[], 'failed', 36, 'hot_state_error (ReplyError)',
             3, now() - interval '1 day', true, false)`,
    [workspace, erasureId, profile],
  );
  return { workspace, erasureId, profile };
}

describe.skipIf(!hasTestDatabase())('re-opening an erasure cleanup job that failed after publishing (#1219)', () => {
  it('re-opens it once at scheduler start with a fresh attempt budget, keeping the publication', async () => {
    const d = await createDisposableDb('erasure_reopen_published');
    open.push(d);
    const { workspace, erasureId } = await seedPublishedFailure(
      d,
      'era_00000000000000000000000000012219',
      'prf_00000000000000000000000000012219',
    );

    // The periodic pass must not turn a permanent outage into an endless retry loop.
    expect(await enqueueUnpublishedErasures(d.db)).toBe(0);
    let { rows } = await d.db.admin.query<{ state: string }>(
      'SELECT state FROM erasure_cleanup_jobs WHERE workspace_id = $1 AND erasure_id = $2',
      [workspace, erasureId],
    );
    expect(rows[0]?.state).toBe('failed');

    const controller = new AbortController();
    const running = runErasurePublicationBacklog({ db: d.db }, controller.signal, { tickMs: 60_000 });
    try {
      const deadline = Date.now() + 10_000;
      let state = 'failed';
      while (Date.now() < deadline && state === 'failed') {
        ({ rows } = await d.db.admin.query<{ state: string }>(
          'SELECT state FROM erasure_cleanup_jobs WHERE workspace_id = $1 AND erasure_id = $2',
          [workspace, erasureId],
        ));
        state = rows[0]?.state ?? 'missing';
        if (state === 'failed') await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(state).toBe('pending_external');
    } finally {
      controller.abort();
      await running;
    }

    const { rows: job } = await d.db.admin.query<{
      state: string;
      attempts: number;
      published_at: Date | null;
      published_generation: number | string | null;
      clickhouse_done: boolean;
      hotstate_done: boolean;
    }>(
      `SELECT state, attempts, published_at, published_generation, clickhouse_done, hotstate_done
         FROM erasure_cleanup_jobs WHERE workspace_id = $1 AND erasure_id = $2`,
      [workspace, erasureId],
    );
    // Queued with a full budget, and the publication it already proved is not thrown away: the
    // worker skips publishing a job with `published_at` set and only redoes the unfinished store.
    expect(job[0]).toMatchObject({
      state: 'pending_external',
      attempts: 0,
      clickhouse_done: true,
      hotstate_done: false,
    });
    expect(Number(job[0]?.published_generation)).toBe(3);
    expect(job[0]?.published_at).toBeInstanceOf(Date);

    // And the worker can claim it, which was impossible from `failed`.
    const claims = await claimErasureCleanupJobs(d.db);
    expect(claims.map((c) => c.erasureId)).toContain(erasureId);
  }, 60_000);

  it('also gives a re-opened unpublished job a fresh budget instead of one attempt', async () => {
    const d = await createDisposableDb('erasure_reopen_unpublished');
    open.push(d);
    const erasureId = 'era_00000000000000000000000000012220';
    const profile = 'prf_00000000000000000000000000012220';
    await seedPublishedFailure(d, erasureId, profile);
    // The same job, but its publication never landed: the periodic pass re-opens it too.
    await d.db.admin.query(
      `UPDATE erasure_cleanup_jobs
          SET published_generation = NULL, published_at = NULL, attempts = 36
        WHERE workspace_id = $1 AND erasure_id = $2`,
      [d.workspace, erasureId],
    );
    expect(await enqueueUnpublishedErasures(d.db)).toBe(1);
    const { rows } = await d.db.admin.query<{ state: string; attempts: number }>(
      'SELECT state, attempts FROM erasure_cleanup_jobs WHERE workspace_id = $1 AND erasure_id = $2',
      [d.workspace, erasureId],
    );
    expect(rows[0]).toMatchObject({ state: 'pending_external', attempts: 0 });
  }, 60_000);
});
