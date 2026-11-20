import { requeueFailedOutbox } from '@agentic-marketing/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../../packages/db/test/disposable';
import { operationalHealthChecks } from '../src/ops/checks';

// #978 part 2 review: a long ClickHouse outage must show up in `am doctor` and be recoverable.
// The check reports the failed count and the oldest waiting age; `am outbox` requeues dead letters.

let d: Awaited<ReturnType<typeof createDisposableDb>>;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('outbox_ops');
}, 120_000);

afterAll(async () => {
  await d?.close();
});

const outboxCheck = async () => (await operationalHealthChecks(d.db)).find((check) => check.id === 'queue.outbox');

describe.skipIf(!hasTestDatabase())('outbox operations (#978 part 2 review)', () => {
  it('warns on failed rows and on a queue that has waited too long', async () => {
    await d.db.admin.query(
      `INSERT INTO outbox (workspace_id, id, kind, payload, operation_key, state, attempts, failure_kind, created_at, last_error)
       VALUES ($1, 'obx_ops_pending', 'message_event', '{}', 'ops-pending', 'pending', 1, NULL, now() - interval '20 minutes', NULL),
              ($1, 'obx_ops_failed', 'doi_send', '{}', 'ops-failed', 'failed', 36, 'exhausted', now() - interval '2 hours', 'ClickHouse unavailable')`,
      [d.workspace],
    );
    const check = await outboxCheck();
    expect(check).toMatchObject({ status: 'warn' });
    expect(check?.message).toContain('1 outbox row(s) failed after their retries');
    expect(check?.message).toContain('1 waiting');
    expect(check?.message).toContain('20 min');
    expect(check?.hint).toContain('am outbox');
  });

  it('requeues transient failures, reports a skipped permanent one and then reports an empty queue', async () => {
    await expect(requeueFailedOutbox(d.db, { kind: 'doi_send' })).resolves.toEqual({ requeued: 1, skippedPermanent: 0 });
    await d.db.admin.query(`UPDATE outbox SET created_at = now() WHERE workspace_id = $1`, [d.workspace]);
    const { rows } = await d.db.admin.query<{ state: string; attempts: number }>(
      `SELECT state, attempts FROM outbox WHERE workspace_id = $1 AND operation_key = 'ops-failed'`,
      [d.workspace],
    );
    expect(rows[0]).toEqual({ state: 'pending', attempts: 0 });

    // The row is fresh and due, so a doctor run before the dispatcher's next round reports it as
    // waiting but not as a warning.
    const check = await outboxCheck();
    expect(check?.status).toBe('ok');
    expect(check?.message).toContain('2 outbox row(s) publishing');

    // A malformed payload is dead-lettered as permanent and left alone unless explicitly included.
    await d.db.admin.query(
      `INSERT INTO outbox (workspace_id, id, kind, payload, operation_key, state, attempts, failure_kind, last_error)
       VALUES ($1, 'obx_ops_bad', 'message_event', '{"events":[{}]}', 'ops-bad', 'failed', 1, 'permanent', 'message_event payload is invalid: events.0')`,
      [d.workspace],
    );
    await expect(requeueFailedOutbox(d.db)).resolves.toEqual({ requeued: 0, skippedPermanent: 1 });
    await expect(requeueFailedOutbox(d.db, { includePermanent: true })).resolves.toEqual({ requeued: 1, skippedPermanent: 0 });
  });

  it('reports erasure cleanup backlog and failures, and an empty queue as ok', async () => {
    const erasureCheck = async () => (await operationalHealthChecks(d.db)).find((check) => check.id === 'queue.erasureCleanup');
    expect((await erasureCheck())?.status).toBe('ok');

    await d.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs (workspace_id, erasure_id, profile_ids, state, attempts, created_at, last_error)
       VALUES ($1, 'era_ops_pending', '{prf_ops_pending}', 'pending_external', 1, now() - interval '20 minutes', NULL),
              ($1, 'era_ops_failed', '{prf_ops_failed}', 'failed', 36,
               now() - interval '2 hours', 'ClickHouse unavailable')`,
      [d.workspace],
    );
    const check = await erasureCheck();
    expect(check).toMatchObject({ status: 'warn' });
    expect(check?.message).toContain('1 erasure cleanup job(s) failed after their retries (1 before their exclusion published, 0 after)');
    expect(check?.message).toContain('1 waiting');
    expect(check?.hint).toContain('ClickHouse');
    // 0.17 semantics: an unpublished exclusion means reads still return the person (#1062).
    expect(check?.hint).toContain('reads still return the person');
    expect(check?.hint).toContain('periodic publication pass');
    expect(check?.hint).not.toContain('not re-opened automatically');

    // A job that failed after it published is excluded from reads but is never re-opened: the
    // hint must not promise a self-heal for it (#1095 review).
    await d.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs (workspace_id, erasure_id, profile_ids, state, attempts, created_at, last_error, published_at)
       VALUES ($1, 'era_ops_failed_published', '{prf_ops_failed_published}', 'failed', 36, now() - interval '2 hours', 'Valkey unavailable', now())`,
      [d.workspace],
    );
    const both = await erasureCheck();
    expect(both?.message).toContain('2 erasure cleanup job(s) failed after their retries (1 before their exclusion published, 1 after)');
    expect(both?.hint).toContain('already excluded from reads');
    expect(both?.hint).toContain('not re-opened automatically');

    await d.db.admin.query("UPDATE erasure_cleanup_jobs SET state = 'complete' WHERE workspace_id = $1", [d.workspace]);
    expect((await erasureCheck())?.status).toBe('ok');
  });

  it('reports erasure exclusion and physical purge separately from the cleanup queue', async () => {
    const check = async (id: string) => (await operationalHealthChecks(d.db)).find((entry) => entry.id === id);
    expect((await check('privacy.erasureExclusion'))?.status).toBe('ok');
    expect((await check('queue.erasurePurge'))?.status).toBe('ok');

    // A ledger row with no publication is a real exclusion backlog even when no cleanup job waits.
    await d.db.admin.query(
      `INSERT INTO erasures (workspace_id, id, profile_ids, requested_by, reason, counts)
       VALUES ($1, 'era_ops_unpublished', '{prf_ops_unpublished}', 'tester', 'ops test', '{"profiles":1}'),
              ($1, 'era_ops_unavailable', '{prf_ops_unavailable}', 'tester', 'ops test', '{"profiles":1}'),
              ($1, 'era_ops_jobless', '{prf_ops_jobless}', 'tester', 'ops test', '{"profiles":1}')`,
      [d.workspace],
    );
    await d.db.admin.query(
      `INSERT INTO erasure_keys (workspace_id, kind, key_value, key_version, erasure_id, coverage)
       VALUES ($1, 'profile', 'hash-unpublished', 'dk_ops', 'era_ops_unpublished', 'full'),
              ($1, 'email', 'matching-only', 'dk_ops', 'era_ops_unavailable', 'unavailable'),
              ($1, 'profile', 'hash-jobless', 'dk_ops', 'era_ops_jobless', 'full')`,
      [d.workspace],
    );
    await d.db.admin.query(
      `INSERT INTO erasure_cleanup_jobs (workspace_id, erasure_id, profile_ids, state)
       VALUES ($1, 'era_ops_unpublished', '{prf_ops_unpublished}', 'pending_external')`,
      [d.workspace],
    );
    const exclusion = await check('privacy.erasureExclusion');
    expect(exclusion).toMatchObject({ status: 'warn' });
    // The job-less ledger erasure counts too: publication, not a cleanup queue row, is the signal.
    expect(exclusion?.message).toContain('2 erasure(s) have ledger keys that are not published yet');
    expect(exclusion?.message).toContain('unavailable');

    await d.db.admin.query('INSERT INTO erasure_generations (workspace_id, generation, purged_generation) VALUES ($1, 2, 0)', [
      d.workspace,
    ]);
    const purge = await check('queue.erasurePurge');
    expect(purge).toMatchObject({ status: 'warn' });
    expect(purge?.message).toContain('1 workspace(s) have a physical purge due');

    // A completed generation is not enough: a sweep that stopped running is stale and must warn.
    await d.db.admin.query(
      `UPDATE erasure_generations
          SET purged_generation = 2, purge_last_sweep_at = now() - interval '1 hour'
        WHERE workspace_id = $1`,
      [d.workspace],
    );
    expect((await check('queue.erasurePurge'))?.status).toBe('warn');
    await d.db.admin.query('UPDATE erasure_generations SET purge_last_sweep_at = now() WHERE workspace_id = $1', [d.workspace]);
    expect((await check('queue.erasurePurge'))?.status).toBe('ok');
  });

  it('names the journey triggers a too-old outbox row can no longer deliver (#1027 review)', async () => {
    // The journey hook refuses an event received more than seven days ago, and a queued row keeps
    // the age it had when it was written. `am outbox` can requeue such a row, but the trigger in it
    // stays refused, so the check has to say so instead of only reporting a backlog.
    await d.db.admin.query(
      `INSERT INTO outbox (workspace_id, id, kind, payload, operation_key, state, attempts, failure_kind, created_at, last_error)
       VALUES ($1, 'obx_ops_stale', 'message_event', '{}', 'ops-stale', 'failed', 1, 'exhausted',
               now() - interval '8 days', 'ClickHouse unavailable')`,
      [d.workspace],
    );

    const failed = await outboxCheck();
    expect(failed).toMatchObject({ status: 'warn' });
    expect(failed?.message).toContain('outbox row(s) failed after their retries');
    expect(failed?.message).toContain('1 row(s) are older than the 7-day journey delivery bound');
    expect(failed?.message).toContain('journey triggers in them will be ignored');
    expect(failed?.message).toContain('re-enrol segment journeys with `journeys.enrollSegment`');

    // Requeueing resets the attempts, not the row's age: the note must survive it.
    await expect(requeueFailedOutbox(d.db, { kind: 'message_event' })).resolves.toEqual({ requeued: 1, skippedPermanent: 0 });
    const pending = await outboxCheck();
    expect(pending).toMatchObject({ status: 'warn' });
    expect(pending?.message).toContain('1 row(s) are older than the 7-day journey delivery bound');
    expect(pending?.message).toContain('journey triggers in them will be ignored');
  });
});
