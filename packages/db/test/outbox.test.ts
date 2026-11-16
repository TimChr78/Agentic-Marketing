import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ackOutbox,
  claimOutboxBatch,
  enqueueOutbox,
  failOutbox,
  outboxRetrySeconds,
  pruneOutbox,
  sanitiseOutboxError,
} from '../src/outbox';
import { createDisposableDb, hasTestDatabase } from './disposable';

// The transactional outbox (#978 part 2): a short claim with a lease, at-least-once redelivery
// after a crash, bounded backoff, and delivery rows pruned on a retention. The tests move
// `next_attempt_at` and `lease_until` themselves, so no wall-clock sleep is involved.

let d: Awaited<ReturnType<typeof createDisposableDb>>;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('outbox');
}, 120_000);

afterAll(async () => {
  await d?.close();
});

const enqueue = (operationKey: string, payload: Record<string, unknown> = {}) =>
  d.db.withWorkspace(d.workspace, (tx) => enqueueOutbox(tx, d.workspace, { kind: 'test', payload, operationKey }));

const row = async (operationKey: string) => {
  const { rows } = await d.db.admin.query<{
    id: string;
    state: string;
    attempts: number;
    operation_key: string;
    payload: Record<string, unknown>;
    last_error: string | null;
    next_attempt_at: Date;
    lease_until: Date | null;
    delivered_at: Date | null;
  }>('SELECT * FROM outbox WHERE workspace_id = $1 AND operation_key = $2', [d.workspace, operationKey]);
  return rows[0] ?? null;
};

const makeDue = (operationKey: string) =>
  d.db.admin.query(`UPDATE outbox SET next_attempt_at = now() - interval '1 second' WHERE workspace_id = $1 AND operation_key = $2`, [
    d.workspace,
    operationKey,
  ]);

const expireLease = (operationKey: string) =>
  d.db.admin.query(`UPDATE outbox SET lease_until = now() - interval '1 second' WHERE workspace_id = $1 AND operation_key = $2`, [
    d.workspace,
    operationKey,
  ]);

describe.skipIf(!hasTestDatabase())('transactional outbox (#978 part 2)', () => {
  it('enqueues one row per operation key, and nothing when the transaction rolls back', async () => {
    const first = await enqueue('once', { n: 1 });
    const again = await enqueue('once', { n: 2 });
    expect(first.enqueued).toBe(true);
    expect(again.enqueued).toBe(false);
    expect((await row('once'))?.payload).toEqual({ n: 1 });

    await expect(
      d.db.withWorkspace(d.workspace, async (tx) => {
        await enqueueOutbox(tx, d.workspace, { kind: 'test', payload: {}, operationKey: 'rolled-back' });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await row('rolled-back')).toBeNull();
  });

  it('claims with a lease and acknowledges the delivery', async () => {
    await enqueue('claim');
    const claims = await claimOutboxBatch(d.db, { limit: 10, leaseMs: 60_000 });
    const claim = claims.find((c) => c.operationKey === 'claim')!;
    expect(claim).toMatchObject({ workspaceId: d.workspace, kind: 'test', attempts: 1 });
    const claimed = (await row('claim'))!;
    expect(claimed.state).toBe('delivering');
    expect(claimed.lease_until!.getTime()).toBeGreaterThan(Date.now());

    await ackOutbox(d.db, claim);
    const delivered = (await row('claim'))!;
    expect(delivered.state).toBe('delivered');
    expect(delivered.delivered_at).not.toBeNull();
    expect(delivered.lease_until).toBeNull();
  });

  it('redelivers a row whose lease expired, without a second enqueue', async () => {
    await enqueue('crash');
    const [first] = (await claimOutboxBatch(d.db, { limit: 50 })).filter((c) => c.operationKey === 'crash');
    expect(first.attempts).toBe(1);
    // The dispatcher died after claiming: the lease expires and another one takes the row.
    await expireLease('crash');
    const [second] = (await claimOutboxBatch(d.db, { limit: 50 })).filter((c) => c.operationKey === 'crash');
    expect(second.attempts).toBe(2);
    expect(second.id).toBe(first.id);
    expect((await row('crash'))?.attempts).toBe(2);
  });

  it('backs off after a failure and stops after the attempt bound', async () => {
    await enqueue('retry');
    const [claim] = (await claimOutboxBatch(d.db, { limit: 50 })).filter((c) => c.operationKey === 'retry');
    await failOutbox(d.db, claim, new Error('provider exploded\n  on line two'));
    const retried = (await row('retry'))!;
    expect(retried.state).toBe('pending');
    expect(retried.last_error).toBe('provider exploded on line two');
    expect(retried.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
    // Attempt 1 backs off 5 s; the row is not claimable until then.
    expect((await claimOutboxBatch(d.db, { limit: 50 })).some((c) => c.operationKey === 'retry')).toBe(false);

    await makeDue('retry');
    const [second] = (await claimOutboxBatch(d.db, { limit: 50 })).filter((c) => c.operationKey === 'retry');
    expect(second.attempts).toBe(2);
    await failOutbox(d.db, second, new Error('again'));
    const longer = (await row('retry'))!;
    expect(longer.next_attempt_at.getTime() - Date.now()).toBeGreaterThan(outboxRetrySeconds(1) * 1000 - 1000);

    await makeDue('retry');
    const [last] = (await claimOutboxBatch(d.db, { limit: 50 })).filter((c) => c.operationKey === 'retry');
    expect(last.attempts).toBe(3);
    await expect(failOutbox(d.db, last, new Error('still broken'), { maxAttempts: 3 })).resolves.toBe('failed');
    expect((await row('retry'))?.state).toBe('failed');
    expect((await claimOutboxBatch(d.db, { limit: 50 })).some((c) => c.operationKey === 'retry')).toBe(false);
  });

  it('prunes delivered rows after the retention and keeps failed ones', async () => {
    await d.db.admin.query(
      `INSERT INTO outbox (workspace_id, id, kind, payload, operation_key, state, delivered_at)
       VALUES ($1, 'obx_old', 'test', '{}', 'old', 'delivered', now() - interval '8 days'),
              ($1, 'obx_fresh', 'test', '{}', 'fresh', 'delivered', now()),
              ($1, 'obx_failed', 'test', '{}', 'failed-row', 'failed', NULL)`,
      [d.workspace],
    );
    expect(await pruneOutbox(d.db, 7)).toBe(1);
    expect(await row('old')).toBeNull();
    expect(await row('fresh')).not.toBeNull();
    expect(await row('failed-row')).not.toBeNull();
  });

  it('bounds and flattens the stored error text', () => {
    expect(sanitiseOutboxError(new Error('a\n\tb'))).toBe('a b');
    expect(sanitiseOutboxError('x'.repeat(900))).toHaveLength(500);
    expect(sanitiseOutboxError(new Error(''))).toBe('unknown error');
    expect(outboxRetrySeconds(1)).toBe(5);
    expect(outboxRetrySeconds(20)).toBe(3600);
  });
});
