import { createDb, type Db } from '@agentic-marketing/db';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { createExecutor, defineCommand, type Principal, userPrincipal } from '../src';

// #811: an agent principal names its agent record. A surface that builds one without it (a new
// credential kind, a test helper, a future integration) must fail closed on a write: the policy
// engine, the status check, the limits and the ledger all key off that record, so running the
// command anyway would skip every one of them.

const write = defineCommand({
  name: 'test.write',
  title: 'A write',
  description: 'A write command for the executor test.',
  input: z.object({ value: z.string() }),
  output: z.object({ ok: z.boolean() }),
  permission: null,
  effect: 'write',
  actionClass: 'draft',
  handler: async () => ({ ok: true }),
});

/** What a surface that forgets the agent record builds: type agent, no `agent`. */
const agentWithoutRecord = { ...userPrincipal('usr_1', 'ws_1', 'owner'), type: 'agent' } as unknown as Principal;

/** The executor must never reach the database for this refusal; a throw here would fail the test. */
const db = {
  withWorkspace: async () => {
    throw new Error('the executor opened a transaction for an agent without an agent record');
  },
} as unknown as Db;

const executor = createExecutor(db, { serverVersion: 'test', strictInputs: true });

const read = defineCommand({
  name: 'test.readAgent',
  title: 'A read',
  description: 'A read command for the missing-agent-record test.',
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  permission: null,
  effect: 'read',
  handler: async () => ({ ok: true }),
});

describe('an agent principal without an agent record (#811)', () => {
  it('cannot run a write', async () => {
    await expect(executor.execute(write, { value: 'x' }, agentWithoutRecord, { surface: 'mcp' })).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining('agent record'),
    });
  });
});

// #906 review round 3: the caller identity for the idempotency hash must be derived after the
// missing-record guard. A read from an agent without a record is supported, so it may carry a key
// and must not dereference `principal.agent`.
describe.skipIf(!hasTestDatabase())('a key on a read from an agent without a record', () => {
  const disposables: Awaited<ReturnType<typeof createDisposableDb>>[] = [];
  const pools: ReturnType<typeof createDb>[] = [];

  afterAll(async () => {
    for (const pool of pools) await pool.close();
    for (const d of disposables) await d.close();
  });

  it('replays without throwing and stores one caller-bound row', async () => {
    const d = await createDisposableDb('cmd_agent_read');
    disposables.push(d);
    const db = createDb({ adminUrl: d.url.toString(), appUrl: d.url.toString(), poolSize: 2 });
    pools.push(db);
    const rich = createExecutor(db, { serverVersion: 'test', strictInputs: true });
    const principal = { ...userPrincipal('usr_1', d.workspace, 'owner'), type: 'agent' } as unknown as Principal;
    expect(await rich.execute(read, {}, principal, { surface: 'mcp', idempotencyKey: 'agent-read-1' })).toEqual({ ok: true });
    expect(await rich.execute(read, {}, principal, { surface: 'mcp', idempotencyKey: 'agent-read-1' })).toEqual({ ok: true });
    const { rows } = await d.db.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM idempotency_keys WHERE workspace_id = $1 AND key = $2',
      [d.workspace, 'agent-read-1'],
    );
    expect(rows[0]!.n).toBe(1);
  });
});
