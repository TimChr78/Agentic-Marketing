import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// #265: a mandate's guardrails judge the agent's own sends, direct ones included. The old check
// only looked at broadcast ledger targets, so `messages.sendEmail` (send.direct) never fired one.

const PORT = testPort(2652);
const mjml =
  '<mjml><mj-body><mj-section><mj-column><mj-text>Hej</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>';
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let token = '';
let agentId = '';
let templateId = '';
let profiles: string[] = [];

const agentCall = async (name: string, body: unknown = {}) => {
  const res = await fetch(`${t.base}/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

beforeAll(async () => {
  t = await startTestServer('test_guardrails_direct', PORT);
  owner = await t.signUp(`owner-guardrails-direct-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner, ws);
  await api.call('emailProviders.create', { name: 'Outbox', adapter: 'log', fromEmail: 'news@example.com', useFor: ['marketing'] });
  const tpl = await api.call('artifacts.create', {
    type: 'email_template',
    name: 'Direct issue',
    content: { purpose: 'marketing_email', subject: 'This week', mjml },
  });
  await api.call('artifacts.requestPublish', { artifactId: tpl.artifactId, note: 'setup' });
  templateId = tpl.artifactId;
  await api.call('profiles.import', {
    label: 'Guardrails direct test',
    rows: ['ada', 'bo', 'cy'].map((name) => ({
      email: `${name}@example.com`,
      consent: [{ purpose: 'marketing_email', status: 'granted' as const }],
    })),
  });
  profiles = await eventually(
    async () =>
      (await t.srv.db.admin.query<{ id: string }>('SELECT id FROM profiles WHERE workspace_id = $1 ORDER BY created_at', [ws])).rows.map(
        (r) => r.id,
      ),
    (ids) => ids.length === 3,
  );
  await api.call('workspace.setAutonomy', { maxLevel: { 'send.direct': 3 } });
  token = (await api.call('apiTokens.create', { name: 'Direct sender', scopes: ['artifacts:read', 'messages:send'] })).token;
  agentId = (await agentCall('agents.get')).body.id;
  const mandate = await api.call('artifacts.create', {
    type: 'agent_mandate',
    name: 'Direct-send mandate',
    content: {
      agent: agentId,
      purpose: 'Send direct e-mail to people who asked for it',
      validUntil: inDays(30),
      scope: { purposes: ['marketing_email'], channels: ['email'] },
      levels: { 'send.direct': 3 },
      guardrails: { unsubscribeRate: 0.005, window: 'P7D', minSent: 1 },
    } as never,
  });
  expect((await api.call('artifacts.requestPublish', { artifactId: mandate.artifactId, note: 'grant' })).status).toBe('published');
}, 90_000);

afterAll(() => t?.close());

describe('guardrails on direct sends (#265)', () => {
  it('a direct send that drove unsubscribes makes the next send ask for a person', async () => {
    for (const profileId of profiles) {
      const sent = await agentCall('messages.sendEmail', { profileId, templateId });
      expect(sent.status).toBe(200);
      expect(sent.body.status).toBe('queued');
    }

    // The ledger links each direct send to the message it created, so the guardrail can find them.
    const { actions } = await t.api(owner, ws).call('agents.activity', { agentId, actionClass: 'send.direct', limit: 10 });
    expect(actions).toHaveLength(3);
    const messageIds = actions
      .map((a: { impact: { messageId?: string } }) => a.impact.messageId)
      .filter((id): id is string => typeof id === 'string');
    expect(messageIds).toHaveLength(3);
    expect(messageIds.every((id) => id.startsWith('msg_'))).toBe(true);

    // Wait until ClickHouse has the sent events, then let two of the three recipients unsubscribe.
    await eventually(
      () => t.srv.events.messageStats(ws, { since: new Date(Date.now() - 3_600_000), messageIds }),
      (stats) => (stats.sent ?? 0) === 3,
      20_000,
    );
    const recipients = await t.srv.db.admin.query<{ id: string; profile_id: string }>(
      `SELECT id, profile_id FROM messages WHERE workspace_id = $1 AND id = ANY($2) ORDER BY created_at`,
      [ws, messageIds],
    );
    await t.srv.events.insertMessageEvents(
      recipients.rows.slice(0, 2).map((m) => ({
        workspaceId: ws,
        messageId: m.id,
        eventId: `unsub:${m.id}`,
        type: 'unsubscribed' as const,
        at: new Date().toISOString(),
        profileId: m.profile_id,
        channel: 'email',
        purpose: 'marketing_email',
        provider: 'log',
        templateId,
        templateVersion: 1,
        journeyId: '',
        reason: '',
        url: '',
      })),
    );
    await eventually(
      () => t.srv.events.messageStats(ws, { since: new Date(Date.now() - 3_600_000), messageIds }),
      (stats) => (stats.unsubscribed ?? 0) === 2,
      20_000,
    );

    // send.direct is not approvable: a breach refuses the send and says why.
    const refused = await agentCall('messages.sendEmail', { profileId: profiles[2], templateId });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toMatch(/unsubscribe rate of .*above its mandate’s guardrail of 0\.5%/);
  }, 60_000);
});
