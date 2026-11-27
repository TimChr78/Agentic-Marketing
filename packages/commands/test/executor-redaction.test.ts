import { AppError } from '@agentic-marketing/core';
import { createDb } from '@agentic-marketing/db';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import {
  agentPrincipal,
  applyVerdict,
  createExecutor,
  defineCommand,
  PolicyDeniedError,
  ProviderError,
  ROLE_PERMISSIONS,
  redactPolicyReasons,
  sanitizeAppError,
} from '../src';

// #885 round 6: the executor is the last line of defence. A handler may build its AppError message
// from a provider's answer or an exception, so every message is redacted before it is returned to
// the caller, audited or written to the agent ledger. One place, not every command.

const SECRET = 'probe-secret';

const leakingWrite = defineCommand({
  name: 'test.leak',
  title: 'Leak',
  description: 'A write whose handler throws an AppError built from provider text.',
  input: z.object({}),
  output: z.object({}),
  permission: null,
  effect: 'write',
  actionClass: 'draft',
  handler: async () => {
    throw new AppError('invalid_input', 'bad: password=probe-secret');
  },
});

const current: Awaited<ReturnType<typeof createDisposableDb>>[] = [];
const pools: ReturnType<typeof createDb>[] = [];

afterAll(async () => {
  for (const db of pools) await db.close();
  for (const d of current) await d.close();
});

describe.skipIf(!hasTestDatabase())('the executor redacts an AppError before returning or storing it (#885)', () => {
  it('keeps a credential out of the thrown error, the audit row and the ledger row', async () => {
    const d = await createDisposableDb('cmd_redact');
    current.push(d);
    const db = createDb({ adminUrl: d.url.toString(), appUrl: d.url.toString(), poolSize: 2 });
    pools.push(db);
    const executor = createExecutor(db, { serverVersion: 'test', strictInputs: true });
    await d.db.admin.query('INSERT INTO agents (workspace_id, id, name, sponsor_user_id) VALUES ($1, $2, $3, $4)', [
      d.workspace,
      'agt_redact',
      'Redaction probe',
      'usr_1',
    ]);
    const agent = { id: 'agt_redact', name: 'Redaction probe', status: 'active' as const, statusReason: null };
    const principal = agentPrincipal('usr_1', 'redact-client', d.workspace, 'owner', ROLE_PERMISSIONS.owner, agent);

    const thrown = await executor.execute(leakingWrite, {}, principal, { surface: 'mcp' }).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(AppError);
    const error = thrown as AppError;
    // The message stays useful, and its own text is kept: only the credential value is replaced.
    expect(error.message).toContain('bad: password=');
    expect(error.message).not.toContain(SECRET);
    expect(error.code).toBe('invalid_input');

    const { rows: audited } = await d.db.admin.query<{ error: string | null }>(
      "SELECT error FROM audit_log WHERE workspace_id = $1 AND command = 'test.leak'",
      [d.workspace],
    );
    expect(audited).toHaveLength(1);
    expect(audited[0]!.error).not.toContain(SECRET);

    const { rows: ledger } = await d.db.admin.query<{ error: string | null }>(
      "SELECT error FROM agent_actions WHERE workspace_id = $1 AND command = 'test.leak'",
      [d.workspace],
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.error).not.toContain(SECRET);
  });
});

describe('a policy denial’s reasons (#885)', () => {
  it('redacts a credential the independent check quoted into a reason', () => {
    // The executor writes these reasons to the agent ledger and joins them into the caller's message.
    const denied = new PolicyDeniedError({
      decision: 'deny',
      actionClass: 'content.publish',
      level: 1,
      reasons: ['Independent check: The independent check failed: password=probe-secret'],
      impact: {},
    } as never);
    const safe = sanitizeAppError(denied);
    expect(safe).toBeInstanceOf(PolicyDeniedError);
    expect(safe.message).not.toContain(SECRET);
    expect((safe as PolicyDeniedError).outcome.reasons.join(' ')).not.toContain(SECRET);
    expect(safe.message).toContain('The independent check failed');
  });

  it('keeps an error with nothing to redact untouched', () => {
    const plain = new AppError('invalid_input', 'The input does not match the command schema.');
    expect(sanitizeAppError(plain)).toBe(plain);
  });

  it('redacts and bounds details before the error leaves the executor (#996)', () => {
    const details = { problems: [`Unknown parameter: password=${SECRET}`], nested: { list: [`token=${SECRET}`] } };
    const error = new AppError('invalid_input', 'The parameters are not valid.', details);

    const safe = sanitizeAppError(error);

    expect(safe).not.toBe(error);
    expect(JSON.stringify(safe.details)).not.toContain(SECRET);
    expect((safe.details as typeof details).problems[0]).toContain('Unknown parameter: password=');
    // The original error is untouched: other code may still read it.
    expect(JSON.stringify(details)).toContain(SECRET);
  });

  it('returns the same error when its details have nothing to redact', () => {
    const clean = new AppError('conflict', 'Use a new key.', { reason: 'idempotency_key_reused' });
    expect(sanitizeAppError(clean)).toBe(clean);
  });

  it('redacts a ProviderError’s details and keeps its provenance (#1300 review)', () => {
    // Only `details` needed redacting: reusing the instance because the message matched would keep
    // the credential, and the provider provenance must survive the rebuilt error.
    const error = new ProviderError('conflict', 'The provider refused the state.', {
      problems: [`token=${SECRET}`],
    });
    const safe = sanitizeAppError(error);
    expect(safe).toBeInstanceOf(ProviderError);
    expect(safe).not.toBe(error);
    expect(JSON.stringify(safe.details)).not.toContain(SECRET);
    expect((safe.details as { problems: string[] }).problems[0]).toContain('token=');
  });

  it('keeps a ProviderError with nothing to redact untouched', () => {
    const clean = new ProviderError('conflict', 'The provider refused the state.', { reason: 'model_refused' });
    expect(sanitizeAppError(clean)).toBe(clean);
  });
});

describe('the independent check verdict in policy reasons (#885 round 7)', () => {
  const policy = { decision: 'allow', level: 0, autonomous: true, reasons: [] } as unknown as Parameters<typeof applyVerdict>[0];
  const long = 'x '.repeat(235) + 'password="probe-secret' + ' '.repeat(60) + '"';

  for (const ok of [true, false])
    for (const reason of ['password=probe-secret', long])
      it(`redacts a ${ok ? 'passing' : 'failing'} verdict's reason (${reason.length} chars)`, () => {
        const out = applyVerdict(policy, { ok, reason }, { approvable: true, command: 'artifacts.publish' });
        expect(JSON.stringify(out.reasons)).not.toContain('probe-secret');
        expect(out.reasons.some((r) => r.startsWith('Independent check: '))).toBe(true);
      });
});

describe('policy reasons leave the policy engine redacted (#885 round 8)', () => {
  it('redacts top-level and shadow reasons, which reach heldBecause, approval notes and the ledger', () => {
    const policy = {
      decision: 'ask',
      level: 1,
      autonomous: false,
      reasons: ['artifact brand_1 is owned by agent password=probe-secret.'],
      shadow: { decision: 'allow', reasons: ['is owned by agent password=probe-secret.'], mandateId: 'mnd_1', mandateVersion: 1 },
    } as unknown as Parameters<typeof redactPolicyReasons>[0];
    const out = redactPolicyReasons(policy);
    expect(JSON.stringify(out)).not.toContain('probe-secret');
    expect(out.reasons[0]).toContain('is owned by agent password=');
    expect(out.decision).toBe('ask');
  });

  it('returns the same policy when nothing needs redacting', () => {
    const policy = { decision: 'allow', level: 2, autonomous: true, reasons: ['within the mandate'] } as unknown as Parameters<
      typeof redactPolicyReasons
    >[0];
    expect(redactPolicyReasons(policy)).toBe(policy);
  });
});
