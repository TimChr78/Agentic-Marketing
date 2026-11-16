import { createDb, type Db } from '@agentic-marketing/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDisposableDb, type DisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { createExecutor, defineCommand, type Executor, userPrincipal } from '../src';

// #976: an idempotency key is remembered for 30 days. A 29-day-old key still replays its stored
// response; a 31-day-old one no longer does, so its request runs again and stores a fresh row
// under the same key. The row belongs to the workspace and the caller, as before.

let d: DisposableDb;
let db: Db;
let executor: Executor;
let runs = 0;

const command = defineCommand({
  name: 'test.idempotentWrite',
  title: 'An idempotent write',
  description: 'A write command for the idempotency retention test.',
  input: z.object({ value: z.string() }),
  output: z.object({ run: z.number().int(), value: z.string() }),
  permission: null,
  effect: 'write',
  actionClass: 'draft',
  handler: async (input) => ({ run: ++runs, value: input.value }),
});

const principal = () => userPrincipal('usr_retention', d?.workspace ?? '', 'owner');

/** Move the stored key outside the retention window, as time passing would. */
async function ageKey(key: string, days: number) {
  await d.db.admin.query(
    `UPDATE idempotency_keys SET created_at = now() - make_interval(days => $1) WHERE workspace_id = $2 AND key = $3`,
    [days, d.workspace, key],
  );
}

async function row(key: string) {
  const { rows } = await d.db.admin.query<{ response: { run: number }; created_at: Date; input_hash: string }>(
    'SELECT response, created_at, input_hash FROM idempotency_keys WHERE workspace_id = $1 AND key = $2',
    [d.workspace, key],
  );
  return rows[0];
}

describe.skipIf(!hasTestDatabase())('idempotency key retention (#976)', () => {
  beforeAll(async () => {
    d = await createDisposableDb('cmd_idem_retention');
    db = createDb({ adminUrl: d.url.toString(), appUrl: d.url.toString(), poolSize: 2 });
    executor = createExecutor(db, { serverVersion: 'test', strictInputs: true });
  });

  afterAll(async () => {
    await db?.close();
    await d?.close();
  });

  beforeEach(() => {
    runs = 0;
  });

  it('replays a key that is 29 days old', async () => {
    const key = 'retention-29-days';
    expect(await executor.execute(command, { value: 'a' }, principal(), { surface: 'rest', idempotencyKey: key })).toEqual({
      run: 1,
      value: 'a',
    });
    await ageKey(key, 29);

    // A retry inside the window answers the stored response and does not run the handler again.
    expect(await executor.execute(command, { value: 'a' }, principal(), { surface: 'rest', idempotencyKey: key })).toEqual({
      run: 1,
      value: 'a',
    });
    expect(runs).toBe(1);
    expect((await row(key))?.response).toEqual({ run: 1, value: 'a' });
  });

  it('runs a key that is 31 days old again and stores a fresh row', async () => {
    const key = 'retention-31-days';
    const first = await executor.execute(command, { value: 'a' }, principal(), { surface: 'rest', idempotencyKey: key });
    expect(first).toEqual({ run: 1, value: 'a' });
    await ageKey(key, 31);

    const second = await executor.execute(command, { value: 'a' }, principal(), { surface: 'rest', idempotencyKey: key });
    expect(second).toEqual({ run: 2, value: 'a' });
    expect(runs).toBe(2);

    const stored = await row(key);
    expect(stored?.response).toEqual({ run: 2, value: 'a' });
    // The expired row was replaced, not duplicated: same key, one row, a new created_at.
    const { rows } = await d.db.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM idempotency_keys WHERE workspace_id = $1 AND key = $2',
      [d.workspace, key],
    );
    expect(rows[0]?.n).toBe(1);
    expect(Date.now() - (stored?.created_at.getTime() ?? 0)).toBeLessThan(60_000);
  });

  it('accepts a different request under a key the retention expired, instead of a reused conflict', async () => {
    const key = 'retention-different-input';
    await executor.execute(command, { value: 'a' }, principal(), { surface: 'rest', idempotencyKey: key });
    const before = await row(key);
    await ageKey(key, 31);

    await expect(executor.execute(command, { value: 'b' }, principal(), { surface: 'rest', idempotencyKey: key })).resolves.toEqual({
      run: 2,
      value: 'b',
    });
    const after = await row(key);
    expect(after?.input_hash).not.toBe(before?.input_hash);
    expect(after?.response).toEqual({ run: 2, value: 'b' });
  });
});
