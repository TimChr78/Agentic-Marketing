import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAgent, startTestServer, testPort, type User } from './harness';

// Wave 4, Phase 20 (#311; agentic-autonomy §6): learnings, a small store of conclusions with the
// experiments behind them. People and agents add them, only people retract them, and agents read
// the active ones through the MCP resource learnings://current.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let agent: Awaited<ReturnType<typeof connectAgent>>;
let broadcastId = '';
let personLearningId = '';
let agentLearningId = '';
let token = '';

const evidence = (id: string) => [
  {
    kind: 'subject_test' as const,
    id,
    summary: 'The subject with a number beat the plain one on clicks',
    numbers: { wins: 3, tests: 4, liftPts: 2.1 },
  },
];

beforeAll(async () => {
  t = await startTestServer('test_learnings', testPort(3322));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner);
  // A real broadcast to cite as the source of the result; its draft content is enough.
  const broadcast = await api.call('artifacts.create', {
    type: 'broadcast',
    name: 'Issue with a tested subject',
    content: {
      template: `eml_${'0'.repeat(32)}`,
      segment: `seg_${'0'.repeat(32)}`,
      subjectTest: { subjects: ['The 3 numbers that matter', 'This week in martech'] },
    },
  });
  broadcastId = broadcast.artifactId;
  token = (await api.call('apiTokens.create', { name: 'Learning writer', scopes: ['artifacts:read', 'artifacts:write'] })).token;
  agent = await connectAgent(t.base, owner, ['artifacts:read', 'artifacts:write']);
}, 60_000);
afterAll(() => t?.close());

const apiCall = async (name: string, body: unknown = {}) => {
  const res = await fetch(`${t.base}/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};
const mcp = async (name: string, args: unknown = {}) =>
  (await agent.client.callTool({ name, arguments: args as Record<string, unknown> })) as any;

describe('learnings (#311)', () => {
  it('a person adds a learning and finds it by status and scope', async () => {
    const learning = await t.api(owner).call('learnings.add', {
      statement: 'Subject lines with a number win for this audience',
      scope: {
        segmentIds: [`seg_${'a'.repeat(32)}`],
        channel: 'email',
        topic: 'weekly',
        purpose: 'marketing_email',
      },
      evidence: evidence(broadcastId),
    });
    personLearningId = learning.id;
    expect(learning).toMatchObject({
      id: expect.stringMatching(/^lrn_[0-9a-f]{32}$/),
      status: 'active',
      author: { type: 'user', id: owner.id },
      agentId: null,
      scope: { channel: 'email', topic: 'weekly', purpose: 'marketing_email' },
    });

    const current = await t.api(owner).call('learnings.list', {});
    expect(current.learnings.map((l) => l.id)).toContain(personLearningId);
    expect(current.learnings.find((l) => l.id === personLearningId)?.evidence).toEqual(evidence(broadcastId));

    const email = await t.api(owner).call('learnings.list', { channel: 'email', topic: 'weekly' });
    expect(email.learnings.map((l) => l.id)).toEqual([personLearningId]);
    const otherChannel = await t.api(owner).call('learnings.list', { channel: 'sms' });
    expect(otherChannel.learnings).toEqual([]);
    const otherSegment = await t.api(owner).call('learnings.list', { segmentId: `seg_${'b'.repeat(32)}` });
    expect(otherSegment.learnings).toEqual([]);
  });

  it('a person retracts it with a reason; a retracted learning is no longer current', async () => {
    const retracted = await t.api(owner).call('learnings.retract', {
      id: personLearningId,
      reason: 'The effect did not repeat in the next four tests',
    });
    expect(retracted).toMatchObject({
      id: personLearningId,
      status: 'retracted',
      retractedBy: owner.id,
      retractReason: 'The effect did not repeat in the next four tests',
    });
    expect(retracted.retractedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const current = await t.api(owner).call('learnings.list', {});
    expect(current.learnings.map((l) => l.id)).not.toContain(personLearningId);
    const archived = await t.api(owner).call('learnings.list', { status: 'retracted' });
    expect(archived.learnings.map((l) => l.id)).toEqual([personLearningId]);
  });

  it('an agent adds one with evidence that references a real broadcast', async () => {
    const out = await mcp('learnings.add', {
      statement: 'Numbers in the subject win on email for this audience',
      scope: { channel: 'email' },
      evidence: evidence(broadcastId),
    });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent).toMatchObject({
      status: 'active',
      author: { type: 'agent' },
      scope: { channel: 'email' },
    });
    expect(out.structuredContent.author.id).toBe(owner.id);
    expect(out.structuredContent.agentId).toMatch(/^agt_[0-9a-f]{32}$/);
    agentLearningId = out.structuredContent.id;
  });

  it('an agent without evidence or with an unknown id is refused', async () => {
    const noEvidence = await mcp('learnings.add', {
      statement: 'Something I remember',
      evidence: [],
    });
    expect(noEvidence.isError).toBe(true);

    const unknown = await mcp('learnings.add', {
      statement: 'Something a result said',
      evidence: evidence(`bct_${'f'.repeat(32)}`),
    });
    expect(unknown.isError).toBe(true);
    expect((unknown.content[0] as { text: string }).text).toContain('is not an artifact in this workspace');
  });

  it('an agent cannot retract a learning', async () => {
    const out = await apiCall('learnings.retract', { id: agentLearningId, reason: 'An agent tries' });
    expect(out.status).toBe(403);
    expect(out.body.error).toBe('forbidden');
    expect(out.body.message).toContain('can only be run by a person');
  });

  it('learnings://current serves only the active learnings', async () => {
    const { resources } = await agent.client.listResources();
    expect(resources.find((r) => r.uri === 'learnings://current')).toMatchObject({ mimeType: 'application/json' });

    const read = await agent.client.readResource({ uri: 'learnings://current' });
    const body = JSON.parse((read.contents[0] as { text: string }).text) as {
      learnings: { id: string; status: string }[];
      count: number;
    };
    expect(body.learnings.map((l) => l.id)).toEqual([agentLearningId]);
    expect(body.learnings.every((l) => l.status === 'active')).toBe(true);
    expect(body.learnings.map((l) => l.id)).not.toContain(personLearningId);
    expect(body.count).toBe(1);
  });
});
