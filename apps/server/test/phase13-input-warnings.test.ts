import { runRetentionOnce } from '@agentic-marketing/audience';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, type User } from './harness';

// Evidence for rolling out STRICT_INPUTS (#124): key paths per client in Postgres, visible to the
// client itself and to admins, with a safe-to-enable hint and the same 30-day retention.

const PORT = 3420;

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws: string;

beforeAll(async () => {
  t = await startTestServer('test_input_warnings', PORT);
  owner = await t.signUp(`warnings-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']]);
}, 60_000);

afterAll(() => t?.close());

const rest = (token: string, name: string, body: unknown) =>
  fetch(`${t.base}/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

async function warningRows() {
  const { rows } = await t.srv.db.admin.query<{
    command: string;
    key_path: string;
    count: number;
    principal_type: string;
    principal_id: string;
    client_label: string;
  }>(
    'SELECT command, key_path, count, principal_type, principal_id, client_label FROM input_warnings WHERE workspace_id = $1 ORDER BY key_path',
    [ws],
  );
  return rows;
}

async function warningsAs(token: string) {
  const res = await rest(token, 'system.inputWarnings', {});
  expect(res.status).toBe(200);
  return (await res.json()) as {
    strictInputs: boolean;
    safeToEnableStrict: boolean;
    sinceDays: number;
    clients: {
      principalType: string;
      principalId: string;
      clientLabel: string;
      quietDays: number;
      total: number;
      commands: { command: string; keys: { keyPath: string; count: number }[] }[];
    }[];
  };
}

describe('system.inputWarnings', () => {
  it('records key paths only, counts repeats, and lets a token see just its own rows', async () => {
    const api = t.api(owner, ws);
    const first = await api.call('apiTokens.create', { name: 'first agent', scopes: ['artifacts:read'] });
    const second = await api.call('apiTokens.create', { name: 'second agent', scopes: ['artifacts:read'] });

    expect((await rest(first.token, 'workspace.get', { unexpected: 'super-secret-value' })).status).toBe(200);
    await eventually(
      async () => (await warningRows()).length,
      (n) => n === 1,
    );

    const rows = await warningRows();
    expect(rows).toEqual([
      expect.objectContaining({
        command: 'workspace.get',
        key_path: 'unexpected',
        count: 1,
        principal_type: 'token',
        principal_id: first.id,
        client_label: 'first agent',
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain('super-secret-value');

    expect((await rest(first.token, 'workspace.get', { unexpected: 'another-value' })).status).toBe(200);
    await eventually(
      async () => (await warningRows())[0]?.count,
      (count) => count === 2,
    );
    expect(JSON.stringify(await warningRows())).not.toContain('another-value');

    expect((await rest(second.token, 'workspace.get', { secondOnly: true })).status).toBe(200);
    await eventually(
      async () => (await warningRows()).length,
      (n) => n === 2,
    );

    const own = await warningsAs(first.token);
    expect(own.strictInputs).toBe(false);
    expect(own.safeToEnableStrict).toBe(false);
    expect(own.sinceDays).toBe(30);
    expect(own.clients).toHaveLength(1);
    expect(own.clients[0]).toMatchObject({
      principalType: 'token',
      principalId: first.id,
      clientLabel: 'first agent',
      quietDays: 0,
      total: 2,
    });
    expect(own.clients[0].commands).toEqual([
      { command: 'workspace.get', keys: [expect.objectContaining({ keyPath: 'unexpected', count: 2 })] },
    ]);

    const all = await api.call('system.inputWarnings', {});
    expect(all.clients.map((c) => c.principalId).sort()).toEqual([first.id, second.id].sort());
    expect(all.clients.find((c) => c.principalId === second.id)?.clientLabel).toBe('second agent');
    expect(all.safeToEnableStrict).toBe(false);
  });

  it('turns safeToEnableStrict on when every client has been quiet for 7 days', async () => {
    await t.srv.db.admin.query(`UPDATE input_warnings SET last_seen = now() - interval '8 days' WHERE workspace_id = $1`, [ws]);

    const all = await t.api(owner, ws).call('system.inputWarnings', {});
    expect(all.safeToEnableStrict).toBe(true);
    for (const client of all.clients) expect(client.quietDays).toBeGreaterThanOrEqual(7);
    expect(all.clients).toHaveLength(2);
  });

  it('removes evidence older than 30 days in the hourly retention job', async () => {
    await t.srv.db.admin.query(
      `UPDATE input_warnings SET last_seen = now() - interval '31 days' WHERE workspace_id = $1 AND key_path = 'secondOnly'`,
      [ws],
    );

    const removed = await runRetentionOnce({
      db: t.srv.db,
      events: t.srv.events,
      hot: t.srv.hot,
      ...t.srv.retention,
    });
    expect(removed.inputWarnings).toBe(1);
    const rows = await warningRows();
    expect(rows.map((r) => r.key_path)).toEqual(['unexpected']);
  });
});
