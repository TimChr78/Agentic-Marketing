import { AppError } from '@agentic-marketing/core';
import { describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/pool';
import { createDisposableDb, type DisposableDb } from './disposable';

// #807: an idempotency waiter used to check out a pooled connection and then block in
// `pg_advisory_lock`. One holder plus `poolSize - 1` waiters took every connection, so a holder
// that needed another `withWorkspace` (an AI step's budget transactions, say) could never finish.
// The waiter now releases its connection between `pg_try_advisory_lock` attempts and gives up with
// `conflict` at a deadline; a failed acquisition destroys a connection whose lock state is unknown.

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Close pools and the database even when a test left a checked-out connection behind. */
async function dispose(db: Db, d: DisposableDb) {
  const closed = await Promise.race([
    db.close().then(
      () => true,
      () => true,
    ),
    sleep(2_000).then(() => false),
  ]);
  if (!closed) {
    // A deadlocked run leaves a checked-out client; terminate its backend so teardown finishes.
    await d.db.admin
      .query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()')
      .catch(() => {});
    await Promise.race([db.close().catch(() => {}), sleep(2_000)]);
  }
  await d.close().catch(() => {});
}

describe('idempotency advisory-lock waiting (#807)', () => {
  it('lets a holder open a nested withWorkspace while a waiter is waiting', async () => {
    const d = await createDisposableDb('advlock_nested');
    const db = createDb({ adminUrl: d.url.toString(), appUrl: d.url.toString(), poolSize: 2 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const holderReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const key = 'idempotency:nested-deadlock';
    try {
      const holder = db.withWorkspace(
        d.workspace,
        async () => {
          ready();
          await gate;
          // The lock holder needs a second connection; a waiter that held one while blocked
          // would deadlock the two-connection pool here.
          return db.withWorkspace(d.workspace, async () => 'nested');
        },
        { advisoryLockKey: key },
      );
      await holderReady;
      const waiter = db.withWorkspace(d.workspace, async () => 'waiter', { advisoryLockKey: key });
      // Give the waiter time to make its first attempt and back off, then let the holder continue.
      await sleep(150);
      release();
      const outcome = await Promise.race([Promise.all([holder, waiter]), sleep(3_000).then(() => 'timeout' as const)]);
      if (outcome === 'timeout') throw new Error('the nested withWorkspace deadlocked the pool');
      expect(outcome).toEqual(['nested', 'waiter']);
    } finally {
      release();
      await dispose(db, d);
    }
  }, 30_000);

  it('answers conflict past the deadline and holds no connection while waiting', async () => {
    const d = await createDisposableDb('advlock_deadline');
    const db = createDb({
      adminUrl: d.url.toString(),
      appUrl: d.url.toString(),
      poolSize: 2,
      advisoryLockTimeoutMillis: 400,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const holderReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const key = 'idempotency:deadline';
    let holder: Promise<string> | undefined;
    try {
      holder = db.withWorkspace(
        d.workspace,
        async () => {
          ready();
          await gate;
          return 'held';
        },
        { advisoryLockKey: key },
      );
      await holderReady;
      const waiter = db
        .withWorkspace(d.workspace, async () => 'waiter', { advisoryLockKey: key })
        .then(
          () => null,
          (err: unknown) => err,
        );

      // While the waiter backs off it must leave the other connection in the pool: idle 1 (the
      // holder has the other), waiting 0. Before the fix it held the second connection in
      // `pg_advisory_lock`, so idle was 0.
      let observed: { idle: number; waiting: number } | undefined;
      for (let i = 0; i < 80 && !observed; i++) {
        await sleep(10);
        if (db.app.idleCount >= 1 && db.app.waitingCount === 0) observed = { idle: db.app.idleCount, waiting: db.app.waitingCount };
      }
      expect(observed).toEqual({ idle: 1, waiting: 0 });

      const outcome = await Promise.race([waiter, sleep(3_000).then(() => 'timeout' as const)]);
      if (outcome === 'timeout') throw new Error('the waiter did not reach its deadline');
      expect(outcome).toBeInstanceOf(AppError);
      expect((outcome as AppError).code).toBe('conflict');
      expect((outcome as AppError).status).toBe(409);
      expect((outcome as AppError).message).toMatch(/same idempotency key|idempotency key/i);
    } finally {
      release();
      if (holder) await Promise.race([holder, sleep(1_000)]).catch(() => {});
      await dispose(db, d);
    }
  }, 30_000);

  it('destroys a connection whose lock acquisition failed, leaving no lock behind', async () => {
    const d = await createDisposableDb('advlock_fail');
    // Shadow the lock functions so the acquisition grants the session lock and then fails. The
    // failure leaves the lock on that backend; only destroying the connection releases it.
    await d.db.admin.query('CREATE SCHEMA lock_fail');
    await d.db.admin.query(
      `CREATE FUNCTION lock_fail.pg_try_advisory_lock(bigint) RETURNS boolean LANGUAGE plpgsql AS $$
       BEGIN PERFORM pg_catalog.pg_try_advisory_lock($1); RAISE EXCEPTION 'injected acquisition failure'; END $$`,
    );
    await d.db.admin.query(
      `CREATE FUNCTION lock_fail.pg_advisory_lock(bigint) RETURNS void LANGUAGE plpgsql AS $$
       BEGIN PERFORM pg_catalog.pg_advisory_lock($1); RAISE EXCEPTION 'injected acquisition failure'; END $$`,
    );
    const appUrl = new URL(d.url.toString());
    appUrl.searchParams.set('options', '-csearch_path=lock_fail,pg_catalog');
    const db = createDb({ adminUrl: d.url.toString(), appUrl: appUrl.toString(), poolSize: 1 });
    try {
      await expect(
        db.withWorkspace(d.workspace, async () => 'never', { advisoryLockKey: 'idempotency:acquisition-error' }),
      ).rejects.toThrow(/injected acquisition failure/);
      const { rows } = await d.db.admin.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE l.locktype = 'advisory' AND a.datname = current_database()`,
      );
      expect(rows[0].n).toBe(0);
    } finally {
      await dispose(db, d);
    }
  }, 30_000);
});
