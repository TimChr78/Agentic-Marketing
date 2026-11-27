import { createDb } from '@agentic-marketing/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { APP_ROLE, createDisposableDb, type DisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { agentPrincipal, createExecutor, defineCommand, type Executor, type MandateView, PolicyDeniedError, type Services } from '../src';

// #1300 review: an agent mandate can require an independent AI check for a profile-bound AI command
// (`ai.score`, `ai.classify`). A provider that answers with a valid negative verdict
// (`{ ok: false, reason }`) is still speaking: its reason is the model's own text, but it carried no
// provenance, so a policy denial stored it in the audit log, the ledger error and the ledger reasons
// instead of the command's fixed diagnostic. The caller keeps the check's message; the long-lived
// stores get the fixed text while the reason is recognisably the provider's. A command without
// `failureText` keeps its stored reasons as before.

const SENTINEL = 'provider said: Ada Lovelace <ada@example.com>';
const FIXED = 'the AI provider refused or failed';

const checked = (name: string, failureText?: string) =>
  defineCommand({
    name,
    title: 'A profile-bound AI command with an independent check',
    description: 'A test-only write whose mandate requires a second model before it runs.',
    input: z.object({ profileId: z.string() }),
    output: z.object({ ok: z.literal(true) }),
    permission: null,
    effect: 'write',
    actionClass: 'spend',
    ...(failureText === undefined ? {} : { failureText }),
    handler: async () => ({ ok: true as const }),
  });

const withFixedText = checked('test.providerBoundVerdict', FIXED);
const withoutFixedText = checked('test.providerBoundVerdictPlain');

const mandate: MandateView = {
  id: 'mnd_check_verdict_text',
  version: 1,
  levels: { spend: 3 },
  scope: { segments: [], purposes: [], topics: [], channels: [], artifactTypes: [], artifacts: [] },
  limits: {},
  holdWindow: 'PT2H',
  independentCheck: true,
  guardrails: { window: 'P7D', minSent: 100 },
  purpose: 'Score people for the journey',
};

let d: DisposableDb;
let db: ReturnType<typeof createDb>;
let executor: Executor;
const agentId = 'agt_check_verdict_text';
const workspaceId = () => d.workspace;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('cmd_check_verdict', { appRole: APP_ROLE.appRole, appRolePassword: APP_ROLE.appRolePassword });
  db = createDb({ adminUrl: d.url.toString(), appUrl: d.url.toString(), poolSize: 4 });
  await db.admin.query('INSERT INTO agents (workspace_id, id, name, sponsor_user_id) VALUES ($1, $2, $3, $4)', [
    workspaceId(),
    agentId,
    'Check verdict text probe',
    'usr_probe',
  ]);
  // A spend action at level 3 runs autonomously, which is when the mandate asks for the check.
  await db.admin.query('UPDATE workspaces SET autonomy = $2::jsonb WHERE id = $1', [
    workspaceId(),
    JSON.stringify({ maxLevel: { spend: 3 } }),
  ]);
  const services: Services = {
    serverVersion: 'test',
    strictInputs: false,
    activeMandate: async () => ({ view: mandate, outsideHours: null }),
    // A provider's own answer, not an exception: the model denied the action in the check's words.
    independentCheck: async () => ({ ok: false, reason: SENTINEL }),
  };
  executor = createExecutor(db, services);
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

const ledgerRow = async (command: string) =>
  (
    await db.admin.query<{ error: string | null; reasons: string[] }>(
      'SELECT error, reasons FROM agent_actions WHERE workspace_id = $1 AND command = $2 ORDER BY id DESC LIMIT 1',
      [workspaceId(), command],
    )
  ).rows[0]!;

const principal = () =>
  agentPrincipal('usr_probe', 'client_verdict', workspaceId(), 'owner', ['profiles:write'], {
    id: agentId,
    name: 'Check verdict text probe',
    status: 'active',
    statusReason: null,
  });

describe.skipIf(!hasTestDatabase())('a negative independent-check verdict stores a fixed diagnostic (#1300 review)', () => {
  it('keeps the provider’s verdict out of the audit log and the ledger while the caller sees it', async () => {
    const thrown = await executor
      .execute(withFixedText, { profileId: 'prf_x' }, principal(), { surface: 'mcp' })
      .catch((err: unknown) => err);
    // The caller keeps the diagnostic the check gave it.
    expect(thrown).toBeInstanceOf(PolicyDeniedError);
    expect((thrown as Error).message).toContain(SENTINEL);

    // The audit log's error and the ledger's error are two stored copies; the ledger's reasons list
    // the same text a third time.
    expect(await auditErrors(withFixedText.name)).toEqual([`forbidden: ${FIXED}`]);
    const ledger = await ledgerRow(withFixedText.name);
    expect(ledger.error).toBe(FIXED);
    expect(ledger.reasons.join(' ')).toContain(FIXED);
    expect(JSON.stringify(ledger.reasons)).not.toContain('ada@example.com');
  }, 60_000);

  it('keeps the stored reasons of a command that has no fixed diagnostic', async () => {
    const thrown = await executor
      .execute(withoutFixedText, { profileId: 'prf_x' }, principal(), { surface: 'mcp' })
      .catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(PolicyDeniedError);
    expect((thrown as Error).message).toContain(SENTINEL);

    expect((await auditErrors(withoutFixedText.name)).join(' ')).toContain(SENTINEL);
    const ledger = await ledgerRow(withoutFixedText.name);
    expect(ledger.error).toContain(SENTINEL);
    expect(ledger.reasons.join(' ')).toContain(SENTINEL);
  }, 60_000);
});
