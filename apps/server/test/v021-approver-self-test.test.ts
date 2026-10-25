import { createClient } from '@agentic-marketing/client';
import { outbox } from '@agentic-marketing/email';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Commands } from '../src/registry';
import { eventually, rejects, startTestServer, type User } from './harness';

// Approvers can test-send from the approval drawer (#53): templates.sendTest and
// broadcasts.sendTest accept artifacts:approve when `to` is omitted, so the caller is the only
// recipient. Passing `to` still needs artifacts:write, and agents never get the alternative.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let approver: User;
let viewer: User;
let templateId = '';
let broadcastId = '';
const stamp = Date.now();
const subject = `Approver self test ${stamp}`;

const mjml = (body: string) =>
  `<mjml><mj-body><mj-section><mj-column><mj-text>${body}</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>`;

const mailTo = (to: string) => outbox.filter((m) => m.to === to);

beforeAll(async () => {
  t = await startTestServer('test_approver_selftest', 3405);
  owner = await t.signUp(`owner-selftest-${stamp}@example.com`);
  approver = await t.signUp(`approver-selftest-${stamp}@example.com`);
  viewer = await t.signUp(`viewer-selftest-${stamp}@example.com`);
  await t.workspaceWith([
    [owner, 'owner'],
    [approver, 'approver'],
    [viewer, 'viewer'],
  ]);
  const api = t.api(owner);
  await api.call('emailProviders.create', {
    name: 'Outbox',
    adapter: 'log',
    fromEmail: 'news@example.com',
    useFor: ['transactional', 'marketing'],
  });
  const template = await api.call('artifacts.create', {
    type: 'email_template',
    name: 'Approver self test',
    content: {
      purpose: 'marketing_email',
      subject,
      mjml: mjml('Approver self test body.'),
    },
  });
  templateId = template.artifactId;
  const segment = await api.call('artifacts.create', {
    type: 'segment',
    name: 'Approver self test segment',
    content: { condition: { consent: 'marketing_email' } },
  });
  const broadcast = await api.call('artifacts.create', {
    type: 'broadcast',
    name: 'Approver self test broadcast',
    content: { template: templateId, segment: segment.artifactId },
  });
  broadcastId = broadcast.artifactId;
}, 60_000);

afterAll(() => t?.close());

describe('an approver sending themselves a test', () => {
  it('sends one [Test] template copy to the caller and audits it', async () => {
    const api = t.api(approver);
    const result = await api.call('templates.sendTest', { artifactId: templateId });
    expect(result).toMatchObject({ to: approver.email, subject: `[Test] ${subject}`, provider: 'Outbox', recipients: [approver.email] });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ email: approver.email, status: 'sent', subject: `[Test] ${subject}` });

    const mail = await eventually(
      async () => mailTo(approver.email).filter((m) => m.subject === `[Test] ${subject}`),
      (m) => m.length === 1,
    );
    expect(mail).toHaveLength(1);

    const { messages } = await api.call('messages.list', { limit: 100 });
    expect(messages.find((m) => m.id === result.messages[0].messageId)).toMatchObject({
      test: true,
      templateId,
      status: 'sent',
      profileId: null,
    });
    const { entries } = await api.call('audit.list', { limit: 100 });
    expect(entries.some((e) => e.command === 'templates.sendTest' && e.target === templateId && e.ok)).toBe(true);
  });

  it('sends one [Test] broadcast copy to the caller', async () => {
    const api = t.api(approver);
    const result = await api.call('broadcasts.sendTest', { artifactId: broadcastId });
    expect(result).toMatchObject({ to: approver.email, subject: `[Test] ${subject}`, provider: 'Outbox', recipients: [approver.email] });
    expect(result.messages).toHaveLength(1);
    await eventually(
      async () => mailTo(approver.email).filter((m) => m.subject === `[Test] ${subject}`),
      (m) => m.length >= 2,
    );

    const { entries } = await api.call('audit.list', { limit: 100 });
    expect(entries.some((e) => e.command === 'broadcasts.sendTest' && e.target === broadcastId && e.ok)).toBe(true);
  });

  it('still needs artifacts:write as soon as `to` is passed, even the caller’s own address', async () => {
    const api = t.api(approver);
    const templateErr = await rejects(api.call('templates.sendTest', { artifactId: templateId, to: [approver.email] }));
    expect(templateErr.status).toBe(403);
    expect(templateErr.message).toContain('artifacts:write');
    const broadcastErr = await rejects(api.call('broadcasts.sendTest', { artifactId: broadcastId, to: [approver.email] }));
    expect(broadcastErr.status).toBe(403);
    expect(broadcastErr.message).toContain('artifacts:write');
  });

  it('does not let a viewer send a test, with or without `to`', async () => {
    const api = t.api(viewer);
    const err = await rejects(api.call('templates.sendTest', { artifactId: templateId }));
    expect(err.status).toBe(403);
    expect(err.message).toContain('artifacts:write');
    const withTo = await rejects(api.call('broadcasts.sendTest', { artifactId: broadcastId, to: [viewer.email] }));
    expect(withTo.status).toBe(403);
  });

  it('does not let an agent/API token use the approver alternative', async () => {
    const approverApi = t.api(approver);
    const tok = await approverApi.call('apiTokens.create', { name: 'approver agent', scopes: ['artifacts:read', 'artifacts:approve'] });
    expect(tok.scopes).toEqual(['artifacts:read', 'artifacts:approve']);
    const agent = createClient<Commands>({ baseUrl: t.base, headers: { authorization: `Bearer ${tok.token}` } });
    const err = await rejects(agent.call('templates.sendTest', { artifactId: templateId }));
    expect(err.status).toBe(403);
    expect(err.message).toContain('artifacts:write');
    const withTo = await rejects(agent.call('broadcasts.sendTest', { artifactId: broadcastId, to: [approver.email] }));
    expect(withTo.status).toBe(403);
  });
});
