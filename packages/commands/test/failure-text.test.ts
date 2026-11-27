import { AppError } from '@agentic-marketing/core';
import { createDb } from '@agentic-marketing/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { APP_ROLE, createDisposableDb, type DisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { agentPrincipal, createExecutor, defineCommand, type Executor, ProviderError, userPrincipal } from '../src';

// #1300: a failed profile-bound AI command could store the provider's own message in the audit log
// and the agent ledger, and a provider may quote the person's data back in that message. A command
// that declares `failureText` records that fixed diagnostic in place of a provider's text, while
// the caller still gets its own error. The diagnostic is chosen once and formatted per store: the
// audit log keeps `code: message`, the ledger the message alone. Only a failure whose text came
// from a provider takes the fixed copy; the executor's own conflicts keep their reason.

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
    // The provider answered, and its answer quotes the person.
    throw new ProviderError('conflict', SENTINEL);
  },
});

/** A command with a fixed failure text that succeeds, so a reused key reaches the executor's conflict. */
const reusable = defineCommand({
  name: 'test.providerBoundReusable',
  title: 'A profile-bound AI command with a key',
  description: 'A test-only write that succeeds once and answers a reused idempotency key.',
  input: z.object({ n: z.number() }),
  output: z.object({ n: z.number() }),
  permission: null,
  effect: 'write',
  actionClass: 'draft',
  failureText: FIXED,
  handler: async (input) => ({ n: input.n }),
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

/** A command with a fixed failure text whose own refusal categories must keep their reason. */
const denied = defineCommand({
  name: 'test.providerBoundDenied',
  title: 'A denied profile-bound AI failure',
  description: 'A test-only write refused before any provider ran.',
  input: z.object({}),
  output: z.object({ ok: z.literal(true) }),
  permission: null,
  effect: 'write',
  actionClass: 'draft',
  failureText: FIXED,
  handler: async () => {
    throw new AppError('forbidden', 'The workspace policy denies this write.');
  },
});

const invalid = defineCommand({
  name: 'test.providerBoundInvalid',
  title: 'An invalid profile-bound AI failure',
  description: 'A test-only write whose own validation refused it.',
  input: z.object({}),
  output: z.object({ ok: z.literal(true) }),
  permission: null,
  effect: 'write',
  actionClass: 'draft',
  failureText: FIXED,
  handler: async () => {
    throw new AppError('invalid_input', 'The state has personal data.');
  },
});

/** A command whose input validation can refuse it before the handler runs. */
const preflight = defineCommand({
  name: 'test.providerBoundPreflight',
  title: 'A preflight profile-bound AI failure',
  description: 'A test-only write refused by input validation.',
  input: z.object({ n: z.number() }),
  output: z.object({ ok: z.literal(true) }),
  permission: null,
  effect: 'write',
  actionClass: 'draft',
  failureText: FIXED,
  handler: async () => ({ ok: true as const }),
});

const crashed = defineCommand({
  name: 'test.providerBoundCrash',
  title: 'A crashed profile-bound AI failure',
  description: 'A test-only write that throws an unexpected exception.',
  input: z.object({}),
  output: z.object({ ok: z.literal(true) }),
  permission: null,
  effect: 'write',
  actionClass: 'draft',
  failureText: FIXED,
  handler: async () => {
    throw new Error(`boom ${SENTINEL}`);
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
    expect(await ledgerError('test.providerBoundFailure')).toBe(FIXED);
  }, 60_000);

  it('leaves the stored message of a command without a fixed failure text alone', async () => {
    await expect(executor.execute(ordinary, {}, userPrincipal('usr_probe', workspaceId(), 'owner'), { surface: 'rest' })).rejects.toThrow(
      'still published',
    );
    expect(await auditErrors('test.ordinaryFailure')).toEqual(['conflict: the artifact is still published']);
  }, 60_000);

  it('keeps the executor’s own conflict reason when an idempotency key is reused', async () => {
    // A reused key refuses before the handler runs: no provider was involved, so the stored
    // diagnostic must not call it a provider failure.
    const principal = agentPrincipal('usr_probe', 'client_probe', workspaceId(), 'owner', ['artifacts:write'], {
      id: agentId,
      name: 'Failure text probe',
      status: 'active',
      statusReason: null,
    });
    const key = `reuse-${Date.now()}`;
    await executor.execute(reusable, { n: 1 }, principal, { surface: 'mcp', idempotencyKey: key });
    await expect(executor.execute(reusable, { n: 2 }, principal, { surface: 'mcp', idempotencyKey: key })).rejects.toThrow('already used');
    const own = 'This idempotency key was already used for a different request. Use a new key.';
    // The conflict is answered before the policy engine runs, so it has an audit row and no ledger
    // row; the audit copy is the one that used to call this a provider failure.
    expect((await auditErrors('test.providerBoundReusable')).filter(Boolean)).toEqual([`conflict: ${own}`]);
  }, 60_000);

  it('keeps a policy refusal’s own reason instead of calling it a provider failure', async () => {
    await expect(executor.execute(denied, {}, userPrincipal('usr_probe', workspaceId(), 'owner'), { surface: 'rest' })).rejects.toThrow(
      'policy denies',
    );
    expect(await auditErrors('test.providerBoundDenied')).toEqual(['forbidden: The workspace policy denies this write.']);
  }, 60_000);

  it('keeps a validation refusal’s own reason in both stores', async () => {
    const principal = agentPrincipal('usr_probe', 'client_probe', workspaceId(), 'owner', ['artifacts:write'], {
      id: agentId,
      name: 'Failure text probe',
      status: 'active',
      statusReason: null,
    });
    await expect(executor.execute(invalid, {}, principal, { surface: 'mcp' })).rejects.toThrow('personal data');
    expect(await auditErrors('test.providerBoundInvalid')).toEqual(['invalid_input: The state has personal data.']);
    expect(await ledgerError('test.providerBoundInvalid')).toBe('The state has personal data.');
  }, 60_000);

  it('keeps a preflight refusal’s own validation text', async () => {
    // A schema rejection never reaches the handler (or a provider): it keeps its own validation text.
    await expect(
      executor.execute(preflight, { n: 'not a number' }, userPrincipal('usr_probe', workspaceId(), 'owner'), { surface: 'rest' }),
    ).rejects.toThrow('input does not match');
    expect(await auditErrors('test.providerBoundPreflight')).toEqual(['invalid_input: The input does not match the command schema.']);
  }, 60_000);

  it('stores one fixed marker for an unexpected exception, in both stores', async () => {
    const principal = agentPrincipal('usr_probe', 'client_probe', workspaceId(), 'owner', ['artifacts:write'], {
      id: agentId,
      name: 'Failure text probe',
      status: 'active',
      statusReason: null,
    });
    await expect(executor.execute(crashed, {}, principal, { surface: 'mcp' })).rejects.toThrow('boom');
    // The audit log prefixes the code; the ledger keeps the established message alone.
    expect(await auditErrors('test.providerBoundCrash')).toEqual(['internal: The command failed with an unexpected error.']);
    expect(await ledgerError('test.providerBoundCrash')).toBe('The command failed with an unexpected error.');
  }, 60_000);
});
