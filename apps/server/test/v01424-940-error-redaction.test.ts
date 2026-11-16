import { publishValidators, runHeldChange, systemContext } from '@agentic-marketing/artifacts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// #940 (follow-up to #885): two error texts are returned normally rather than thrown, so they never
// pass the executor's AppError sanitising. `config.import` copies a failed publish's message into
// `changes[].problem`, which the idempotency row stores; `approvals.approve` copies the archived
// artifact's name into the rejection `reason` and `approval_requests.decision_note`. Both must be
// redacted and bounded before they reach a caller or a column.

const SECRET = 'review_dummy_secret';

// A publish validator for `note` is registered here rather than by the product: the note type has
// none, and the test needs a failure whose problem text quotes a credential. It refuses only the
// content the first test imports, so the archived-approval test can still request a publish.
publishValidators.set('note', async (content) =>
  String((content as { title?: unknown } | null)?.title).includes('import-fail') ? [`the note quotes password=${SECRET}`] : [],
);

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;

beforeAll(async () => {
  t = await startTestServer('test_v01424_940', testPort(4466));
  owner = await t.signUp(`owner-v01424-940-${Date.now()}@example.com`);
}, 120_000);
afterAll(() => t?.close());

const note = (title: string) => ({ title, body: 'Written for the error-redaction test.' });
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

describe('config.import publishes a redacted problem (#940)', () => {
  it('does not return or store a publish validator’s credential', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const id = `not_${'a'.repeat(32)}`;
    const bundle = {
      format: 'agentic-marketing/artifacts@1' as const,
      artifacts: [{ id, type: 'note' as const, name: 'Imported note', content: note('import-fail') }],
    };

    const out = await api.call('config.import', { bundle, dryRun: false, publish: true }, { idempotencyKey: 'import-940' });
    expect(out.changes).toMatchObject([{ id, publish: 'failed' }]);
    expect(out.changes[0]?.problem).toMatch(/password=\[redacted\]/);
    expect(JSON.stringify(out)).not.toContain(SECRET);

    const stored = await t.srv.db.admin.query<{ response: unknown }>(
      'SELECT response FROM idempotency_keys WHERE workspace_id = $1 AND key = $2',
      [ws, 'import-940'],
    );
    expect(stored.rows).toHaveLength(1);
    expect(JSON.stringify(stored.rows[0]?.response)).not.toContain(SECRET);
  });
});

describe('a held approval reason from a paused agent is redacted (#940 sweep)', () => {
  it('does not store or return a credential from the agent name', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    await api.call('workspace.setAutonomy', { maxLevel: { 'content.publish': 3 } });
    const token = (
      await api.call('apiTokens.create', {
        name: 'Held with a secret name',
        scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish'],
      })
    ).token as string;
    const agentCall = async (name: string, body: unknown = {}) => {
      const res = await fetch(`${t.base}/v1/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    const agentId = (await agentCall('agents.get')).body.id as string;
    const mandate = await api.call('artifacts.create', {
      type: 'agent_mandate',
      name: 'Hold content publishes',
      content: { agent: agentId, purpose: 'Test a held reason', validUntil: inDays(30), levels: { 'content.publish': 2 } } as never,
    });
    expect((await api.call('artifacts.requestPublish', { artifactId: mandate.artifactId, note: 'grant' })).status).toBe('published');
    await api.call('agents.update', { id: agentId, name: `Bot password=${SECRET}` });

    const created = await agentCall('artifacts.create', { type: 'note', name: 'Held note', content: note('Held') });
    const held = await agentCall('artifacts.requestPublish', { artifactId: created.body.artifactId, note: 'Held publish' });
    expect(held.body.status).toBe('on_hold');
    const approvalId = held.body.approvalId as string;
    await api.call('agents.pause', { id: agentId, reason: 'Stopped before its window ended' });
    await t.srv.db.withWorkspace(ws, (tx) =>
      tx.execute(sql`UPDATE approval_requests SET hold_until = now() - interval '1 minute'
        WHERE workspace_id = ${ws} AND id = ${approvalId}`),
    );

    const out = await t.srv.db.withWorkspace(ws, (tx) =>
      runHeldChange(systemContext(tx, ws, t.srv.services), approvalId, async () => ({ person: 'unused' })),
    );
    expect(out.status).toBe('needs_person');
    expect(out.reason).not.toContain(SECRET);
    expect(out.reason).toContain('password=[redacted]');

    const row = (
      await t.srv.db.admin.query<{ note: string; decision_note: string | null }>(
        'SELECT note, decision_note FROM approval_requests WHERE workspace_id = $1 AND id = $2',
        [ws, approvalId],
      )
    ).rows[0];
    expect(row?.note).not.toContain(SECRET);
    expect(row?.note).toContain('password=[redacted]');
    expect(row?.decision_note ?? '').not.toContain(SECRET);
  });
});

describe('approvals.approve rejects an archived artifact with a redacted reason (#940)', () => {
  it('does not return or store a credential from the artifact name', async () => {
    const approver = await t.signUp(`approver-v01424-940-${Date.now()}@example.com`);
    const ws = await t.workspaceWith(
      [
        [owner, 'owner'],
        [approver, 'approver'],
      ],
      'all_publishes',
    );
    const api = t.api(owner, ws);
    const approverApi = t.api(approver, ws);
    const created = await api.call('artifacts.create', {
      type: 'note',
      name: `Pending note password=${SECRET}`,
      content: note('Body'),
    });
    const request = await api.call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'Review me' });
    expect(request.status).toBe('in_review');
    await t.srv.db.admin.query('UPDATE artifacts SET archived = true WHERE workspace_id = $1 AND id = $2', [ws, created.artifactId]);

    const out = await approverApi.call('approvals.approve', { approvalId: request.approvalId as string });
    expect(out.status).toBe('rejected');
    expect(out.reason).not.toContain(SECRET);
    expect(out.reason).toContain('[redacted]');

    const row = await t.srv.db.admin.query<{ decision_note: string | null }>(
      'SELECT decision_note FROM approval_requests WHERE workspace_id = $1 AND id = $2',
      [ws, request.approvalId as string],
    );
    expect(row.rows[0]?.decision_note).not.toContain(SECRET);
    expect(row.rows[0]?.decision_note).toContain('[redacted]');
  });
});
