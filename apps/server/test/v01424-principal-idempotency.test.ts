import { defineCommand, userPrincipal } from '@agentic-marketing/commands';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startTestServer, testPort, type User } from './harness';

// #906 review round 2 (A1): an idempotency key is scoped to the caller as well as the workspace.
// Before, the lookup keyed only on (workspace, key), so a different principal presenting the same
// key received the first caller's stored response instead of a conflict.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws: string;
let otherWs: string;
let tokenA: string;
let tokenB: string;

const note = (name: string) => ({ type: 'note', name, content: { title: name, body: 'x' } });

const call = (
  headers: Record<string, string>,
  command: string,
  body: unknown,
  key?: string,
): Promise<{ status: number; body: { artifactId?: string; error?: string; details?: { reason?: string } } }> =>
  fetch(`${t.base}/v1/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers, ...(key === undefined ? {} : { 'idempotency-key': key }) },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

const asPerson = (workspaceId: string) => ({ cookie: owner.cookie, origin: t.base, 'x-workspace-id': workspaceId });
const asToken = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  t = await startTestServer('test_v01424_principal_idempotency', testPort(3486));
  owner = await t.signUp(`principal-idempotency-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  otherWs = await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner, ws);
  tokenA = (await api.call('apiTokens.create', { name: 'agent A', scopes: ['artifacts:read', 'artifacts:write'] })).token;
  tokenB = (await api.call('apiTokens.create', { name: 'agent B', scopes: ['artifacts:read', 'artifacts:write'] })).token;
}, 120_000);

afterAll(async () => {
  await t?.close();
});

describe('an idempotency key is bound to its principal (A1)', () => {
  it('replays for the same person, including another session', async () => {
    const first = await call(asPerson(ws), 'artifacts.create', note('Same person'), 'same-person-1');
    const replay = await call(asPerson(ws), 'artifacts.create', note('Same person'), 'same-person-1');
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body.artifactId).toBe(first.body.artifactId);
  });

  it('replays for the same agent token', async () => {
    const first = await call(asToken(tokenA), 'artifacts.create', note('Same agent'), 'same-agent-1');
    const replay = await call(asToken(tokenA), 'artifacts.create', note('Same agent'), 'same-agent-1');
    expect(first.status).toBe(200);
    expect(replay.body.artifactId).toBe(first.body.artifactId);
  });

  it('refuses the same key from a person and an agent', async () => {
    const first = await call(asPerson(ws), 'artifacts.create', note('Person first'), 'shared-person-agent');
    expect(first.status).toBe(200);
    const agent = await call(asToken(tokenA), 'artifacts.create', note('Person first'), 'shared-person-agent');
    expect(agent.status).toBe(409);
    expect(agent.body.details?.reason).toBe('idempotency_key_reused');
    // The agent did not get the person's response and did not create a second artifact.
    expect(agent.body.artifactId).toBeUndefined();
    const list = await t.api(owner, ws).call('artifacts.list', { type: 'note', limit: 100 });
    expect(list.artifacts.filter((a) => a.name === 'Person first')).toHaveLength(1);
  });

  it('refuses the same key from two different agent tokens', async () => {
    const first = await call(asToken(tokenA), 'artifacts.create', note('Agent A first'), 'shared-agent-agent');
    expect(first.status).toBe(200);
    const second = await call(asToken(tokenB), 'artifacts.create', note('Agent A first'), 'shared-agent-agent');
    expect(second.status).toBe(409);
    expect(second.body.details?.reason).toBe('idempotency_key_reused');
    expect(second.body.artifactId).toBeUndefined();
  });

  it('keeps the same key independent across two workspaces', async () => {
    const a = await call(asPerson(ws), 'artifacts.create', note('Workspace A'), 'cross-workspace');
    const b = await call(asPerson(otherWs), 'artifacts.create', note('Workspace B'), 'cross-workspace');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.artifactId).not.toBe(a.body.artifactId);
  });

  it('rejects an empty key instead of treating it as no key', async () => {
    const refused = await call(asPerson(ws), 'artifacts.create', note('Empty key'), '');
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('invalid_input');
  });

  it('still accepts and dedupes the REST values it accepted before: spaces, non-ASCII, long', async () => {
    const keys = ['a key with spaces', 'nøkkel-é', 'k'.repeat(201)];
    for (const [i, key] of keys.entries()) {
      const name = `Legacy key ${i}`;
      const first = await call(asPerson(ws), 'artifacts.create', note(name), key);
      const replay = await call(asPerson(ws), 'artifacts.create', note(name), key);
      expect(first.status, key.slice(0, 12)).toBe(200);
      expect(replay.status, key.slice(0, 12)).toBe(200);
      expect(replay.body.artifactId, key.slice(0, 12)).toBe(first.body.artifactId);
    }
  });

  it('serialises two different principals under one key before the handler, so no external effect leaks', async () => {
    // The advisory lock is workspaces + key only, so the second caller waits. After the winner
    // commits, the caller-bound hash differs and the waiter answers the reused conflict *before*
    // its handler runs; otherwise its external side effects would survive the rollback.
    let runs = 0;
    const externalEffects: string[] = [];
    const slow = defineCommand({
      name: 'test.slowCrossPrincipal',
      title: 'Slow cross-principal write',
      description: 'Test-only command: two callers overlap under one key.',
      permission: null,
      effect: 'write',
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      async handler(input) {
        runs++;
        // Stands in for a segment refresh publishing membership events, or a ClickHouse message
        // event written by requestEmail: outside the transaction, a rollback cannot undo it.
        externalEffects.push(`${input.value}:${runs}`);
        await new Promise((resolve) => setTimeout(resolve, 250));
        return { value: input.value };
      },
    });
    const other = await t.signUp(`principal-other-${Date.now()}@example.com`);
    await t.srv.db.admin.query('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)', [ws, other.id, 'owner']);
    const opts = { surface: 'rest' as const, idempotencyKey: 'concurrent-cross-principal' };
    const outcomes = await Promise.allSettled([
      t.srv.executor.execute(slow, { value: 'v' }, userPrincipal(owner.id, ws, 'owner'), opts),
      t.srv.executor.execute(slow, { value: 'v' }, userPrincipal(other.id, ws, 'owner'), opts),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'conflict', details: { reason: 'idempotency_key_reused' } } });
    expect(runs).toBe(1);
    expect(externalEffects).toEqual(['v:1']);
  });
});
