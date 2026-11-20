import { activeMandate } from '@agentic-marketing/artifacts';
import { dispatchOutboxOnce } from '@agentic-marketing/audience';
import { type MessageEvent, parseMessageEventPayload } from '@agentic-marketing/events';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runGuardianOnce } from '../src/agents/guardian';
import { GUARDRAIL_PENDING_EVENT_LIMIT, mandateGuardrailCheck } from '../src/agents/guardrails';
import { eventually, startTestServer, testPort, type User } from './harness';

// #1008: a safety decision before a send must see the message events the transaction committed, not
// only the ones ClickHouse has. The two cannot be reconstructed from SQL status: a soft bounce is a
// `bounced` event with status still `sent`, a later complaint overwrites an earlier bounce, and a
// broadcast's denominator is distinct people while the message log counts messages. So the decision
// snapshots the agent's own queued events out of the outbox first and hands them to the same metric
// query that published events go through. Tests can only produce events here through the outbox.

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
 * Makes every outbox row this workspace enqueues wait an hour, so the dispatcher cannot publish it:
 * the state a ClickHouse or dispatcher outage leaves behind, without sleeping.
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

/**
 * Publishes every open row except the one type under test, so the queue holds exactly that row: the
 * state the race is about (the dispatcher can only ack what is open).
 */
async function drainExcept(ws: string, type: string) {
  await t.srv.db.admin.query(
    `UPDATE outbox SET next_attempt_at = now()
     WHERE workspace_id = $1 AND state = 'pending' AND NOT (payload->'events'->0->>'type' = $2)`,
    [ws, type],
  );
  await dispatchOutboxOnce({ db: t.srv.db, kp: t.srv.keyProvider, events: t.srv.events, bus: t.srv.bus });
  return eventually(
    async () =>
      (
        await t.srv.db.admin.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM outbox WHERE workspace_id = $1 AND state IN ('pending', 'delivering')`,
          [ws],
        )
      ).rows[0]?.n ?? 0,
    (n) => n === 1,
  );
}

const messagesOf = async (ws: string) =>
  (
    await t.srv.db.admin.query<{ id: string; status: string }>(
      'SELECT id, status FROM messages WHERE workspace_id = $1 ORDER BY created_at',
      [ws],
    )
  ).rows;

const outboxRowOf = async (ws: string, messageId: string, type?: string) =>
  (
    await t.srv.db.admin.query<{ id: string; state: string; payload: { events: MessageEvent[] } }>(
      `SELECT id, state, payload FROM outbox
       WHERE workspace_id = $1 AND kind = 'message_event'
         AND payload->'events'->0->>'messageId' = $2
         ${type ? "AND payload->'events'->0->>'type' = $3" : ''}
       ORDER BY created_at DESC LIMIT 1`,
      type ? [ws, messageId, type] : [ws, messageId],
    )
  ).rows[0];

/** Sends `count` direct messages from the agent and waits until the message log shows them sent. */
async function sendDirect(s: Setup, count = s.profiles.length) {
  for (const profileId of s.profiles.slice(0, count)) {
    const sent = await agentCall(s.token, 'messages.sendEmail', { profileId, templateId: s.templateId });
    expect(sent.status).toBe(200);
    expect(sent.body.status).toBe('queued');
  }
  const rows = await eventually(
    () => messagesOf(s.ws),
    (msgs) => msgs.length >= count && msgs.slice(0, count).every((m) => m.status === 'sent'),
  );
  return rows.slice(0, count);
}

/** A provider webhook reports a delivery event for one message through the production route. */
async function deliveryEvent(s: Setup, messageId: string, event: 'spam' | 'soft_bounce' | 'hard_bounce', reason = 'test') {
  const res = await fetch(s.webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event,
      email: 'ada@example.com',
      'X-Mailin-custom': `am:${messageId}`,
      'message-id': `provider-${messageId}`,
      ts_event: Math.floor(Date.now() / 1000),
      reason,
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
  it('refuses the next send on a complaint that is committed but not published', async () => {
    const s = await setup({ complaintRate: 0.01 });
    await holdPublication(s.ws);
    const sent = await sendDirect(s);

    await deliveryEvent(s, sent[0].id, 'spam');
    expect(await outboxRowOf(s.ws, sent[0].id, 'complained')).toMatchObject({ state: 'pending' });
    expect((await messagesOf(s.ws)).find((r) => r.id === sent[0].id)?.status).toBe('complained');
    expect((await t.srv.events.messageStats(s.ws, { since: new Date(Date.now() - 3_600_000) })).complained ?? 0).toBe(0);

    // Same metric query, now with the queued event: one of three people complained.
    const refused = await agentCall(s.token, 'messages.sendEmail', { profileId: s.profiles[2], templateId: s.templateId });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toMatch(/complaint rate of 33\.33%, above its mandate’s guardrail of 1%/);
    expect(refused.body.message).toMatch(/still queued for publication/);

    // Once the queue is published, the same published data reaches the same verdict.
    await releasePublication(s.ws);
    await dispatchOutboxOnce({ db: t.srv.db, kp: t.srv.keyProvider, events: t.srv.events, bus: t.srv.bus });
    await eventually(
      () => t.srv.events.messageStats(s.ws, { since: new Date(Date.now() - 3_600_000) }),
      (stats) => (stats.complained ?? 0) === 1,
    );
    const published = await agentCall(s.token, 'messages.sendEmail', { profileId: s.profiles[2], templateId: s.templateId });
    expect(published.status).toBe(403);
    expect(published.body.message).toMatch(/complaint rate of 33\.33%, above its mandate’s guardrail of 1%/);
    expect(published.body.message).not.toMatch(/still queued for publication/);
  }, 90_000);

  it('counts a soft bounce, which SQL keeps as a sent message with no failed status', async () => {
    const s = await setup({ bounceRate: 0.1 });
    await holdPublication(s.ws);
    const sent = await sendDirect(s);

    await deliveryEvent(s, sent[0].id, 'soft_bounce', 'mailbox full');
    // The message log cannot show this bounce: a soft bounce leaves the status at sent.
    expect((await messagesOf(s.ws)).find((r) => r.id === sent[0].id)?.status).toBe('sent');
    expect(await outboxRowOf(s.ws, sent[0].id, 'bounced')).toMatchObject({ state: 'pending' });
    expect((await t.srv.events.messageStats(s.ws, { since: new Date(Date.now() - 3_600_000) })).bounced ?? 0).toBe(0);

    const refused = await agentCall(s.token, 'messages.sendEmail', { profileId: s.profiles[2], templateId: s.templateId });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toMatch(/bounce rate of 33\.33%, above its mandate’s guardrail of 10%/);
  }, 90_000);

  it('records a send’s outcome and its event in one transaction, so a decision cannot miss the send', async () => {
    const s = await setup({ bounceRate: 0.1 });
    await holdPublication(s.ws);
    const sent = await sendDirect(s);

    // The delivery worker writes the `sent` event in the transaction that sets the status (#1008):
    // a decision that runs before the dispatcher published it still counts every send. A delivery
    // path that inserted the event into ClickHouse after its status committed left a window in
    // which neither the published rows nor the queue named a send, so the rate was read over fewer
    // sends than there were (50% instead of 33.33% with one bounce in three).
    for (const m of sent) expect(await outboxRowOf(s.ws, m.id, 'sent')).toMatchObject({ state: 'pending' });
    expect((await t.srv.events.messageStats(s.ws, { since: new Date(Date.now() - 3_600_000) })).sent ?? 0).toBe(0);

    await deliveryEvent(s, sent[0].id, 'soft_bounce', 'mailbox full');
    const refused = await agentCall(s.token, 'messages.sendEmail', { profileId: s.profiles[2], templateId: s.templateId });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toMatch(/bounce rate of 33\.33%, above its mandate’s guardrail of 10%/);
  }, 90_000);

  it('uses the metric denominator for a broadcast, not the number of messages', async () => {
    const s = await setup({ complaintRate: 0.1 });
    await holdPublication(s.ws);
    const broadcastId = `bct_${'a'.repeat(32)}`;
    const at = new Date(Date.now() - 60_000).toISOString();
    const profiles = s.profiles;
    const messageIds = Array.from({ length: 12 }, (_, i) => `msg_bcast_${i}_${Date.now()}`);
    // Twelve e-mails over three people: the delivered-to denominator is three, not twelve.
    await t.srv.events.insertMessageEvents(
      messageIds.map((messageId, i) => ({
        workspaceId: s.ws,
        messageId,
        eventId: `sent:${i}`,
        type: 'sent' as const,
        at,
        profileId: profiles[i % 3],
        channel: 'email',
        purpose: 'marketing_email',
        provider: 'log',
        templateId: s.templateId,
        templateVersion: 1,
        journeyId: broadcastId,
        variant: '',
        reason: '',
        url: '',
      })),
    );
    for (const [i, messageId] of messageIds.entries())
      await t.srv.db.admin.query(
        `INSERT INTO messages (workspace_id, id, idempotency_key, channel, profile_id, purpose, template_id, template_version, journey_id, status, sent_at)
         VALUES ($1, $2, $3, 'email', $4, 'marketing_email', $5, 1, $6, 'sent', now())`,
        [s.ws, messageId, `bcast:${messageId}`, profiles[i % 3], s.templateId, broadcastId],
      );
    // The agent's ledger says it published that broadcast, which is what the guardrail keys on.
    await t.srv.db.admin.query(
      `INSERT INTO agent_actions (workspace_id, agent_id, command, action_class, decision, ok, target, surface, impact, at)
       VALUES ($1, $2, 'artifacts.requestPublish', 'send.broadcast', 'allow', true, $3, 'rest', '{}', now() - interval '2 minutes')`,
      [s.ws, s.agentId, broadcastId],
    );
    // One of the twelve complains, still queued.
    await deliveryEvent(s, messageIds[0], 'spam');
    expect(await outboxRowOf(s.ws, messageIds[0], 'complained')).toMatchObject({ state: 'pending' });

    // One in twelve messages is 8.33%, but it is one of the three people who received the issue.
    const refused = await agentCall(s.token, 'messages.sendEmail', { profileId: profiles[2], templateId: s.templateId });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toMatch(/complaint rate of 33\.33%, above its mandate’s guardrail of 10%/);
  }, 90_000);

  it('counts a dead-lettered event instead of waiting for a publication that will not happen', async () => {
    const s = await setup({ complaintRate: 0.01 });
    await holdPublication(s.ws);
    const sent = await sendDirect(s);
    await deliveryEvent(s, sent[0].id, 'spam');

    // The row used its attempts: it is dead-lettered and will never arrive without `am outbox`.
    await t.srv.db.admin.query(
      `UPDATE outbox SET state = 'failed', failure_kind = 'exhausted', attempts = 36, lease_until = NULL, claim_token = NULL
       WHERE workspace_id = $1 AND kind = 'message_event' AND payload->'events'->0->>'messageId' = $2
         AND payload->'events'->0->>'type' = 'complained'`,
      [s.ws, sent[0].id],
    );
    // Publish what is still waiting (the send decisions, not the complaint) so only the dead
    // letter remains: nothing is outstanding, and nothing will ever carry the complaint.
    await releasePublication(s.ws);
    await dispatchOutboxOnce({ db: t.srv.db, kp: t.srv.keyProvider, events: t.srv.events, bus: t.srv.bus });
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
    expect((await t.srv.events.messageStats(s.ws, { since: new Date(Date.now() - 3_600_000) })).complained ?? 0).toBe(0);

    const refused = await agentCall(s.token, 'messages.sendEmail', { profileId: s.profiles[2], templateId: s.templateId });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toMatch(/complaint rate of 33\.33%, above its mandate’s guardrail of 1%/);
    expect(refused.body.message).toMatch(/dead-lettered/);
  }, 90_000);

  it('fails safe when the agent has more queued events than one check may read', async () => {
    const s = await setup({ complaintRate: 0.01 });
    await holdPublication(s.ws);
    const sent = await sendDirect(s);
    // More rows for this agent's own message than the snapshot accepts: the decision cannot see all
    // the evidence, so it must not allow the send as if the missing events said nothing.
    const rows = GUARDRAIL_PENDING_EVENT_LIMIT + 1;
    await t.srv.db.admin.query(
      `INSERT INTO outbox (workspace_id, id, kind, payload, operation_key)
       SELECT $1::uuid, 'obx_flood_' || i, 'message_event',
              jsonb_build_object('events', jsonb_build_array(jsonb_build_object(
                'workspaceId', $6::text, 'messageId', $2::text, 'eventId', 'flood:' || i, 'type', 'delivered',
                'at', now(), 'profileId', $3::text, 'channel', 'email', 'purpose', 'marketing_email',
                'provider', 'log', 'templateId', $4::text, 'templateVersion', 1, 'journeyId', '', 'reason', '', 'url', ''))),
              'flood:' || i
       FROM generate_series(1, $5::int) AS i`,
      [s.ws, sent[0].id, s.profiles[0], s.templateId, rows, s.ws],
    );
    const refused = await agentCall(s.token, 'messages.sendEmail', { profileId: s.profiles[2], templateId: s.templateId });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toMatch(/cannot be checked/);
    expect(refused.body.message).toMatch(/am outbox/);

    // Unavailable evidence is not a breach: the guardian must not cap the agent (and must not leave
    // a cap behind when the queue catches up) for a backlog it simply could not read.
    await runGuardianOnce(deps());
    const capped = await s.api.call('agents.get', { id: s.agentId });
    expect(capped.guard).toBeNull();
    expect((await s.api.call('agents.guardian', { agentId: s.agentId, open: true })).episodes).toHaveLength(0);

    // The backlog drains (the dispatcher acks what it published, the flood stands for events it
    // published), and nothing measured breaches: the next send runs.
    await t.srv.db.admin.query(
      `UPDATE outbox SET state = 'delivered', delivered_at = now(), claim_token = NULL, lease_until = NULL
       WHERE workspace_id = $1 AND operation_key LIKE 'flood:%'`,
      [s.ws],
    );
    await releasePublication(s.ws);
    await dispatchOutboxOnce({ db: t.srv.db, kp: t.srv.keyProvider, events: t.srv.events, bus: t.srv.bus });
    await eventually(
      async () =>
        (
          await t.srv.db.admin.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM outbox WHERE workspace_id = $1 AND state IN ('pending', 'delivering')`,
            [s.ws],
          )
        ).rows[0]?.n ?? 0,
      (n) => n === 0,
    );
    const allowed = await agentCall(s.token, 'messages.sendEmail', { profileId: s.profiles[2], templateId: s.templateId });
    expect(allowed.status).toBe(200);
    expect(allowed.body.status).toBe('queued');
    expect((await s.api.call('agents.get', { id: s.agentId })).guard).toBeNull();
  }, 90_000);

  it('keeps a decision correct when the dispatcher publishes the event between the snapshot and the read', async () => {
    const s = await setup({ complaintRate: 0.01 });
    await holdPublication(s.ws);
    const sent = await sendDirect(s);
    await deliveryEvent(s, sent[0].id, 'spam');
    const row = await outboxRowOf(s.ws, sent[0].id, 'complained');
    expect(row).toMatchObject({ state: 'pending' });
    // Only the complaint is still open, so acking it is what empties the queue.
    expect(await drainExcept(s.ws, 'complained')).toBe(1);

    // The race from review: the dispatcher publishes and acks the row right after the decision's
    // ClickHouse read. The event is then in neither the published result nor the queue, and the old
    // order (read first, then ask the outbox) allowed the send. The snapshot is taken first instead.
    let raced = false;
    const events = {
      ...t.srv.events,
      messageStats: async (workspaceId: string, query: Parameters<typeof t.srv.events.messageStats>[1]) => {
        const stats = await t.srv.events.messageStats(workspaceId, query);
        if (!raced) {
          raced = true;
          await t.srv.events.insertMessageEvents(parseMessageEventPayload(row.payload));
          await t.srv.db.admin.query(
            `UPDATE outbox SET state = 'delivered', delivered_at = now(), claim_token = NULL, lease_until = NULL WHERE id = $1`,
            [row.id],
          );
        }
        return stats;
      },
    };
    const check = await t.srv.db.withWorkspace(s.ws, async (tx) => {
      const mandate = await activeMandate(tx, s.agentId);
      if (!mandate) throw new Error('the mandate is not active');
      return mandateGuardrailCheck({ tx, events: events as typeof t.srv.events, workspaceId: s.ws }, s.agentId, mandate.view);
    });
    expect(raced).toBe(true);
    expect(check).toMatchObject({
      state: 'breach',
      reason: expect.stringMatching(/complaint rate of 33\.33%, above its mandate’s guardrail of 1%/),
    });
  }, 90_000);

  it('lets the guardian cap the agent on that unpublished evidence instead of waiting for it', async () => {
    const s = await setup({ complaintRate: 0.01 });
    await holdPublication(s.ws);
    const sent = await sendDirect(s);
    await deliveryEvent(s, sent[0].id, 'spam');
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
  }, 90_000);
});
