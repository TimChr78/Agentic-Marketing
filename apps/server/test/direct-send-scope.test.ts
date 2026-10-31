import type { ArtifactType } from '@agentic-marketing/artifacts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// #278: a mandate's scope covers every way to reach people, SMS and push included. A direct
// `messages.sendSms`/`messages.sendPush` reports the template's purpose/topic and its channel, so
// `channels: ['email']` refuses them, and the ledger links the message each one created.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let token = '';
let agentId = '';
let sms = '';
let push = '';
let ada = '';

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const purposes = ['marketing_email', 'marketing_sms', 'marketing_push'];

beforeAll(async () => {
  t = await startTestServer('test_direct_send_scope', testPort(3484));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner);
  await api.call('emailProviders.create', { name: 'Outbox', adapter: 'log', fromEmail: 'news@example.com', useFor: ['marketing'] });
  await api.call('smsProviders.create', { name: 'Texts', adapter: 'log', sender: 'Signal', useFor: ['marketing'] });
  await api.call('pushProviders.create', { name: 'Notifications', adapter: 'log', useFor: ['marketing'] });

  const template = async (type: ArtifactType, name: string, content: Record<string, unknown>) => {
    const created = await api.call('artifacts.create', { type, name, content });
    expect((await api.call('artifacts.requestPublish', { artifactId: created.artifactId, note: 'setup' })).status).toBe('published');
    return created.artifactId as string;
  };
  sms = await template('sms_template', 'Signal text', { purpose: 'marketing_sms', body: 'Hej {{ profile.firstName }}, news this week' });
  push = await template('push_template', 'Signal notification', {
    purpose: 'marketing_push',
    title: 'Hej {{ profile.firstName }}',
    body: 'News this week',
  });

  await api.call('profiles.import', {
    label: 'Direct send scope test',
    rows: [
      {
        email: 'ada@example.com',
        userId: 'ada',
        traits: { phone: '+4512345678', firstName: 'Ada' },
        consent: purposes.map((purpose) => ({ purpose, status: 'granted' as const })),
      },
    ],
  });
  ada = (
    await eventually(
      () => api.call('profiles.find', { type: 'user_id', value: 'ada' }),
      (r) => !!r.profileId,
    )
  ).profileId as string;

  // One device, so a push send has somewhere to go; the log adapter sends nothing.
  const { key } = await api.call('sources.create', { name: 'App backend', kind: 'server' });
  const subscribed = await fetch(`${t.base}/v1/push/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({ userId: 'ada', kind: 'fcm', token: 'fcm-token-0123456789' }),
  });
  expect(subscribed.status).toBe(200);

  token = (await api.call('apiTokens.create', { name: 'Direct sender', scopes: ['artifacts:read', 'messages:send'] })).token;
  agentId = (await call('agents.get')).body.id;
  await api.call('workspace.setAutonomy', { maxLevel: { 'send.direct': 3 } });
}, 120_000);
afterAll(() => t?.close());

async function call(name: string, body: unknown = {}) {
  const res = await fetch(`${t.base}/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** A person publishes a mandate for the agent: the same artifact, so a new grant is its next version. */
let mandateId = '';
async function grant(content: Record<string, unknown>) {
  const api = t.api(owner);
  const draft = { agent: agentId, purpose: 'Send direct messages', validUntil: inDays(30), levels: { 'send.direct': 3 }, ...content };
  mandateId = mandateId
    ? ((await api.call('artifacts.updateDraft', { artifactId: mandateId, content: draft as never, note: 'a wider scope' }))
        .artifactId as string)
    : ((await api.call('artifacts.create', { type: 'agent_mandate', name: 'Direct-send mandate', content: draft as never }))
        .artifactId as string);
  const out = await api.call('artifacts.requestPublish', { artifactId: mandateId, note: 'grant' });
  expect(out.status).toBe('published');
  return mandateId;
}

const lastAction = async (decision: 'allow' | 'ask' | 'deny' | 'hold' = 'allow') =>
  (await t.api(owner).call('agents.activity', { agentId, decision, actionClass: 'send.direct', limit: 1 })).actions[0];

describe('mandate scope covers SMS and push direct sends (#278)', () => {
  beforeAll(async () => {
    await grant({ scope: { purposes, topics: [], channels: ['email'] } });
  });

  it('refuses an SMS when the mandate allows only e-mail', async () => {
    const out = await call('messages.sendSms', { profileId: ada, templateId: sms });
    expect(out.status).toBe(403);
    expect(out.body.message).toContain('Channel sms is outside this agent’s mandate');

    const denied = await lastAction('deny');
    expect(denied).toMatchObject({ command: 'messages.sendSms', actionClass: 'send.direct', decision: 'deny', ok: false });
    expect(denied.impact.touches).toMatchObject({ purposes: ['marketing_sms'], channels: ['sms'] });
  });

  it('refuses a push notification when the mandate allows only e-mail', async () => {
    const out = await call('messages.sendPush', { profileId: ada, templateId: push });
    expect(out.status).toBe(403);
    expect(out.body.message).toContain('Channel push is outside this agent’s mandate');

    const denied = await lastAction('deny');
    expect(denied).toMatchObject({ command: 'messages.sendPush', actionClass: 'send.direct', decision: 'deny', ok: false });
    expect(denied.impact.touches).toMatchObject({ purposes: ['marketing_push'], channels: ['push'] });
  });

  it('runs them inside the scope, and the ledger links the message each created', async () => {
    await grant({ scope: { purposes, topics: [], channels: ['email', 'sms', 'push'] } });

    const text = await call('messages.sendSms', { profileId: ada, templateId: sms });
    expect(text.status).toBe(200);
    expect(text.body).toMatchObject({ status: 'queued', messageId: expect.stringMatching(/^msg_/) });

    const notification = await call('messages.sendPush', { profileId: ada, templateId: push });
    expect(notification.status).toBe(200);
    expect(notification.body).toMatchObject({ status: 'queued', messageId: expect.stringMatching(/^msg_/) });

    const { actions } = await t.api(owner).call('agents.activity', { agentId, actionClass: 'send.direct', limit: 5 });
    const byCommand = (command: string) => actions.find((a: { command: string }) => a.command === command);
    expect(byCommand('messages.sendSms')!.impact).toMatchObject({
      people: 1,
      messageId: text.body.messageId,
      touches: { purposes: ['marketing_sms'], channels: ['sms'] },
    });
    expect(byCommand('messages.sendPush')!.impact).toMatchObject({
      people: 1,
      messageId: notification.body.messageId,
      touches: { purposes: ['marketing_push'], channels: ['push'] },
    });
  });
});
