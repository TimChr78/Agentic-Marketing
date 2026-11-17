import { createDb, type Db } from '@agentic-marketing/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { APP_ROLE, createDisposableDb, type DisposableDb, hasTestDatabase } from '../../db/test/disposable';
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
  const { rows } = await d.db.admin.query<{
    command: string;
    response: { run: number };
    created_at: Date;
    input_hash: string;
    reversed_at: Date | null;
  }>('SELECT command, response, created_at, input_hash, reversed_at FROM idempotency_keys WHERE workspace_id = $1 AND key = $2', [
    d.workspace,
    key,
  ]);
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

  afterEach(() => {
    vi.useRealTimers();
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

  // #975 gives the row `reversed_at` and an `idempotency_key_actions` link table (links cascade
  // with the key). Replacing an expired key must delete the old row rather than update it in
  // place, or the fresh result would inherit the old request's reversal and action links.
  it('deletes an expired row and its action links instead of carrying them into the fresh result', async () => {
    const key = 'retention-old-row-state';
    await executor.execute(command, { value: 'a' }, principal(), { surface: 'rest', idempotencyKey: key });

    // An agent action the stored response describes, linked as the executor links a real one.
    const { rows: actions } = await d.db.admin.query<{ id: number }>(
      `INSERT INTO agent_actions (workspace_id, agent_id, command, action_class, decision, ok, surface)
       VALUES ($1, 'agt_test', 'artifacts.requestPublish', 'content.publish', 'allow', true, 'rest')
       RETURNING id`,
      [d.workspace],
    );
    await d.db.admin.query('INSERT INTO idempotency_key_actions (workspace_id, key, agent_action_id) VALUES ($1, $2, $3)', [
      d.workspace,
      key,
      actions[0]!.id,
    ]);
    // Simulate agents.undo having run on the old row, and old stored state on the other columns.
    await d.db.admin.query(
      `UPDATE idempotency_keys
          SET command = 'test.aDifferentCommand', input_hash = 'hash-from-the-old-request',
              response = '{"run":99,"value":"old"}'::jsonb, reversed_at = now()
        WHERE workspace_id = $1 AND key = $2`,
      [d.workspace, key],
    );
    await ageKey(key, 31);
    expect((await row(key))?.reversed_at).not.toBeNull();

    await executor.execute(command, { value: 'b' }, principal(), { surface: 'rest', idempotencyKey: key });

    const { rows } = await d.db.admin.query<{
      command: string;
      input_hash: string;
      response: { run: number; value: string };
      reversed_at: Date | null;
      created_at: Date;
    }>('SELECT command, input_hash, response, reversed_at, created_at FROM idempotency_keys WHERE workspace_id = $1 AND key = $2', [
      d.workspace,
      key,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.command).toBe('test.idempotentWrite');
    expect(rows[0]?.input_hash).not.toBe('hash-from-the-old-request');
    expect(rows[0]?.response).toEqual({ run: 2, value: 'b' });
    expect(rows[0]?.reversed_at).toBeNull();
    expect(Date.now() - (rows[0]?.created_at.getTime() ?? 0)).toBeLessThan(60_000);

    // The old key's links went with the deleted row (ON DELETE CASCADE), so an undo of the old
    // action can no longer reach the fresh row, and the fresh key replays its own response.
    const { rows: links } = await d.db.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM idempotency_key_actions WHERE workspace_id = $1 AND key = $2',
      [d.workspace, key],
    );
    expect(links[0]?.n).toBe(0);
    await expect(executor.execute(command, { value: 'b' }, principal(), { surface: 'rest', idempotencyKey: key })).resolves.toEqual({
      run: 2,
      value: 'b',
    });
  });

  // The replacement deletes as the app role under row-level security, so 0104 grants DELETE
  // (0001 granted only SELECT, INSERT and UPDATE) and the tenant policy still confines it.
  it('replaces an expired row as the app role', async () => {
    const appUrl = new URL(d.url.toString());
    appUrl.username = APP_ROLE.appRole;
    appUrl.password = APP_ROLE.appRolePassword;
    const appDb = createDb({ adminUrl: d.url.toString(), appUrl: appUrl.toString(), poolSize: 2 });
    try {
      const asApp = createExecutor(appDb, { serverVersion: 'test', strictInputs: true });
      const key = 'retention-app-role';
      await asApp.execute(command, { value: 'a' }, principal(), { surface: 'rest', idempotencyKey: key });
      await ageKey(key, 31);
      await expect(asApp.execute(command, { value: 'b' }, principal(), { surface: 'rest', idempotencyKey: key })).resolves.toEqual({
        run: 2,
        value: 'b',
      });
      expect((await row(key))?.response).toEqual({ run: 2, value: 'b' });
    } finally {
      await appDb.close();
    }
  });

  // The cutoffs are computed by PostgreSQL, so an application process whose clock is off by a few
  // minutes changes nothing: the same 29-day key replays and the same 31-day key runs again.
  it('ignores a skewed application clock', async () => {
    for (const skewMinutes of [-10, 10]) {
      const replayKey = `clock-${skewMinutes}-replay`;
      const firstReplay = await executor.execute(command, { value: 'a' }, principal(), { surface: 'rest', idempotencyKey: replayKey });
      await ageKey(replayKey, 29);

      const expiredKey = `clock-${skewMinutes}-expired`;
      const firstExpired = await executor.execute(command, { value: 'a' }, principal(), { surface: 'rest', idempotencyKey: expiredKey });
      await ageKey(expiredKey, 31);

      const realNow = Date.now();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(realNow + skewMinutes * 60_000));
      try {
        expect(await executor.execute(command, { value: 'a' }, principal(), { surface: 'rest', idempotencyKey: replayKey })).toEqual(
          firstReplay,
        );
        const rerun = await executor.execute(command, { value: 'a' }, principal(), { surface: 'rest', idempotencyKey: expiredKey });
        expect(rerun).not.toEqual(firstExpired);
        expect(rerun.run).toBeGreaterThan(firstExpired.run);
      } finally {
        vi.useRealTimers();
      }
    }
  });
});
