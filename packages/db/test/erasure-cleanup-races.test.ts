import { afterAll, describe, expect, it } from 'vitest';
import {
  dropErasedProfileOutbox,
  erasureCleanupFailure,
  erasureOutboxOutstanding,
  formatErasureCleanupFailure,
} from '../src/erasureCleanup';
import { claimOutboxBatch, requeueFailedOutbox } from '../src/outbox';
import type { Db } from '../src/pool';
import { createDisposableDb, type DisposableDb, hasTestDatabase } from './disposable';

// #978 part 2b review: the cleanup must mutate the outbox atomically. A row that another process
// requeues and claims, or that two erasures filter at once, must never lose an in-flight claim or
// restore an erased person's entry. These use a wrapped admin pool to interleave exactly at the
// statement boundary, so no sleep or scheduler timing is involved.

const open: DisposableDb[] = [];
afterAll(async () => {
  for (const d of open) await d.close();
});

const wrapped = (inner: Db, hook: (sql: string, args: unknown[]) => Promise<void>): Db =>
  ({
    admin: {
      query: async (sql: string, args: unknown[]) => {
        await hook(sql, args);
        return inner.admin.query(sql, args);
      },
    },
  }) as unknown as Db;

describe.skipIf(!hasTestDatabase())('erasure outbox cleanup races (#978 part 2b review)', () => {
  it('does not remove an outbox row that became an in-flight claim before the delete', async () => {
    const d = await createDisposableDb('erasure_race_claim');
    open.push(d);
    await d.db.admin.query(
      `INSERT INTO outbox (workspace_id, id, kind, payload, operation_key, state, failure_kind)
       VALUES ($1, 'obx_race', 'message_event', '{"events":[{"profileId":"prf_erased"}]}', 'race', 'failed', 'exhausted')`,
      [d.workspace],
    );
    let claimed = 0;
    let interleaved = false;
    const db = wrapped(d.db, async (sql) => {
      if (interleaved || !sql.trimStart().startsWith('DELETE FROM outbox')) return;
      interleaved = true;
      // An operator requeues the dead letter and a dispatcher claims it just before the delete.
      await requeueFailedOutbox(d.db);
      claimed = (await claimOutboxBatch(d.db)).filter((c) => c.workspaceId === d.workspace).length;
    });
    await expect(dropErasedProfileOutbox(db, d.workspace, ['prf_erased'])).resolves.toBe(0);
    expect(claimed).toBe(1);
    expect(await erasureOutboxOutstanding(d.db, d.workspace, ['prf_erased'])).toBe(1);
    const row = await d.db.admin.query<{ state: string }>("SELECT state FROM outbox WHERE operation_key = 'race'");
    expect(row.rows[0]?.state).toBe('delivering');
  });

  it('does not restore an entry another erasure removed from the same mixed batch', async () => {
    const d = await createDisposableDb('erasure_race_mixed');
    open.push(d);
    await d.db.admin.query(
      `INSERT INTO outbox (workspace_id, id, kind, payload, operation_key, state)
       VALUES ($1, 'obx_mixed', 'message_event',
               '{"events":[{"profileId":"prf_a"},{"profileId":"prf_b"},{"profileId":"prf_c"}]}', 'mixed', 'delivered')`,
      [d.workspace],
    );
    let interleaved = false;
    const db = wrapped(d.db, async (sql) => {
      if (interleaved || !sql.trimStart().startsWith('UPDATE outbox')) return;
      interleaved = true;
      // The other erased person's job filters the batch between this job's delete and update.
      await dropErasedProfileOutbox(d.db, d.workspace, ['prf_b']);
    });
    await dropErasedProfileOutbox(db, d.workspace, ['prf_a']);
    const row = await d.db.admin.query<{ payload: { events: { profileId: string }[] } }>(
      "SELECT payload FROM outbox WHERE workspace_id = $1 AND operation_key = 'mixed'",
      [d.workspace],
    );
    expect(row.rows[0]?.payload.events).toEqual([{ profileId: 'prf_c' }]);
  });

  it('preserves unrelated entries in a failed mixed batch for a later requeue', async () => {
    const d = await createDisposableDb('erasure_failed_mixed');
    open.push(d);
    await d.db.admin.query(
      `INSERT INTO outbox (workspace_id, id, kind, payload, operation_key, state, failure_kind)
       VALUES ($1, 'obx_failed_mixed', 'message_event',
               '{"events":[{"profileId":"prf_a"},{"profileId":"prf_c"}]}', 'mixed-failed', 'failed', 'exhausted')`,
      [d.workspace],
    );
    await dropErasedProfileOutbox(d.db, d.workspace, ['prf_a']);
    const row = await d.db.admin.query<{ payload: { events: { profileId: string }[] } }>(
      "SELECT payload FROM outbox WHERE workspace_id = $1 AND operation_key = 'mixed-failed'",
      [d.workspace],
    );
    expect(row.rows[0]?.payload.events).toEqual([{ profileId: 'prf_c' }]);
  });

  it('reports only an allowlisted error class, never a name supplied by the provider', () => {
    const err = new Error('provider failure');
    err.name = 'anon-person-12345';
    const failure = erasureCleanupFailure(err, 'clickhouse_error');
    expect(failure.errorClass).toBe('other');
    expect(formatErasureCleanupFailure(failure)).toBe('clickhouse_error (other)');
    expect(formatErasureCleanupFailure(failure)).not.toContain('anon-person-12345');

    const known = new TypeError('bad shape');
    expect(formatErasureCleanupFailure(erasureCleanupFailure(known, 'hot_state_error'))).toBe('hot_state_error (TypeError)');
    const timeout = new Error('slow');
    timeout.name = 'TimeoutError';
    expect(formatErasureCleanupFailure(erasureCleanupFailure(timeout, 'clickhouse_error'))).toBe('timeout (TimeoutError)');
  });
});
