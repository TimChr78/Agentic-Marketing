import { agentForCredential } from '@agentic-marketing/auth';
import { agentPrincipal, defineCommand, ROLE_PERMISSIONS } from '@agentic-marketing/commands';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startTestServer, testPort, type User } from './harness';

// #838: the agent ledger is exposed through agents.activity. An unexpected exception used to be
// stored verbatim in agent_actions.error, so a driver message such as
// "driver failure: password=probe-secret" was readable by any member with audit:read. Only an
// AppError's message (written for people) may survive; everything else becomes the fixed failure
// the audit log already uses.

const FIXED = 'The command failed with an unexpected error.';
const SECRET = 'driver failure: password=probe-secret';

const crashingDraft = defineCommand({
  name: 'test.expectCrash',
  title: 'Crash',
  description: 'An allowed draft whose handler throws an unexpected exception.',
  input: z.object({}),
  output: z.object({}),
  permission: null,
  effect: 'write',
  actionClass: 'draft',
  handler: async () => {
    throw new Error(SECRET);
  },
});

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';

beforeAll(async () => {
  t = await startTestServer('agent_ledger', testPort(2511));
  owner = await t.signUp(`ledger-owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']]);
});

afterAll(async () => {
  await t?.close();
});

describe('the agent ledger never stores an unexpected exception verbatim (#838)', () => {
  it('stores the fixed failure in agent_actions and shows it in agents.activity', async () => {
    const agent = await agentForCredential(t.srv.db, ws, 'api_token', 'tok_ledger_probe', owner.id, async () => 'Ledger probe');
    const principal = agentPrincipal(owner.id, 'ledger-client', ws, 'owner', ROLE_PERMISSIONS.owner, agent);

    // The caller still gets the original error and its span; only the stored copy is sanitized.
    await expect(t.srv.executor.execute(crashingDraft, {}, principal, { surface: 'mcp' })).rejects.toThrow('driver failure');

    const { rows } = await t.srv.db.admin.query<{ error: string | null }>(
      'SELECT error FROM agent_actions WHERE workspace_id = $1 AND agent_id = $2 AND command = $3',
      [ws, agent.id, 'test.expectCrash'],
    );
    expect(rows).toEqual([{ error: FIXED }]);

    const { actions } = await t.api(owner).call('agents.activity', { agentId: agent.id, limit: 5 });
    const action = actions.find((a) => a.command === 'test.expectCrash');
    expect(action).toMatchObject({ ok: false, error: FIXED, decision: 'allow', actionClass: 'draft' });
    expect(JSON.stringify(actions)).not.toContain('probe-secret');
  });
});
