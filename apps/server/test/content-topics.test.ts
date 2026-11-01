import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAgent, startTestServer, testPort, type User } from './harness';

// Wave 4, Phase 20 (#141): the editorial topic backlog and content briefs. Topics are rows with
// statuses and scores; briefs are versioned content_brief artifacts. Agents propose and score
// topics and draft briefs over MCP; people approve, publish and archive.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let agent: Awaited<ReturnType<typeof connectAgent>>;

beforeAll(async () => {
  t = await startTestServer('test_content_topics', testPort(2500));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  // agent_changes: an agent's publish request waits for a person, so there is an approval to test.
  await t.workspaceWith([[owner, 'owner']], 'agent_changes');
  agent = await connectAgent(t.base, owner, ['artifacts:read', 'artifacts:write', 'artifacts:publish']);
}, 60_000);
afterAll(() => t?.close());

const mcp = async (name: string, args: unknown = {}) =>
  (await agent.client.callTool({ name, arguments: args as Record<string, unknown> })) as any;

const signal = (kind: 'content_item' | 'community' | 'manual', weight: number, extra: Record<string, unknown> = {}) => ({
  kind,
  weight,
  ...extra,
});

describe('editorial topic backlog (#141)', () => {
  it('creates a topic from signals, scores it and filters the backlog', async () => {
    const api = t.api(owner);
    const created = await api.call('content.topics.create', {
      title: 'The quiet cost of a manual newsletter',
      angle: 'Hours spent on a weekly issue, and what to automate first',
      audience: 'Marketing ops leads at small B2B teams',
      readerRole: 'marketing ops lead',
      keyword: 'newsletter automation',
      tags: ['newsletter', 'operations'],
      signals: [
        signal('content_item', 20, {
          id: `cit_${'a'.repeat(32)}`,
          title: 'Content library item',
          relevance: 'high',
        }),
        signal('community', 30, { title: 'Reddit thread', comments: 120, relevance: 'high' }),
      ],
      targetDate: '2026-11-16',
    });
    expect(created.duplicateOf).toBeNull();
    expect(created.topic).toMatchObject({
      status: 'scored',
      score: 50,
      title: 'The quiet cost of a manual newsletter',
      tags: ['newsletter', 'operations'],
      targetDate: '2026-11-16',
    });
    expect(created.topic.id).toMatch(/^ctp_[0-9a-f]{32}$/);
    expect(created.topic.signals).toHaveLength(2);

    const rescored = await api.call('content.topics.score', {
      topicId: created.topic.id,
      score: 82,
      signals: [signal('content_item', 40, { id: `cit_${'a'.repeat(32)}`, relevance: 'high' }), signal('manual', 42)],
    });
    expect(rescored.topic).toMatchObject({ score: 82, status: 'scored' });

    const byScore = await api.call('content.topics.list', { minScore: 80, tag: 'operations' });
    expect(byScore.topics.map((topic) => topic.id)).toEqual([created.topic.id]);
    expect((await api.call('content.topics.list', { tag: 'missing' })).topics).toEqual([]);
    expect((await api.call('content.topics.list', { status: 'idea' })).topics).toEqual([]);
  });

  it('links a near-duplicate instead of silently creating it twice', async () => {
    const api = t.api(owner);
    const first = await api.call('content.topics.create', {
      title: 'What makes a weekly issue worth opening?',
      keyword: 'newsletter subject lines',
    });
    const duplicate = await api.call('content.topics.create', {
      title: '  what MAKES a weekly issue worth opening  ',
      keyword: 'Newsletter subject lines',
    });
    expect(duplicate.duplicateOf).toEqual({ id: first.topic.id, title: first.topic.title });
    expect(duplicate.warnings[0]).toContain(first.topic.title);
    expect(duplicate.topic.similarTopicIds).toContain(first.topic.id);

    const list = await api.call('content.topics.list', {});
    const linked = list.topics.find((topic) => topic.id === first.topic.id);
    expect(linked?.similarTopicIds).toContain(duplicate.topic.id);
  });

  it('an agent proposes a topic and a brief draft, but cannot approve or publish', async () => {
    const created = await mcp('content.topics.create', {
      title: 'A teardown of three martech onboarding emails',
      angle: 'Compare the first three emails of three tools',
      audience: 'Lifecycle marketers',
      signals: [signal('content_item', 25, { id: `cit_${'b'.repeat(32)}`, title: 'Onboarding teardown source', relevance: 'high' })],
    });
    expect(created.isError).toBeFalsy();
    const topic = created.structuredContent.topic;
    expect(topic).toMatchObject({ status: 'scored', score: 25, createdBy: { type: 'agent' } });
    expect(topic.agentId).toMatch(/^agt_[0-9a-f]{32}$/);

    const brief = await mcp('content.topics.toBrief', { topicId: topic.id });
    expect(brief.isError).toBeFalsy();
    const artifactId = brief.structuredContent.artifactId;
    expect(artifactId).toMatch(/^brf_[0-9a-f]{32}$/);
    expect(brief.structuredContent.status).toBe('brief');

    const listed = await t.api(owner).call('content.topics.list', { status: 'brief' });
    expect(listed.topics.find((item) => item.id === topic.id)?.briefArtifactId).toBe(artifactId);

    const piece = await t.api(owner).call('artifacts.get', { artifactId });
    expect(piece).toMatchObject({ type: 'content_brief', publishedVersion: null });
    // The brief was seeded from the topic: the thesis and Monday test are still a person's/agent's to fill.
    expect(piece.version.content).toMatchObject({
      topicId: topic.id,
      sources: [{ kind: 'content_item', id: `cit_${'b'.repeat(32)}` }],
    });

    // The agent cannot mark the topic approved or published, nor assign an owner.
    const approved = await mcp('content.topics.update', { topicId: topic.id, status: 'approved' });
    expect(approved.isError).toBe(true);
    const published = await mcp('content.topics.update', {
      topicId: topic.id,
      status: 'published',
      canonicalUrl: 'https://example.com/blog/teardown',
    });
    expect(published.isError).toBe(true);
    const ownerChange = await mcp('content.topics.update', { topicId: topic.id, ownerId: owner.id });
    expect(ownerChange.isError).toBe(true);

    // An agent may fill the brief, but it waits for a person under agent_changes.
    await mcp('artifacts.updateDraft', {
      artifactId,
      content: {
        topicId: topic.id,
        title: 'A teardown of three martech onboarding emails',
        thesis: 'Most onboarding sequences explain features; the good ones teach one job',
        audience: 'Lifecycle marketers',
        mondayTest: 'Rewrite the first email around one job instead of the feature list',
        sources: [{ kind: 'content_item', id: `cit_${'b'.repeat(32)}`, title: 'Onboarding teardown source' }],
      },
    });
    const submitted = await mcp('artifacts.requestPublish', { artifactId, note: 'First draft' });
    expect(submitted.isError).toBeFalsy();
    expect(submitted.structuredContent.status).toBe('in_review');
    const approvalId = submitted.structuredContent.approvalId;
    expect(approvalId).toMatch(/^apr_/);

    // An agent cannot approve, even its own brief: approval is not an MCP tool for agents.
    await expect(mcp('approvals.approve', { approvalId })).rejects.toThrow(/not found/i);
    // Nor can it archive the topic; archiving is a person's action.
    await expect(mcp('content.topics.archive', { topicId: topic.id })).rejects.toThrow(/not found/i);

    // A person approves: the topic moves from brief to approved.
    const approvedNow = await t.api(owner).call('approvals.approve', { approvalId });
    expect(approvedNow).toMatchObject({ status: 'approved', artifactId, version: 1 });
    const after = await t.api(owner).call('content.topics.list', { status: 'approved' });
    expect(after.topics.find((item) => item.id === topic.id)).toMatchObject({ status: 'approved', briefArtifactId: artifactId });
  });

  it('a person publishes with a canonical URL and archives without losing the brief', async () => {
    const api = t.api(owner);
    const created = await api.call('content.topics.create', {
      title: 'The metric that predicts a newsletter’s second month',
      angle: 'Early engagement beats list size',
    });
    const brief = await api.call('content.topics.toBrief', { topicId: created.topic.id });
    const artifactId = brief.artifactId;

    const content = {
      topicId: created.topic.id,
      title: created.topic.title,
      thesis: 'Second-issue opens predict retention better than list growth',
      audience: 'Newsletter operators',
      mondayTest: 'Check the second-issue open rate before celebrating signups',
      sources: [],
      noSourcesReason: 'An opinion piece built on the workspace’s own send data',
    };
    await api.call('artifacts.updateDraft', { artifactId, content });
    // Without sources and without a reason, publishing is refused.
    await api.call('artifacts.updateDraft', { artifactId, content: { ...content, noSourcesReason: undefined } });
    await expect(api.call('artifacts.requestPublish', { artifactId, note: 'needs a source' })).rejects.toMatchObject({
      message: expect.stringContaining('at least one source'),
    });
    await api.call('artifacts.updateDraft', { artifactId, content });
    const published = await api.call('artifacts.requestPublish', { artifactId, note: 'opinion with a reason' });
    expect(published.status).toBe('published');

    // A topic cannot be published without a URL.
    await expect(api.call('content.topics.update', { topicId: created.topic.id, status: 'published' })).rejects.toMatchObject({
      message: expect.stringContaining('canonical URL'),
    });
    const live = await api.call('content.topics.update', {
      topicId: created.topic.id,
      status: 'published',
      canonicalUrl: 'https://example.com/blog/second-month',
    });
    expect(live.topic).toMatchObject({
      status: 'published',
      canonicalUrl: 'https://example.com/blog/second-month',
      briefArtifactId: artifactId,
    });

    const archived = await api.call('content.topics.archive', { topicId: created.topic.id });
    expect(archived.topic).toMatchObject({
      status: 'archived',
      canonicalUrl: 'https://example.com/blog/second-month',
      briefArtifactId: artifactId,
    });
    expect((await api.call('content.topics.list', {})).topics.map((topic) => topic.id)).not.toContain(created.topic.id);
    expect((await api.call('content.topics.list', { status: 'archived' })).topics.map((topic) => topic.id)).toContain(created.topic.id);
    // The brief artifact is untouched by archiving.
    expect((await api.call('artifacts.get', { artifactId })).publishedVersion).toBe(1);
  });
});
