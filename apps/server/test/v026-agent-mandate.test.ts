import { newUuid } from '@agentic-marketing/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// B6 (Phase 26, #509): agents.mandate returns the same published, unarchived, unexpired mandate
// the policy engine selects, without a per-mandate client fan-out and without credentials.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let other: User;

beforeAll(async () => {
  t = await startTestServer('test_v026_mandate', testPort(3531));
  owner = await t.signUp(`mandate-owner-${Date.now()}@example.com`);
  other = await t.signUp(`mandate-other-${Date.now()}@example.com`);
});
afterAll(() => t?.close());

const hex = () => newUuid().replace(/-/g, '');
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

async function workspace(user: User = owner, timeZone = 'UTC') {
  const id = await t.workspaceWith([[user, 'owner']]);
  await t.srv.db.admin.query('UPDATE workspaces SET time_zone = $2 WHERE id = $1', [id, timeZone]);
  return id;
}

async function agent(ws: string, name = 'Newsletter agent') {
  const id = `agt_${hex()}`;
  await t.srv.db.admin.query('INSERT INTO agents (workspace_id, id, name, sponsor_user_id) VALUES ($1, $2, $3, $4)', [
    ws,
    id,
    name,
    owner.id,
  ]);
  // A credential row proves the answer never carries identifiers or secrets.
  await t.srv.db.admin.query(
    `INSERT INTO agent_credentials (workspace_id, kind, credential_id, agent_id) VALUES ($1, 'api_token', $2, $3)`,
    [ws, `cred-secret-${hex()}`, id],
  );
  return id;
}

async function publishMandate(ws: string, agentId: string, overrides: Record<string, unknown> = {}) {
  const api = t.api(owner, ws);
  const content = { agent: agentId, purpose: 'Send the weekly newsletter', validUntil: inDays(30), ...overrides };
  const artifact = await api.call('artifacts.create', {
    type: 'agent_mandate',
    name: 'Newsletter mandate',
    content: content as never,
  });
  const out = await api.call('artifacts.requestPublish', { artifactId: artifact.artifactId, note: 'test' });
  expect(out.status).toBe('published');
  return artifact.artifactId;
}

const mandate = (ws: string, agentId: string, user: User = owner) => t.api(user, ws).call('agents.mandate', { agentId });

async function atTime<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

describe('agents.mandate selection', () => {
  it('returns the published version, not a newer unpublished draft', async () => {
    const ws = await workspace();
    const agentId = await agent(ws);
    const id = await publishMandate(ws, agentId, { purpose: 'Published purpose' });
    await t.api(owner, ws).call('artifacts.updateDraft', {
      artifactId: id,
      content: { agent: agentId, purpose: 'Draft only', validUntil: inDays(30) } as never,
    });

    const out = await mandate(ws, agentId);
    expect(out.mandate).toMatchObject({ id, version: 1, content: { purpose: 'Published purpose' } });
    expect(JSON.stringify(out)).not.toContain('Draft only');
  });

  it('returns the newest published version among several', async () => {
    const ws = await workspace();
    const agentId = await agent(ws);
    const id = await publishMandate(ws, agentId, { purpose: 'First purpose' });
    await t.api(owner, ws).call('artifacts.updateDraft', {
      artifactId: id,
      content: { agent: agentId, purpose: 'Second purpose', validUntil: inDays(30) } as never,
    });
    await t.api(owner, ws).call('artifacts.requestPublish', { artifactId: id, note: 'second' });

    const out = await mandate(ws, agentId);
    expect(out.mandate).toMatchObject({ id, version: 2, content: { purpose: 'Second purpose' } });
  });

  it('skips an expired mandate in favour of a later active one', async () => {
    const ws = await workspace();
    const agentId = await agent(ws);
    const expired = await publishMandate(ws, agentId, { purpose: 'Expired mandate' });
    await t.srv.db.admin.query(
      `UPDATE artifact_versions
          SET content = jsonb_set(content, '{validUntil}', '"2020-01-01T00:00:00.000Z"'::jsonb)
        WHERE workspace_id = $1 AND artifact_id = $2 AND number = 1`,
      [ws, expired],
    );
    const active = await publishMandate(ws, agentId, { purpose: 'Active mandate' });

    const out = await mandate(ws, agentId);
    expect(out.mandate).toMatchObject({ id: active, version: 1, content: { purpose: 'Active mandate' } });
  });

  it('returns null for an expired mandate and for an archived one', async () => {
    const ws = await workspace();
    const expiredAgent = await agent(ws, 'Expired agent');
    const expired = await publishMandate(ws, expiredAgent, { validUntil: inDays(30) });
    await t.srv.db.admin.query(
      `UPDATE artifact_versions
          SET content = jsonb_set(content, '{validUntil}', '"2020-01-01T00:00:00.000Z"'::jsonb)
        WHERE workspace_id = $1 AND artifact_id = $2 AND number = 1`,
      [ws, expired],
    );
    expect((await mandate(ws, expiredAgent)).mandate).toBeNull();

    const archivedAgent = await agent(ws, 'Archived agent');
    const archived = await publishMandate(ws, archivedAgent);
    await t.srv.db.admin.query('UPDATE artifacts SET archived = true WHERE workspace_id = $1 AND id = $2', [ws, archived]);
    expect((await mandate(ws, archivedAgent)).mandate).toBeNull();
  });

  it('returns null when the agent has no mandate', async () => {
    const ws = await workspace();
    const agentId = await agent(ws);
    const out = await mandate(ws, agentId);
    expect(out).toMatchObject({ agentId, mandate: null, outsideHours: null });
    expect(Date.parse(out.asOf)).not.toBeNaN();
  });

  it('returns not_found for an unknown agent and for another tenant’s agent', async () => {
    const ws = await workspace();
    const theirs = await workspace(other);
    const agentId = await agent(ws);

    await expect(mandate(ws, `agt_${hex()}`)).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.api(other, theirs).call('agents.mandate', { agentId })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('agents.mandate working hours', () => {
  it('reports inside and outside a daytime window in the workspace zone', async () => {
    const ws = await workspace(owner, 'Europe/Copenhagen');
    const agentId = await agent(ws);
    await publishMandate(ws, agentId, { workingHours: { start: '07:00', end: '11:00', days: ['tue'] } });

    const inside = await atTime('2026-11-03T08:00:00Z', () => mandate(ws, agentId)); // Tuesday 09:00 CET
    expect(inside.outsideHours).toBeNull();

    const outside = await atTime('2026-11-04T08:00:00Z', () => mandate(ws, agentId)); // Wednesday 09:00 CET
    expect(outside.outsideHours).toContain('tue');
  });

  it('handles an overnight window across midnight', async () => {
    const ws = await workspace(owner, 'Europe/Copenhagen');
    const agentId = await agent(ws);
    await publishMandate(ws, agentId, { workingHours: { start: '22:00', end: '02:00', days: ['mon'] } });

    const inside = await atTime('2026-11-03T00:30:00Z', () => mandate(ws, agentId)); // Tuesday 01:30 CET, Monday's window
    expect(inside.outsideHours).toBeNull();

    const outside = await atTime('2026-11-02T00:30:00Z', () => mandate(ws, agentId)); // Monday 01:30 CET, Sunday's window
    expect(outside.outsideHours).toContain('mon');
  });

  it('follows the workspace zone across daylight saving', async () => {
    const ws = await workspace(owner, 'Europe/Copenhagen');
    const agentId = await agent(ws);
    await publishMandate(ws, agentId, { workingHours: { start: '02:00', end: '03:00', days: ['sat', 'sun'] } });

    // 01:30Z is 03:30 CEST on Saturday 24 October, then 02:30 CET on Sunday 25 October.
    const beforeFallBack = await atTime('2026-10-24T01:30:00Z', () => mandate(ws, agentId));
    expect(beforeFallBack.outsideHours).toContain('between 02:00 and 03:00');
    const afterFallBack = await atTime('2026-10-25T01:30:00Z', () => mandate(ws, agentId));
    expect(afterFallBack.outsideHours).toBeNull();
  });
});

describe('agents.mandate output safety', () => {
  it('includes no credentials or secret values', async () => {
    const ws = await workspace();
    const agentId = await agent(ws);
    await publishMandate(ws, agentId);
    const out = await mandate(ws, agentId);
    const body = JSON.stringify(out);
    expect(body).not.toContain('cred-secret');
    expect(body).not.toContain('credential');
    expect(body).not.toContain('amk_');
    expect(body).not.toContain('secret');
  });
});
