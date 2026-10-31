import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyWebhook } from '@agentic-marketing/integrations';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runAgentEventsOnce } from '../src/agents/events';
import { eventually, startTestServer, testPort, type User } from './harness';

// Wave 4, Phase 20 (#312): agents subscribe to what their loop reacts to instead of polling. The
// sweep is driven directly with a clock-free call, like the notification and alert tests, so no
// test waits for a tick. A local receiver plays the agent's webhook.

const PORT = testPort(3325);
const DAY = 86_400_000;

let t: Awaited<ReturnType<typeof startTestServer>>;

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}
const received: Received[] = [];
let receiverUrl = '';
const receiver = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ path: req.url ?? '', headers: req.headers, body });
    res.statusCode = 200;
    res.end('ok');
  });
});
const at = (path: string) => received.filter((r) => r.path === path);

beforeAll(async () => {
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  t = await startTestServer('test_agent_events', PORT);
}, 90_000);

beforeEach(() => {
  received.length = 0;
});

afterAll(async () => {
  await t?.close();
  receiver.close();
});

const run = () => runAgentEventsOnce({ db: t.srv.db });
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString();

const agentCall = async (token: string, name: string, body: unknown = {}) => {
  const res = await fetch(`${t.base}/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

interface Setup {
  owner: User;
  ws: string;
  token: string;
  agentId: string;
  api: ReturnType<typeof t.api>;
}

let unique = 0;

/** A fresh workspace with one agent, its sponsor and a mandate that holds content publishes for a veto window. */
async function setup(opts: { level?: number } = {}): Promise<Setup> {
  const n = ++unique;
  const owner = await t.signUp(`owner-agent-events-${n}-${Date.now()}@example.com`);
  const ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner, ws);
  await api.call('workspace.setAutonomy', { maxLevel: { 'content.publish': 3 } });
  const token = (
    await api.call('apiTokens.create', {
      name: 'Event agent',
      scopes: ['artifacts:read', 'artifacts:write', 'artifacts:publish'],
    })
  ).token as string;
  const agentId = (await agentCall(token, 'agents.get')).body.id as string;
  const mandate = await api.call('artifacts.create', {
    type: 'agent_mandate',
    name: 'Events mandate',
    content: {
      agent: agentId,
      purpose: 'Test agent event subscriptions',
      validUntil: inDays(30),
      levels: { 'content.publish': opts.level ?? 2 },
    } as never,
  });
  expect((await api.call('artifacts.requestPublish', { artifactId: mandate.artifactId, note: 'grant' })).status).toBe('published');
  return { owner, ws, token, agentId, api };
}

/** An agent drafts a note and asks to publish it; at level 2 it waits in a veto window. */
async function heldNote(s: Setup, title: string) {
  const created = await agentCall(s.token, 'artifacts.create', {
    type: 'note',
    name: title,
    content: { title, body: 'A note from the agent under test.' },
  });
  expect(created.status).toBe(200);
  const held = await agentCall(s.token, 'artifacts.requestPublish', { artifactId: created.body.artifactId, note: `${title}: intent` });
  expect(held.body.status).toBe('on_hold');
  return held.body as { approvalId: string; artifactId: string; version: number };
}

describe('agent event subscriptions (#312)', () => {
  it('an agent subscribes to approval.decided and hold.vetoed and pulls both with ids and no personal data', async () => {
    const s = await setup();
    const sub = await agentCall(s.token, 'agents.subscribe', { eventTypes: ['approval.decided', 'hold.vetoed'] });
    expect(sub.status).toBe(200);
    expect(sub.body).toMatchObject({ agentId: s.agentId, eventTypes: ['approval.decided', 'hold.vetoed'], webhookId: null });

    const approved = await heldNote(s, 'Approved one');
    const vetoed = await heldNote(s, 'Vetoed one');
    await s.api.call('approvals.approve', { approvalId: approved.approvalId });
    await s.api.call('approvals.reject', { approvalId: vetoed.approvalId, note: 'Not this one' });

    const round = await run();
    expect(round.delivered).toBeGreaterThanOrEqual(2);

    const out = await agentCall(s.token, 'agents.events');
    const events = out.body.events as { id: number; type: string; summary: string; subject: Record<string, unknown>; at: string }[];
    expect(events.map((e) => e.type)).toContain('approval.decided');
    expect(events.map((e) => e.type)).toContain('hold.vetoed');
    for (const event of events) {
      expect(event.id).toBeGreaterThan(0);
      expect(event.at).toBeTruthy();
      expect(event.summary.length).toBeGreaterThan(0);
    }
    expect(events.find((e) => e.type === 'approval.decided')?.subject.approvalId).toBe(approved.approvalId);
    expect(events.find((e) => e.type === 'hold.vetoed')?.subject.approvalId).toBe(vetoed.approvalId);
    expect(out.body.cursor).toBe(events.at(-1)?.id);

    // The event carries ids and a summary, never the person who decided or an address.
    const text = JSON.stringify(out.body);
    expect(text).not.toContain(s.owner.email);
    expect(text).not.toContain(s.owner.id);

    // The cursor makes a second pull silent, and the same derived event is not recorded twice.
    const again = await agentCall(s.token, 'agents.events', { after: out.body.cursor });
    expect(again.body.events).toHaveLength(0);
    await run();
    const still = await agentCall(s.token, 'agents.events');
    expect(still.body.events).toHaveLength(events.length);
  }, 40_000);

  it('a subscription with a webhook receives a signed delivery', async () => {
    const s = await setup();
    const endpoint = await s.api.call('webhooks.create', { name: 'Agent events', url: `${receiverUrl}/agent-events` });
    const sub = await agentCall(s.token, 'agents.subscribe', { eventTypes: ['approval.decided'], webhookId: endpoint.id });
    expect(sub.status).toBe(200);

    const held = await heldNote(s, 'Webhook one');
    await s.api.call('approvals.approve', { approvalId: held.approvalId });
    const round = await run();
    expect(round.webhooks).toBeGreaterThanOrEqual(1);

    const got = await eventually(
      async () => at('/agent-events'),
      (rows) => rows.length >= 1,
    );
    expect(got).toHaveLength(1);
    const headers = got[0].headers as Record<string, string | undefined>;
    expect(got[0].headers['webhook-id']).toBeTruthy();
    expect(verifyWebhook(endpoint.secret, headers, got[0].body)).toBe(true);
    expect(verifyWebhook(endpoint.secret, headers, got[0].body.replace('approved', 'rejected'))).toBe(false);
    const payload = JSON.parse(got[0].body);
    expect(payload).toMatchObject({
      type: 'agent.event',
      data: { event: { type: 'approval.decided', subject: { approvalId: held.approvalId } } },
    });
    expect(got[0].body).not.toContain(s.owner.email);
    expect(got[0].body).not.toContain(s.owner.id);
  }, 40_000);

  it('an agent cannot subscribe another agent', async () => {
    const s = await setup();
    const otherToken = (await s.api.call('apiTokens.create', { name: 'Other agent', scopes: ['artifacts:read', 'artifacts:write'] }))
      .token as string;
    const otherId = (await agentCall(otherToken, 'agents.get')).body.id as string;
    expect(otherId).not.toBe(s.agentId);

    const refused = await agentCall(s.token, 'agents.subscribe', { agentId: otherId, eventTypes: ['alert.fired'] });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toContain('own subscriptions');

    // A person can subscribe either agent.
    const byPerson = await s.api.call('agents.subscribe', { agentId: otherId, eventTypes: ['alert.fired'] });
    expect(byPerson.agentId).toBe(otherId);
  }, 40_000);

  it('unsubscribing stops delivery', async () => {
    const s = await setup();
    const sub = await agentCall(s.token, 'agents.subscribe', { eventTypes: ['approval.decided'] });
    const first = await heldNote(s, 'Before unsubscribe');
    await s.api.call('approvals.approve', { approvalId: first.approvalId });
    await run();
    const before = await agentCall(s.token, 'agents.events');
    expect(before.body.events.length).toBeGreaterThan(0);

    expect((await agentCall(s.token, 'agents.unsubscribe', { id: sub.body.id })).body).toEqual({ deleted: true });
    expect((await agentCall(s.token, 'agents.subscriptions')).body.subscriptions).toHaveLength(0);

    const second = await heldNote(s, 'After unsubscribe');
    await s.api.call('approvals.approve', { approvalId: second.approvalId });
    await run();
    const after = await agentCall(s.token, 'agents.events', { after: before.body.cursor });
    expect(after.body.events).toHaveLength(0);
  }, 40_000);
});
