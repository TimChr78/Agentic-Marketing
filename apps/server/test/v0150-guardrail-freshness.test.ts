import { dispatchOutboxOnce } from '@agentic-marketing/audience';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runGuardianOnce } from '../src/agents/guardian';
import { eventually, startTestServer, testPort, type User } from './harness';

// #1008: a safety decision before a send must not miss message events that the transaction
// committed and the outbox has not published yet. Before 0.15.0 those events were written to
// ClickHouse during the request, so the published view could never lag behind a commit. While an
// agent's own publication is behind (or a row was dead-lettered), its guardrails now also read the
// message log and consent ledger, which can only make a verdict stricter.

const PORT = testPort(2653);
const mjml =
  '<mjml><mj-body><mj-section><mj-column><mj-text>Hej</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>';
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

let t: Awaited<ReturnType<typeof startTestServer>>;
let unique = 0;

const agentCall = async (token: string, name: string, body: unknown = {}) => {
  const res = await fetch(`${t.base}/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

const deps = () => ({
  db: t.srv.db,
  services: t.srv.services,
  kp: t.srv.keyProvider,
  email: t.srv.email,
  directory: t.srv.directory,
  publicUrl: t.base,
});

interface Setup {
  owner: User;
  ws: string;
  api: ReturnType<typeof t.api>;
  token: string;
  agentId: string;
  templateId: string;
  profiles: string[];
  webhookUrl: string;
}

/** A workspace with a direct-send agent whose mandate judges one of the three rates. */
async function setup(guardrails: Record<string, unknown>): Promise<Setup> {
  const n = ++unique;
  const owner = await t.signUp(`owner-guardrail-freshness-${n}-${Date.now()}@example.com`);
  const ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner, ws);
  // The log adapter sends nothing, so this stays offline. The guardian's transactional mail and
  // the direct sends both use it.
  await api.call('emailProviders.create', {
    name: 'Outbox',
    adapter: 'log',
    fromEmail: 'news@example.com',
    useFor: ['marketing', 'transactional'],
  });
  // A provider webhook is how a bounce or complaint reaches the message log and the outbox. It
  // carries the message id, which is all the delivery path needs; nothing is sent through it.
  const provider = await api.call('emailProviders.create', {
    name: 'Provider events',
    adapter: 'brevo',
    config: {},
    secrets: { apiKey: 'xkeysib-0123456789abcdef' },
    fromEmail: 'news@example.com',
    useFor: [],
  });
  const tpl = await api.call('artifacts.create', {
    type: 'email_template',
    name: 'Direct issue',
    content: { purpose: 'marketing_email', subject: 'This week', mjml },
  });
  await api.call('artifacts.requestPublish', { artifactId: tpl.artifactId, note: 'setup' });
  await api.call('profiles.import', {
    label: 'Guardrail freshness test',
    rows: ['ada', 'bo', 'cy'].map((name) => ({
      email: `${name}@example.com`,
      consent: [{ purpose: 'marketing_email', status: 'granted' as const }],
    })),
  });
  const profiles = await eventually(
    async () =>
      (await t.srv.db.admin.query<{ id: string }>('SELECT id FROM profiles WHERE workspace_id = $1 ORDER BY created_at', [ws])).rows.map(
        (r) => r.id,
      ),
    (ids) => ids.length === 3,
  );
  await api.call('workspace.setAutonomy', { maxLevel: { 'send.direct': 3 } });
  const token = (await api.call('apiTokens.create', { name: 'Direct sender', scopes: ['artifacts:read', 'messages:send'] })).token;
  const agentId = (await agentCall(token, 'agents.get')).body.id as string;
  const mandate = await api.call('artifacts.create', {
    type: 'agent_mandate',
    name: 'Guardrail freshness mandate',
    content: {
      agent: agentId,
      purpose: 'Send direct e-mail to people who asked for it',
      validUntil: inDays(30),
      scope: { purposes: ['marketing_email'], channels: ['email'] },
      levels: { 'send.direct': 3 },
      guardrails: { window: 'P7D', minSent: 1, ...guardrails },
    } as never,
  });
  expect((await api.call('artifacts.requestPublish', { artifactId: mandate.artifactId, note: 'grant' })).status).toBe('published');
  return { owner, ws, api, token, agentId, templateId: tpl.artifactId, profiles, webhookUrl: provider.webhookUrl as string };
}

/**
 * Makes every message-event row the workspace enqueues wait an hour, so the dispatcher cannot
 * publish it: the state a ClickHouse or dispatcher outage leaves behind, without sleeping.
 */
async function holdPublication(ws: string) {
  await t.srv.db.admin.query(`CREATE OR REPLACE FUNCTION am_test_hold_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.workspace_id = '${ws}'::uuid THEN NEW.next_attempt_at := now() + interval '1 hour'; END IF;
      RETURN NEW;
    END $$`);
  await t.srv.db.admin.query('DROP TRIGGER IF EXISTS am_test_hold_outbox ON outbox');
  await t.srv.db.admin.query(
    'CREATE TRIGGER am_test_hold_outbox BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION am_test_hold_outbox()',
  );
}

async function releasePublication(ws: string) {
  await t.srv.db.admin.query('DROP TRIGGER IF EXISTS am_test_hold_outbox ON outbox');
  await t.srv.db.admin.query('DROP FUNCTION IF EXISTS am_test_hold_outbox()');
  // Due now, so the production dispatcher (or a direct round below) can publish them.
  await t.srv.db.admin.query(`UPDATE outbox SET next_attempt_at = now() WHERE workspace_id = $1 AND state = 'pending'`, [ws]);
}

const messagesOf = async (ws: string) =>
  (
    await t.srv.db.admin.query<{ id: string; status: string }>(
      'SELECT id, status FROM messages WHERE workspace_id = $1 ORDER BY created_at',
      [ws],
    )
  ).rows;

const outboxRowOf = async (ws: string, messageId: string) =>
  (
    await t.srv.db.admin.query<{ id: string; state: string; next_attempt_at: Date }>(
      `SELECT id, state, next_attempt_at FROM outbox
       WHERE workspace_id = $1 AND kind = 'message_event' AND payload->'events'->0->>'messageId' = $2
       ORDER BY created_at DESC LIMIT 1`,
      [ws, messageId],
    )
  ).rows[0];

/** A provider reports a complaint for one message through the production webhook route. */
async function complain(s: Setup, messageId: string) {
  const res = await fetch(s.webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'spam',
      email: 'ada@example.com',
      'X-Mailin-custom': `am:${messageId}`,
      'message-id': `provider-${messageId}`,
      ts_event: Math.floor(Date.now() / 1000),
      reason: 'reported as spam in the test',
    }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, events: 1 });
}

beforeAll(async () => {
  t = await startTestServer('test_guardrail_freshness', PORT);
}, 90_000);

afterEach(async () => {
  await t.srv.db.admin.query('DROP TRIGGER IF EXISTS am_test_hold_outbox ON outbox').catch(() => {});
  await t.srv.db.admin.query('DROP FUNCTION IF EXISTS am_test_hold_outbox()').catch(() => {});
});

afterAll(() => t?.close());

describe('guardrails read unpublished message events (#1008)', () => {
  it('refuses the next send on a complaint that is committed but not published, then keeps refusing on published data', async () => {
    const s = await setup({ complaintRate: 0.01 });
    await holdPublication(s.ws);

    for (const profileId of s.profiles) {
      const sent = await agentCall(s.token, 'messages.sendEmail', { profileId, templateId: s.templateId });
      expect(sent.status).toBe(200);
      expect(sent.body.status).toBe('queued');
    }
    // The message log does not wait for the outbox: the rows are complete in SQL.
    const sent = await eventually(
      () => messagesOf(s.ws),
      (rows) => rows.length === 3 && rows.every((r) => r.status === 'sent'),
    );
    expect(sent).toHaveLength(3);

    // One recipient complains. The webhook commits the complaint to the message log and enqueues
    // its event; nothing is published while the hold stands.
    await complain(s, sent[0].id);
    expect(await outboxRowOf(s.ws, sent[0].id)).toMatchObject({ state: 'pending' });
    expect((await messagesOf(s.ws)).find((r) => r.id === sent[0].id)?.status).toBe('complained');
    const stats = await t.srv.events.messageStats(s.ws, { since: new Date(Date.now() - 3_600_000) });
    expect(stats.complained ?? 0).toBe(0);

    // Before 0.15.0 the complaint was already in ClickHouse when the next send decided. It is only
    // in SQL now, and the decision must still see it: one of three messages is 33.33%.
    const refused = await agentCall(s.token, 'messages.sendEmail', { profileId: s.profiles[2], templateId: s.templateId });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toMatch(/complaint rate of 33\.33%, above its mandate’s guardrail of 1%/);
    expect(refused.body.message).toMatch(/message log and consent ledger/);
    expect(refused.body.message).toMatch(/still unpublished/);

    // Publish through the production dispatcher: the published evidence now decides alone, with
    // the same verdict and no freshness note.
    await releasePublication(s.ws);
    await dispatchOutboxOnce({ db: t.srv.db, kp: t.srv.keyProvider, events: t.srv.events });
    await eventually(
      () => t.srv.events.messageStats(s.ws, { since: new Date(Date.now() - 3_600_000) }),
      (s) => (s.complained ?? 0) === 1,
    );
    const published = await agentCall(s.token, 'messages.sendEmail', { profileId: s.profiles[2], templateId: s.templateId });
    expect(published.status).toBe(403);
    expect(published.body.message).toMatch(/complaint rate of 33\.33%, above its mandate’s guardrail of 1%/);
    expect(published.body.message).not.toMatch(/message log and consent ledger/);
  }, 90_000);

  it('counts a dead-lettered complaint from SQL instead of waiting for a publication that will not happen', async () => {
    const s = await setup({ complaintRate: 0.01 });
    await holdPublication(s.ws);
    for (const profileId of s.profiles) {
      expect((await agentCall(s.token, 'messages.sendEmail', { profileId, templateId: s.templateId })).status).toBe(200);
    }
    const sent = await eventually(
      () => messagesOf(s.ws),
      (rows) => rows.length === 3 && rows.every((r) => r.status === 'sent'),
    );
    await complain(s, sent[0].id);

    // The row used its attempts: it is dead-lettered and will never arrive without `am outbox`.
    // A guardrail that reads only published events would allow the next send, and one that waits
    // for outstanding publication would wait forever; it must decide from SQL instead.
    await t.srv.db.admin.query(
      `UPDATE outbox SET state = 'failed', failure_kind = 'exhausted', attempts = 36, lease_until = NULL, claim_token = NULL
       WHERE workspace_id = $1 AND kind = 'message_event' AND payload->'events'->0->>'messageId' = $2
         AND payload->'events'->0->>'type' = 'complained'`,
      [s.ws, sent[0].id],
    );
    expect(await outboxRowOf(s.ws, sent[0].id)).toMatchObject({ state: 'failed' });
    // Publish what is still waiting (the send decisions, not the complaint) so only the dead
    // letter remains: nothing is outstanding, and nothing will ever carry the complaint.
    await releasePublication(s.ws);
    await dispatchOutboxOnce({ db: t.srv.db, kp: t.srv.keyProvider, events: t.srv.events });
    await eventually(
      async () => {
        const pending = await t.srv.db.admin.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM outbox WHERE workspace_id = $1 AND state IN ('pending', 'delivering')`,
          [s.ws],
        );
        return pending.rows[0]?.n ?? 0;
      },
      (n) => n === 0,
    );
    const failedRows = await t.srv.db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox WHERE workspace_id = $1 AND state = 'failed'`,
      [s.ws],
    );
    expect(failedRows.rows[0]?.n).toBe(1);
    // Nothing published it: only the message log carries the complaint.
    expect((await t.srv.events.messageStats(s.ws, { since: new Date(Date.now() - 3_600_000) })).complained ?? 0).toBe(0);

    const refused = await agentCall(s.token, 'messages.sendEmail', { profileId: s.profiles[2], templateId: s.templateId });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toMatch(/complaint rate of 33\.33%, above its mandate’s guardrail of 1%/);
    expect(refused.body.message).toMatch(/dead-lettered/);
  }, 90_000);

  it('lets the guardian cap the agent on that unpublished evidence instead of waiting for it', async () => {
    const s = await setup({ complaintRate: 0.01 });
    await holdPublication(s.ws);
    for (const profileId of s.profiles) {
      expect((await agentCall(s.token, 'messages.sendEmail', { profileId, templateId: s.templateId })).status).toBe(200);
    }
    const sent = await eventually(
      () => messagesOf(s.ws),
      (rows) => rows.length === 3 && rows.every((r) => r.status === 'sent'),
    );
    await complain(s, sent[0].id);
    expect((await t.srv.events.messageStats(s.ws, { since: new Date(Date.now() - 3_600_000) })).complained ?? 0).toBe(0);

    const summary = await runGuardianOnce(deps());
    expect(summary.episodes).toBeGreaterThanOrEqual(1);
    const agent = await s.api.call('agents.get', { id: s.agentId });
    expect(agent).toMatchObject({ status: 'active', guard: { cap: 1 } });
    const { episodes } = await s.api.call('agents.guardian', { agentId: s.agentId, open: true });
    expect(episodes.find((e) => e.kind === 'guardrail')).toMatchObject({
      action: 'cap',
      reason: expect.stringContaining('complaint rate of 33.33%'),
    });
    expect(episodes.find((e) => e.kind === 'guardrail')?.reason).toMatch(/still unpublished/);
  }, 90_000);
});
