import { AppError } from '@agentic-marketing/core';
import { createDb } from '@agentic-marketing/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { APP_ROLE, createDisposableDb, type DisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { agentPrincipal, createExecutor, defineCommand, type Executor, userPrincipal } from '../src';

// #1300: a failed profile-bound AI command could store the provider's own message in the audit log
// and the agent ledger, and a provider may quote the person's data back in that message. A command
// that declares `failureText` records that fixed diagnostic instead, while the caller still gets
// its own error. The copy is shared by both stores, so one rule covers the audit log and the ledger.

const SENTINEL = 'provider said: Ada Lovelace <ada@example.com>';
const FIXED = 'the AI provider refused or failed';

const providerBound = defineCommand({
  name: 'test.providerBoundFailure',
  title: 'A profile-bound AI failure',
  description: 'A test-only write whose failure text may quote the person it was about.',
  input: z.object({ profileId: z.string() }),
  output: z.object({ ok: z.literal(true) }),
  permission: null,
  effect: 'write',
  actionClass: 'draft',
  failureText: FIXED,
  handler: async () => {
    throw new AppError('conflict', SENTINEL);
  },
});

const ordinary = defineCommand({
  name: 'test.ordinaryFailure',
  title: 'An ordinary failure',
  description: 'A test-only write without a fixed failure text.',
  input: z.object({}),
  output: z.object({ ok: z.literal(true) }),
  permission: null,
  effect: 'write',
  actionClass: 'draft',
  handler: async () => {
    throw new AppError('conflict', 'the artifact is still published');
  },
});

let d: DisposableDb;
let db: ReturnType<typeof createDb>;
let executor: Executor;
let agentId = '';
const workspaceId = () => d.workspace;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('cmd_failure_text', { appRole: APP_ROLE.appRole, appRolePassword: APP_ROLE.appRolePassword });
  db = createDb({ adminUrl: d.url.toString(), appUrl: d.url.toString(), poolSize: 4 });
  executor = createExecutor(db, { serverVersion: 'test', strictInputs: false });
  agentId = 'agt_failure_text_probe';
  await db.admin.query('INSERT INTO agents (workspace_id, id, name, sponsor_user_id) VALUES ($1, $2, $3, $4)', [
    workspaceId(),
    agentId,
    'Failure text probe',
    'usr_probe',
  ]);
}, 120_000);

afterAll(async () => {
  await db?.close();
  await d?.close();
});

const auditErrors = async (command: string) =>
  (
    await db.admin.query<{ error: string | null }>(
      'SELECT error FROM audit_log WHERE workspace_id = $1 AND command = $2 ORDER BY seq DESC',
      [workspaceId(), command],
    )
  ).rows.map((r) => r.error ?? '');

const ledgerError = async (command: string) =>
  (
    await db.admin.query<{ error: string | null }>(
      'SELECT error FROM agent_actions WHERE workspace_id = $1 AND command = $2 ORDER BY id DESC LIMIT 1',
      [workspaceId(), command],
    )
  ).rows[0]?.error;

describe.skipIf(!hasTestDatabase())('a profile-bound AI failure stores a fixed diagnostic (#1300)', () => {
  it('keeps the provider’s text out of the audit log and answers the caller with it', async () => {
    // The caller's own copy is unchanged: the state it sent is its own input.
    await expect(
      executor.execute(providerBound, { profileId: 'prf_x' }, userPrincipal('usr_probe', workspaceId(), 'owner'), { surface: 'rest' }),
    ).rejects.toThrow(SENTINEL);
    const errors = await auditErrors('test.providerBoundFailure');
    expect(errors).toEqual([`conflict: ${FIXED}`]);
    expect(errors.join(' ')).not.toContain('ada@example.com');
  }, 60_000);

  it('stores the fixed diagnostic in the agent ledger too', async () => {
    const principal = agentPrincipal('usr_probe', 'client_probe', workspaceId(), 'owner', ['artifacts:write', 'profiles:write'], {
      id: agentId,
      name: 'Failure text probe',
      status: 'active',
      statusReason: null,
    });
    await expect(executor.execute(providerBound, { profileId: 'prf_x' }, principal, { surface: 'mcp' })).rejects.toThrow(SENTINEL);
    expect(await ledgerError('test.providerBoundFailure')).toBe(`conflict: ${FIXED}`);
  }, 60_000);

  it('leaves the stored message of a command without a fixed failure text alone', async () => {
    await expect(executor.execute(ordinary, {}, userPrincipal('usr_probe', workspaceId(), 'owner'), { surface: 'rest' })).rejects.toThrow(
      'still published',
    );
    expect(await auditErrors('test.ordinaryFailure')).toEqual(['conflict: the artifact is still published']);
  }, 60_000);
});
