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
      `INSERT INTO outbox (workspace_id, id, kind, payload, operation_key, state, attempts, created_at, last_error)
       VALUES ($1, 'obx_ops_pending', 'message_event', '{}', 'ops-pending', 'pending', 1, now() - interval '20 minutes', NULL),
              ($1, 'obx_ops_failed', 'doi_send', '{}', 'ops-failed', 'failed', 36, now() - interval '2 hours', 'ClickHouse unavailable')`,
      [d.workspace],
    );
    const check = await outboxCheck();
    expect(check).toMatchObject({ status: 'warn' });
    expect(check?.message).toContain('1 outbox row(s) failed after their retries');
    expect(check?.message).toContain('1 waiting');
    expect(check?.message).toContain('20 min');
    expect(check?.hint).toContain('am outbox');
  });

  it('requeues dead letters for one kind and then reports an empty queue', async () => {
    await expect(requeueFailedOutbox(d.db, { kind: 'doi_send' })).resolves.toBe(1);
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
  });
});
