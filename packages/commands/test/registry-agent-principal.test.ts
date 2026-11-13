import type { Db } from '@agentic-marketing/db';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
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

describe('an agent principal without an agent record (#811)', () => {
  it('cannot run a write', async () => {
    await expect(executor.execute(write, { value: 'x' }, agentWithoutRecord, { surface: 'mcp' })).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining('agent record'),
    });
  });
});
