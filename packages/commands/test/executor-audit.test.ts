import { createDb } from '@agentic-marketing/db';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { createExecutor, defineCommand, userPrincipal } from '../src';

// #818: only AppError failures used to reach the audit log. Any other exception (a driver error, a
// bug) rethrew with no entry, so a failed write left no trace. The executor now records a sanitized
// internal failure in its own transaction before rethrowing; the raw text never enters the log,
// because it can carry SQL, secrets or stack details.

const crashingWrite = defineCommand({
  name: 'test.expectCrash',
  title: 'Crash',
  description: 'A write whose handler throws an unexpected (non-AppError) exception.',
  input: z.object({}),
  output: z.object({}),
  permission: null,
  effect: 'write',
  actionClass: 'draft',
  handler: async () => {
    throw new Error('connection reset: password=hunter2');
  },
});

const current: Awaited<ReturnType<typeof createDisposableDb>>[] = [];
const pools: ReturnType<typeof createDb>[] = [];

afterAll(async () => {
  for (const db of pools) await db.close();
  for (const d of current) await d.close();
});

describe.skipIf(!hasTestDatabase())('an unexpected exception in the command executor', () => {
  it('is audited as a sanitized internal failure, then rethrown', async () => {
    const d = await createDisposableDb('cmd_audit');
    current.push(d);
    const db = createDb({ adminUrl: d.url.toString(), appUrl: d.url.toString(), poolSize: 2 });
    pools.push(db);
    const executor = createExecutor(db, { serverVersion: 'test', strictInputs: true });
    const principal = userPrincipal('user_1', d.workspace, 'owner');

    await expect(executor.execute(crashingWrite, {}, principal, { surface: 'rest' })).rejects.toThrow('connection reset');

    const { rows } = await d.db.admin.query<{ ok: boolean; error: string }>(
      "SELECT ok, error FROM audit_log WHERE workspace_id = $1 AND command = 'test.expectCrash'",
      [d.workspace],
    );
    expect(rows).toEqual([{ ok: false, error: 'internal: The command failed with an unexpected error.' }]);
    // The raw exception text (which could carry a secret) is nowhere in the entry.
    expect(rows[0]!.error).not.toContain('hunter2');
  });
});
