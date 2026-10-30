import { clearAnalyticsCache } from '@agentic-marketing/analytics';
import { outbox } from '@agentic-marketing/email';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAgent, eventually, startTestServer, testPort, type User } from './harness';

// Issue #149: the weekly pilot loop over MCP. An agent drafts a reusable block, this week's
// template and the broadcast that sends it, and submits all three as one review. A person
// approves; the broadcast goes out to the consent segment; the agent reports the result. This is
// the product-side contract the external Hermes/n8n workflows rely on: a changed tool name,
// schema or approval rule must fail here, not on a Friday.

type Agent = Awaited<ReturnType<typeof connectAgent>>;

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let agent: Agent;

const PORT = testPort(3430);
const stamp = Date.now();
const SUBSCRIBERS = ['Ada', 'Bo', 'Cy', 'Dan', 'Eve'].map((name) => ({
  name,
  email: `${name.toLowerCase()}-pilot-${stamp}@example.com`,
  userId: `pilot-${name.toLowerCase()}-${stamp}`,
}));
const SUBJECT = `The pilot loop ${stamp}`;
const FROM_EMAIL = 'news@pilot.example.com';

const ids = { segment: '', block: '', template: '', broadcast: '', bundleId: '', approvalId: '' };
let sourceKey = '';

const blockContent = {
  description: 'The header this week’s issue uses',
  category: 'header' as const,
  mjml: '<mj-section><mj-column><mj-text font-size="22px">{{ block.title }}</mj-text></mj-column></mj-section>',
  params: [{ key: 'title', label: 'Title', type: 'text' as const, required: true }],
};

const templateMjml = (blockId: string) => `<mjml><mj-body>
  {% block '${blockId}', title: 'The pilot loop' %}
  <mj-section><mj-column>
    <mj-text>Hi {{ profile.firstName | default: "there" }}, this week the loop closed itself.</mj-text>
  </mj-column></mj-section>
  <mj-section><mj-column>
    <mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text>
  </mj-column></mj-section>
</mj-body></mjml>`;

/** Calls a tool and returns its structured content, failing loudly with the tool's own message. */
async function call(client: Agent, name: string, args: Record<string, unknown>) {
  const res = (await client.client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: { text: string }[];
  };
  if (res.isError) throw new Error(`${name} failed: ${res.content?.[0]?.text ?? 'unknown tool error'}`);
  return res.structuredContent as any;
}

const mailTo = (to: string) => outbox.filter((m) => m.to === to && m.subject === SUBJECT);
const column = (result: any, name: string) => result.columns.findIndex((c: { name: string }) => c.name === name);

beforeAll(async () => {
  t = await startTestServer('test_pilot_loop_mcp', PORT);
  owner = await t.signUp(`owner-pilot-${stamp}@example.com`);
  await t.workspaceWith([[owner, 'owner']], 'agent_changes');

  // Setup is the person's own work, over REST: a provider, a source, the subscribers with their
  // consent, and a published consent segment. The loop itself is all MCP.
  const api = t.api(owner);
  await api.call('emailProviders.create', {
    name: 'Pilot outbox',
    adapter: 'log',
    fromEmail: FROM_EMAIL,
    useFor: ['transactional', 'marketing'],
  });
  sourceKey = (await api.call('sources.create', { name: 'Pilot backend', kind: 'server' })).key;
  ids.segment = (
    await api.call('artifacts.create', {
      type: 'segment',
      name: 'Pilot subscribers',
      content: { condition: { consent: 'marketing_email' } },
    })
  ).artifactId;
  await api.call('artifacts.requestPublish', { artifactId: ids.segment, note: 'The pilot audience' });

  const batch = SUBSCRIBERS.flatMap((s) => [
    { type: 'identify', userId: s.userId, traits: { email: s.email, firstName: s.name } },
    {
      type: 'track',
      event: 'Segment Consent Preference Updated',
      userId: s.userId,
      context: { consent: { categoryPreferences: { marketing_email: true } } },
    },
  ]);
  const ingested = await fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${sourceKey}:`).toString('base64')}` },
    body: JSON.stringify({ batch }),
  });
  expect(ingested.ok).toBe(true);
  await eventually(
    () => api.call('segments.members', { artifactId: ids.segment }),
    (r) => r.members.length === SUBSCRIBERS.length,
  );

  agent = await connectAgent(t.base, owner, ['artifacts:read', 'artifacts:write', 'artifacts:publish', 'profiles:read']);
}, 60_000);

afterAll(async () => {
  await agent?.client.close();
  await t?.close();
});

describe('the pilot loop over MCP', () => {
  it('an agent drafts a block, template and broadcast and submits them as one review', async () => {
    const tools = (await agent.client.listTools()).tools.map((x) => x.name);
    // A tool/schema rename shows up here first, with the wording the agent guide teaches.
    expect(tools).toEqual(
      expect.arrayContaining([
        'artifacts.create',
        'artifacts.requestPublishBundle',
        'blocks.preview',
        'broadcasts.preview',
        'broadcasts.status',
        'approvals.list',
        'analytics.query',
        'messages.list',
        'messages.stats',
      ]),
    );

    ids.block = (await call(agent, 'artifacts.create', { type: 'email_block', name: 'Pilot header', content: blockContent })).artifactId;
    const blockPreview = await call(agent, 'blocks.preview', { artifactId: ids.block, params: { title: 'The pilot loop' } });
    expect(blockPreview.html).toContain('The pilot loop');

    ids.template = (
      await call(agent, 'artifacts.create', {
        type: 'email_template',
        name: `Pilot issue ${stamp}`,
        content: {
          purpose: 'marketing_email',
          subject: SUBJECT,
          mjml: templateMjml(ids.block),
          sampleData: { profile: { firstName: 'Ada' } },
        },
      })
    ).artifactId;
    ids.broadcast = (
      await call(agent, 'artifacts.create', {
        type: 'broadcast',
        name: `Send ${SUBJECT}`,
        content: { template: ids.template, segment: ids.segment },
      })
    ).artifactId;

    const bundle = await call(agent, 'artifacts.requestPublishBundle', {
      artifactIds: [ids.broadcast, ids.template, ids.block],
      note: 'Friday pilot issue: the header, the template and the send, for one review.',
    });
    expect(bundle).toMatchObject({ status: 'in_review', policy: 'agent_changes' });
    expect(bundle.bundleId).toBeTruthy();
    // Publish order, regardless of the order submitted: references come first.
    expect(bundle.members.map((m: { artifactId: string }) => m.artifactId)).toEqual([ids.block, ids.template, ids.broadcast]);
    // The review opens on the send, the artifact the others exist for.
    expect(bundle.reviewUrl).toContain(bundle.members[2].approvalId);
    ids.bundleId = bundle.bundleId;
    ids.approvalId = bundle.members[2].approvalId;

    // The agent can show the reviewer the reach before anyone decides, and nothing has gone out.
    const reach = await call(agent, 'broadcasts.preview', {
      artifactId: ids.broadcast,
      templateVersion: bundle.members[1].version,
    });
    expect(reach).toMatchObject({ audience: SUBSCRIBERS.length, wouldSend: SUBSCRIBERS.length });
    expect(outbox.filter((m) => m.subject === SUBJECT)).toHaveLength(0);

    const api = t.api(owner);
    for (const artifactId of [ids.block, ids.template, ids.broadcast]) {
      const a = await api.call('artifacts.get', { artifactId });
      expect(a.publishedVersion).toBeNull();
      expect(a.version.state).toBe('in_review');
    }
    expect((await api.call('broadcasts.status', { artifactId: ids.broadcast })).run.status).toBe('not_scheduled');
  });

  it('shows the agent the pending bundle but never the power to approve it', async () => {
    const { approvals } = await call(agent, 'approvals.list', {});
    const pending = approvals.filter((a: { bundle?: { id: string } | null }) => a.bundle?.id === ids.bundleId);
    expect(pending).toHaveLength(3);
    expect(pending.map((a: { artifactId: string }) => a.artifactId).sort()).toEqual([ids.block, ids.template, ids.broadcast].sort());
    expect(pending.every((a: { status: string }) => a.status === 'pending')).toBe(true);
    expect(pending.every((a: { requestedBy: { type: string } }) => a.requestedBy.type === 'agent')).toBe(true);
    expect(pending[0].bundle.members.map((m: { artifactId: string }) => m.artifactId)).toEqual([ids.block, ids.template, ids.broadcast]);

    // approvals.approve/reject are people-only: not registered as tools, and a raw call fails.
    const tools = (await agent.client.listTools()).tools.map((x) => x.name);
    expect(tools).not.toContain('approvals.approve');
    expect(tools).not.toContain('approvals.reject');
    let refused = false;
    try {
      const res = await agent.client.callTool({ name: 'approvals.approve', arguments: { approvalId: ids.approvalId } });
      refused = Boolean(res.isError);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });

  it('a person approves, and the broadcast goes out to every subscriber once', async () => {
    const api = t.api(owner);
    const approved = await api.call('approvals.approve', { approvalId: ids.approvalId, note: 'Looks good: send it' });
    expect(approved.published).toEqual([
      { artifactId: ids.block, version: 1 },
      { artifactId: ids.template, version: 1 },
      { artifactId: ids.broadcast, version: 1 },
    ]);
    for (const artifactId of [ids.block, ids.template, ids.broadcast])
      expect((await api.call('artifacts.get', { artifactId })).publishedVersion).toBe(1);

    // The agent sees the decision on the same bundle it submitted.
    const decided = await call(agent, 'approvals.list', { status: 'approved' });
    expect(decided.approvals.filter((a: { bundle?: { id: string } | null }) => a.bundle?.id === ids.bundleId)).toHaveLength(3);

    // The scheduler picks the published broadcast up and the log adapter records one copy per person.
    const status = await eventually(
      () => call(agent, 'broadcasts.status', { artifactId: ids.broadcast }),
      (s) => s.run.status === 'done' && (s.messages.sent ?? 0) === SUBSCRIBERS.length,
      20_000,
    );
    expect(status.run).toMatchObject({ status: 'done', recipients: SUBSCRIBERS.length, queued: SUBSCRIBERS.length, skipped: 0 });
    for (const subscriber of SUBSCRIBERS) {
      const mail = await eventually(
        async () => mailTo(subscriber.email),
        (m) => m.length >= 1,
        10_000,
      );
      expect(mail).toHaveLength(1);
      expect(mail[0].from.email).toBe(FROM_EMAIL);
      expect(mail[0].html).toContain('/u/');
      expect(mail[0].headers['List-Unsubscribe']).toMatch(/\/u\//);
      expect(mail[0].headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    }

    // Audit keeps the handoff verifiable: the agent submitted over MCP, the person approved over REST.
    const { entries } = await api.call('audit.list', { limit: 200 });
    expect(entries.find((e) => e.command === 'artifacts.requestPublishBundle' && e.ok)).toMatchObject({
      surface: 'mcp',
      principalType: 'agent',
      clientId: agent.clientId,
    });
    expect(entries.find((e) => e.command === 'approvals.approve' && e.ok)).toMatchObject({
      surface: 'rest',
      principalType: 'user',
      principalId: owner.id,
    });
  });

  it('the agent measures the loop, and status, analytics and messages agree', async () => {
    const status = await call(agent, 'broadcasts.status', { artifactId: ids.broadcast });
    expect(status.run.status).toBe('done');
    expect(status.messages.sent).toBe(SUBSCRIBERS.length);

    // ClickHouse is written asynchronously; analytics.query caches per input for a minute, so
    // clear it between attempts instead of re-reading a stale zero.
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const byBroadcast = await eventually(
      () => {
        clearAnalyticsCache();
        return call(agent, 'analytics.query', {
          measures: ['email.sent'],
          dimensions: ['broadcast'],
          from,
          to: new Date().toISOString(),
        });
      },
      (r) => {
        const b = column(r, 'broadcast');
        const s = column(r, 'email.sent');
        return r.rows.length === 1 && r.rows[0][b] === ids.broadcast && r.rows[0][s] === SUBSCRIBERS.length;
      },
      20_000,
    );
    expect(byBroadcast.rows).toHaveLength(1);
    expect(byBroadcast.rows[0][column(byBroadcast, 'broadcast')]).toBe(ids.broadcast);
    expect(byBroadcast.rows[0][column(byBroadcast, 'email.sent')]).toBe(SUBSCRIBERS.length);

    const stats = await eventually(
      () => call(agent, 'messages.stats', { days: 1, templateId: ids.template }),
      (r) => (r.counts.sent ?? 0) === SUBSCRIBERS.length,
      20_000,
    );
    expect(stats.counts.sent).toBe(SUBSCRIBERS.length);

    const { messages } = await eventually(
      () => call(agent, 'messages.list', { purpose: 'marketing_email', channel: 'email', limit: 50 }),
      (r) =>
        r.messages.length === SUBSCRIBERS.length &&
        r.messages.every((m: { status: string }) => m.status === 'sent' || m.status === 'delivered'),
      10_000,
    );
    expect(messages).toHaveLength(SUBSCRIBERS.length);
    expect(new Set(messages.map((m: { profileId: string }) => m.profileId)).size).toBe(SUBSCRIBERS.length);
    expect(
      messages.every((m: { templateId: string; templateVersion: number }) => m.templateId === ids.template && m.templateVersion === 1),
    ).toBe(true);
    expect(messages.every((m: { purpose: string }) => m.purpose === 'marketing_email')).toBe(true);
  });
});
