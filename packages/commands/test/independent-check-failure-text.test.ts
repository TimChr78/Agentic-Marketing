import { createDb } from '@agentic-marketing/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { APP_ROLE, createDisposableDb, type DisposableDb, hasTestDatabase } from '../../db/test/disposable';
import {
  agentPrincipal,
  createExecutor,
  defineCommand,
  type Executor,
  type MandateView,
  PolicyDeniedError,
  ProviderError,
  type Services,
} from '../src';

// #1300 review: an agent mandate can require an independent AI check for a profile-bound AI command
// (`ai.score`, `ai.classify`). When that check's provider fails, its text is turned into a policy
// reason, and a policy denial bypassed the command's fixed `failureText`: the provider's text (which
// may quote the person) reached the audit log, and the ledger kept the reasons beside it. The
// provenance now travels with the reason, so both stored copies keep the fixed diagnostic while the
// caller still gets the check's own message.

const SENTINEL = 'provider said: Ada Lovelace <ada@example.com>';
const FIXED = 'the AI provider refused or failed';

const checked = defineCommand({
  name: 'test.providerBoundCheck',
  title: 'A profile-bound AI command with an independent check',
  description: 'A test-only write whose mandate requires a second model before it runs.',
  input: z.object({ profileId: z.string() }),
  output: z.object({ ok: z.literal(true) }),
  permission: null,
  effect: 'write',
  actionClass: 'spend',
  failureText: FIXED,
  handler: async () => ({ ok: true as const }),
});

const mandate: MandateView = {
  id: 'mnd_check_failure_text',
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
const agentId = 'agt_check_failure_text_probe';
const workspaceId = () => d.workspace;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('cmd_check_failure_text', { appRole: APP_ROLE.appRole, appRolePassword: APP_ROLE.appRolePassword });
  db = createDb({ adminUrl: d.url.toString(), appUrl: d.url.toString(), poolSize: 4 });
  await db.admin.query('INSERT INTO agents (workspace_id, id, name, sponsor_user_id) VALUES ($1, $2, $3, $4)', [
    workspaceId(),
    agentId,
    'Check failure text probe',
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
    independentCheck: async () => {
      throw new ProviderError('conflict', SENTINEL);
    },
  };
  executor = createExecutor(db, services);
}, 120_000);

afterAll(async () => {
  await db?.close();
  await d?.close();
});

describe.skipIf(!hasTestDatabase())('an independent check failure stores a fixed diagnostic (#1300)', () => {
  it('keeps the provider’s text out of the audit log and the ledger while the caller sees it', async () => {
    const principal = agentPrincipal('usr_probe', 'client_probe', workspaceId(), 'owner', ['profiles:write'], {
      id: agentId,
      name: 'Check failure text probe',
      status: 'active',
      statusReason: null,
    });

    const thrown = await executor.execute(checked, { profileId: 'prf_x' }, principal, { surface: 'mcp' }).catch((err: unknown) => err);
    // The caller keeps the diagnostic the check gave it.
    expect(thrown).toBeInstanceOf(PolicyDeniedError);
    expect((thrown as Error).message).toContain(SENTINEL);

    const audited = (
      await db.admin.query<{ error: string | null }>(
        'SELECT error FROM audit_log WHERE workspace_id = $1 AND command = $2 ORDER BY seq DESC',
        [workspaceId(), checked.name],
      )
    ).rows.map((r) => r.error ?? '');
    expect(audited).toEqual([`forbidden: ${FIXED}`]);

    const ledger = (
      await db.admin.query<{ error: string | null; reasons: string[] }>(
        'SELECT error, reasons FROM agent_actions WHERE workspace_id = $1 AND command = $2 ORDER BY id DESC LIMIT 1',
        [workspaceId(), checked.name],
      )
    ).rows[0]!;
    expect(ledger.error).toBe(FIXED);
    // The reasons are a second stored copy of the same provider text.
    expect(ledger.reasons.join(' ')).toContain(FIXED);
    expect(JSON.stringify(ledger.reasons)).not.toContain('ada@example.com');
  }, 60_000);
});
