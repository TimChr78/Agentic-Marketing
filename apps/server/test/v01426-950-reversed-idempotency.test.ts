import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// #950: an idempotent replay returned the stored response forever. An agent published under key K,
// a person undid the publish, and the agent's retry with K was told v2 was live — a false premise.
// agents.undo now marks the key whose stored response belongs to that action as reversed, and a
// replay answers 409 with `details.reason: idempotency_key_reversed`.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let token = '';
let agentId = '';
let ws = '';

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

beforeAll(async () => {
  t = await startTestServer('test_v01426_950', testPort(4493), {}, { holdTickMs: 86_400_000 });
  owner = await t.signUp(`owner-v01426-950-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner, ws);
  token = (
    await api.call('apiTokens.create', {
      name: 'Filing agent',
      scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish', 'audit:read'],
    })
  ).token as string;
  agentId = (await agentCall('agents.get')).body.id as string;
  await api.call('workspace.setAutonomy', { maxLevel: { 'content.publish': 3 } });
  const mandate = await api.call('artifacts.create', {
    type: 'agent_mandate',
    name: 'Publish notes',
    content: { agent: agentId, purpose: 'Publish its own notes', validUntil: inDays(30), levels: { 'content.publish': 3 } } as never,
  });
  expect((await api.call('artifacts.requestPublish', { artifactId: mandate.artifactId, note: 'grant' })).status).toBe('published');
}, 120_000);
afterAll(() => t?.close());

async function agentCall(command: string, body: unknown = {}, key?: string) {
  const res = await fetch(`${t.base}/v1/${command}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const keyRow = async (key: string) =>
  (
    await t.srv.db.admin.query<{ agent_action_id: string | null; reversed_at: Date | null }>(
      'SELECT agent_action_id, reversed_at FROM idempotency_keys WHERE workspace_id = $1 AND key = $2',
      [ws, key],
    )
  ).rows[0];

/** A draft the agent owns, ready for one idempotent publish. */
async function draft(name: string) {
  const created = await agentCall('artifacts.create', { type: 'note', name, content: { title: name, body: 'Filing test' } });
  expect(created.status).toBe(200);
  return created.body.artifactId as string;
}

async function actionFor(artifactId: string) {
  const { actions } = await t.api(owner, ws).call('agents.activity', { agentId, limit: 50 });
  const action = actions.find(
    (a: { command: string; target: string | null }) => a.command === 'artifacts.requestPublish' && a.target === artifactId,
  );
  expect(action, `no ledger entry for ${artifactId}`).toBeTruthy();
  return action as { id: number };
}

describe('a replay of an undone action answers 409 (#950)', () => {
  it('refuses the key after agents.undo, telling the agent to use a new one', async () => {
    const artifactId = await draft('Undone publish');
    const key = 'undone-publish-1';
    const first = await agentCall('artifacts.requestPublish', { artifactId, note: 'Publish v1' }, key);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('published');

    // The response is linked to the ledger row that made it, so undo knows which key to reverse.
    expect((await keyRow(key))?.agent_action_id).toBe(String((await actionFor(artifactId)).id));

    const action = await actionFor(artifactId);
    const undone = await t.api(owner, ws).call('agents.undo', { actionId: action.id, note: 'Wrong note' });
    expect(undone.result).toBeTruthy();
    expect((await keyRow(key))?.reversed_at).not.toBeNull();
    expect((await t.api(owner, ws).call('artifacts.get', { artifactId })).publishedVersion).toBeNull();

    const replay = await agentCall('artifacts.requestPublish', { artifactId, note: 'Publish v1' }, key);
    expect(replay.status).toBe(409);
    expect(replay.body.error).toBe('conflict');
    expect(replay.body.details?.reason).toBe('idempotency_key_reversed');
    expect(replay.body.message).toMatch(/undone/i);
    expect(replay.body.message).toMatch(/new idempotency key/i);
    // Nothing was re-published by the refused replay.
    expect((await t.api(owner, ws).call('artifacts.get', { artifactId })).publishedVersion).toBeNull();
  });

  it('still replays a key whose action is in place', async () => {
    const artifactId = await draft('Kept publish');
    const key = 'kept-publish-1';
    const first = await agentCall('artifacts.requestPublish', { artifactId, note: 'Publish v1' }, key);
    expect(first.status).toBe(200);
    expect((await keyRow(key))?.reversed_at).toBeNull();

    const replay = await agentCall('artifacts.requestPublish', { artifactId, note: 'Publish v1' }, key);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ status: 'published', version: first.body.version });
  });

  it('leaves a person’s keys alone: they have no agent action to reverse', async () => {
    const api = t.api(owner, ws);
    const key = 'person-create-1';
    const res = await fetch(`${t.base}/v1/artifacts.create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: owner.cookie, origin: t.base, 'x-workspace-id': ws, 'idempotency-key': key },
      body: JSON.stringify({ type: 'note', name: 'Person note', content: { title: 'Person', body: 'Body' } }),
    });
    expect(res.status).toBe(200);
    expect((await keyRow(key))?.agent_action_id).toBeNull();

    const replay = await fetch(`${t.base}/v1/artifacts.create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: owner.cookie, origin: t.base, 'x-workspace-id': ws, 'idempotency-key': key },
      body: JSON.stringify({ type: 'note', name: 'Person note', content: { title: 'Person', body: 'Body' } }),
    });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { artifactId: string }).artifactId).toBeTruthy();
    // And a person still has the normal published listing.
    const list = await api.call('artifacts.list', { type: 'note' });
    expect(list.artifacts.some((a) => a.name === 'Person note')).toBe(true);
  });
});
