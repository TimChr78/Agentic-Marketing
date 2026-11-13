import type { ArtifactType } from '@agentic-marketing/artifacts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// #871: two concurrent publishes of different mandates for one agent serialise per workspace +
// agent; two imports touching A,B and B,A lock every affected artifact in id order, so neither
// deadlocks, and a deadlock that still happens surfaces as a retryable conflict.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;

beforeAll(async () => {
  t = await startTestServer('test_v01417_871', testPort(4453));
  owner = await t.signUp(`owner-v01417-871-${Date.now()}@example.com`);
}, 120_000);
afterAll(() => t?.close());

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const note = (title: string, body = 'Written for the artifact integrity test.') => ({ title, body });

async function agentCall(token: string, name: string, body: unknown = {}) {
  const res = await fetch(`${t.base}/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

interface Agent {
  token: string;
  agentId: string;
}

async function makeAgent(api: ReturnType<typeof t.api>, name: string): Promise<Agent> {
  const { token } = await api.call('apiTokens.create', { name, scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish'] });
  const me = await agentCall(token, 'agents.get');
  expect(me.status).toBe(200);
  return { token, agentId: me.body.id as string };
}

const bundleOf = (artifacts: { id: string; type: ArtifactType; name: string; content: unknown }[]) => ({
  format: 'agentic-marketing/artifacts@1' as const,
  artifacts,
});

describe('mandates and imports under concurrency (#871)', () => {
  it('lets exactly one concurrent publish of two mandates for one agent win', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const agent = await makeAgent(api, 'Concurrent mandate agent');
    const mandate = (name: string) =>
      api.call('artifacts.create', {
        type: 'agent_mandate',
        name,
        content: {
          agent: agent.agentId,
          purpose: 'Act for this workspace',
          validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        },
      });
    const [a, b] = await Promise.all([mandate('Mandate A'), mandate('Mandate B')]);

    const results = await Promise.allSettled([
      api.call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'Publish A' }),
      api.call('artifacts.requestPublish', { artifactId: b.artifactId, note: 'Publish B' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((loser.reason as { code: string }).code).toBe('invalid_input');
    expect((loser.reason as { message: string }).message).toMatch(/already has an active mandate/i);

    const active = await t.srv.db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM artifacts a
        WHERE a.workspace_id = $1 AND a.type = 'agent_mandate' AND a.archived = false AND a.published_version IS NOT NULL
          AND a.id = ANY($2::text[])`,
      [ws, [a.artifactId, b.artifactId]],
    );
    expect(active.rows[0]?.n).toBe(1);
  });

  it('locks imports in id order so A,B and B,A cannot deadlock', async () => {
    const ws = await t.workspaceWith([[owner, 'owner']], 'none');
    const api = t.api(owner, ws);
    const first = await api.call('artifacts.create', { type: 'note', name: 'Import A', content: note('A base') });
    const second = await api.call('artifacts.create', { type: 'note', name: 'Import B', content: note('B base') });
    const [a, b] = [first.artifactId, second.artifactId].sort();
    const item = (id: string, title: string, body: string) => ({ id, type: 'note', name: title, content: note(title, body) }) as const;
    const bundleX = bundleOf([item(a, 'A one', 'first A'), item(b, 'B one', 'first B')]);
    const bundleY = bundleOf([item(b, 'B two', 'second B'), item(a, 'A two', 'second A')]);

    const lock = await t.srv.db.admin.connect();
    let x: Promise<unknown> | undefined;
    let y: Promise<unknown> | undefined;
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT 1 FROM artifacts WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [ws, a]);
      // X reaches A first and waits. Y reaches B, then also waits for A: the classic A,B vs B,A.
      x = api.call('config.import', { bundle: bundleX, dryRun: false });
      await sleep(400);
      y = api.call('config.import', { bundle: bundleY, dryRun: false });
      await sleep(400);
    } finally {
      await lock.query('COMMIT');
      lock.release();
    }
    const results = await Promise.allSettled([x!, y!]);
    for (const result of results) {
      if (result.status === 'rejected') {
        const err = result.reason as { code?: string; message?: string; status?: number };
        // A deadlock must not surface as an internal error; a retryable conflict is the only
        // acceptable refusal.
        expect(err.code, err.message).not.toBe('internal');
        expect(err.message ?? '').not.toMatch(/deadlock/i);
        expect(err.code).toBe('conflict');
      }
    }
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
  });
});
