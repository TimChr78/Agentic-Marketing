import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { evaluateAlerts, resetAlertEvaluationState } from '@agentic-marketing/alerts';
import { clearAnalyticsCache } from '@agentic-marketing/analytics';
import type { BusEvent, JourneyEvent, MessageEvent } from '@agentic-marketing/events';
import { verifyWebhook } from '@agentic-marketing/integrations';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eventually, rejects, startTestServer, testPort, type User } from './harness';

// Phase 16 (#76, alerts part): threshold rules over the metric layer, evaluated by the scheduler
// with an injectable clock. Two workspaces, synthetic ClickHouse events, a local webhook receiver
// that verifies the signature, and the transactional outbox for e-mail.

const PORT = testPort(3481);
const HOUR = 3_600_000;
const T0 = Date.parse('2026-04-01T12:00:00.000Z');
const T = (offset: number) => new Date(T0 + offset).toISOString();
const JOURNEY_A = `jrn_${'a'.repeat(32)}`;
const JOURNEY_B = `jrn_${'b'.repeat(32)}`;

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let viewer: User;
let wsA = '';
let wsB = '';
let endpoint: { id: string; secret: string };
let receiverUrl = '';
let profile = 0;
const person = () => `prf_${(++profile).toString(16).padStart(32, '0')}`;

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}
const received: Received[] = [];
const receiver = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ path: req.url ?? '', headers: req.headers, body });
    res.statusCode = 200;
    res.end('ok');
  });
});

const api = (workspaceId = wsA) => t.api(owner, workspaceId);
const deps = () => ({
  db: t.srv.db,
  events: t.srv.events,
  kp: t.srv.keyProvider,
  email: t.srv.email,
  directory: t.srv.directory,
  publicUrl: t.base,
});
const evaluate = (now: number) => evaluateAlerts(deps(), { now: new Date(now), force: true });

const messageEvents = (
  workspaceId: string,
  at: string,
  paper: { sent: number; bounced?: number; complained?: number; broadcast?: string },
): MessageEvent[] => {
  const out: MessageEvent[] = [];
  const people = Array.from({ length: paper.sent }, person);
  const event = (type: MessageEvent['type'], i: number): MessageEvent => ({
    workspaceId,
    messageId: `msg_${workspaceId}_${type}_${i}_${Math.random().toString(36).slice(2, 8)}`,
    eventId: `${type}:${i}:${Math.random().toString(36).slice(2, 10)}`,
    type,
    at,
    profileId: people[i],
    channel: 'email',
    purpose: 'marketing_email',
    provider: 'log',
    templateId: `eml_${'c'.repeat(32)}`,
    templateVersion: 1,
    journeyId: paper.broadcast ?? `bct_${'1'.repeat(32)}`,
    variant: '',
    reason: '',
    url: '',
  });
  for (let i = 0; i < paper.sent; i++) out.push(event('sent', i));
  for (let i = 0; i < (paper.bounced ?? 0); i++) out.push(event('bounced', i));
  for (let i = 0; i < (paper.complained ?? 0); i++) out.push(event('complained', i));
  return out;
};

const failedJourneyEvents = (workspaceId: string, journeyId: string, at: string, count: number, seqBase = 0): JourneyEvent[] =>
  Array.from({ length: count }, (_, i) => ({
    workspaceId,
    journeyId,
    version: 1,
    participantId: 10_000 + seqBase + i,
    profileId: person(),
    node: 's1',
    type: 'failed',
    seq: seqBase + i,
    at,
    detail: 'synthetic failure',
  }));

const signupEvents = (workspaceId: string, at: string, count: number): BusEvent[] =>
  Array.from({ length: count }, (_, i) => ({
    workspaceId,
    sourceId: 'test',
    messageId: `doi:${workspaceId}:${at}:${i}:${Math.random().toString(36).slice(2, 8)}`,
    type: 'track' as const,
    name: 'Subscription Confirmed',
    anonymousId: `anon_${workspaceId}_${at}_${i}`,
    userId: '',
    timestamp: at,
    receivedAt: at,
    properties: {},
    traits: {},
    piiTraits: {},
    context: {},
    consent: {},
  }));

const rulesIn = async (workspaceId = wsA) => (await api(workspaceId).call('alerts.list', {})).rules;
const eventRows = async (workspaceId = wsA) => {
  const { rows } = await t.srv.db.admin.query<{ state: string; value: number; threshold: number; resolved_at: Date | null }>(
    'SELECT state, value, threshold, resolved_at FROM alert_events WHERE workspace_id = $1 ORDER BY fired_at',
    [workspaceId],
  );
  return rows;
};
const alertMessages = async (workspaceId = wsA) => {
  const { rows } = await t.srv.db.admin.query<{ status: string; idempotency_key: string }>(
    "SELECT status, idempotency_key FROM messages WHERE workspace_id = $1 AND idempotency_key LIKE 'alert:%' ORDER BY created_at",
    [workspaceId],
  );
  return rows;
};

beforeAll(async () => {
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  t = await startTestServer('test_v029_alerts', PORT);
  owner = await t.signUp(`owner-alerts-${Date.now()}@example.com`);
  viewer = await t.signUp(`viewer-alerts-${Date.now()}@example.com`);
  wsA = await t.workspaceWith(
    [
      [owner, 'owner'],
      [viewer, 'viewer'],
    ],
    'none',
  );
  wsB = await t.workspaceWith([[owner, 'owner']], 'none');
  endpoint = await api().call('webhooks.create', { name: 'Ops', url: `${receiverUrl}/alerts`, events: [] });
  // The log adapter keeps the test offline but still records a message row, like any provider.
  await api().call('emailProviders.create', {
    name: 'Outbox',
    adapter: 'log',
    fromEmail: 'alerts@example.com',
    useFor: ['transactional'],
  });
}, 60_000);

afterEach(async () => {
  for (const workspaceId of [wsA, wsB]) {
    for (const rule of await rulesIn(workspaceId)) await api(workspaceId).call('alerts.delete', { id: rule.id });
  }
  // Messages outlive a rule; start each test with an empty alert outbox.
  await t.srv.db.admin.query("DELETE FROM messages WHERE workspace_id = ANY($1::uuid[]) AND idempotency_key LIKE 'alert:%'", [[wsA, wsB]]);
  received.length = 0;
  profile = 0;
  clearAnalyticsCache();
  resetAlertEvaluationState();
});

afterAll(async () => {
  await t?.close();
  receiver.close();
});

describe('alert rules over the metric layer', () => {
  it('fires a deliverability rule on synthetic e-mail events, notifies once, resolves once and honours the cooldown', async () => {
    await t.srv.events.insertMessageEvents([...messageEvents(wsA, T(-10 * 60_000), { sent: 200, bounced: 20, complained: 4 })]);
    const created = await api().call('alerts.create', {
      name: 'Bounce spike',
      kind: 'deliverability',
      config: { metric: 'bounce', window: 'PT1H', threshold: 0.05, minSent: 100 },
      channels: [
        { type: 'webhook', webhookId: endpoint.id },
        { type: 'email', userIds: [owner.id] },
      ],
    });
    expect(created.rule.config).toMatchObject({ metric: 'bounce', window: 'PT1H', threshold: 0.05, minSent: 100 });

    await evaluate(T0);

    let rules = await rulesIn();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ state: 'firing' });
    expect(rules[0].firingSince).toBe(new Date(T0).toISOString());
    let events = await eventRows();
    expect(events).toHaveLength(1);
    expect(events[0].state).toBe('firing');
    expect(events[0].value).toBeCloseTo(0.1, 5);
    expect(events[0].threshold).toBeCloseTo(0.05, 5);

    // The signed webhook goes through the existing delivery outbox.
    const firingDeliveries = await eventually(
      async () => received.filter((r) => r.path === '/alerts' && JSON.parse(r.body).type === 'alert.firing'),
      (rows) => rows.length === 1,
      10_000,
    );
    expect(firingDeliveries).toHaveLength(1);
    expect(verifyWebhook(endpoint.secret, firingDeliveries[0].headers as Record<string, string>, firingDeliveries[0].body)).toBe(true);
    const payload = JSON.parse(firingDeliveries[0].body) as Record<string, unknown>;
    expect(payload).toMatchObject({ type: 'alert.firing', value: 0.1, threshold: 0.05, window: 'PT1H' });
    expect(payload.rule).toMatchObject({ id: created.rule.id, name: 'Bounce spike', kind: 'deliverability' });
    expect(payload.workspace).toMatchObject({ id: wsA });
    expect(String(payload.url)).toContain(`/insights/alerts?rule=${created.rule.id}`);

    // The transactional e-mail is recorded in the message outbox.
    const mails = await eventually(
      () => alertMessages(),
      (rows) => rows.length === 1 && rows[0].status === 'sent',
      10_000,
    );
    expect(mails).toHaveLength(1);
    expect(mails[0].idempotency_key).toContain(`alert:`);
    expect(mails[0].idempotency_key).toContain('firing');

    // A second tick while it keeps firing neither opens a second episode nor notifies again.
    await evaluate(T0);
    expect(await eventRows()).toHaveLength(1);
    expect(received.filter((r) => r.path === '/alerts' && JSON.parse(r.body).type === 'alert.firing')).toHaveLength(1);
    expect(await alertMessages()).toHaveLength(1);

    // A healthy window (enough volume, no bounces): one resolve, then silence.
    await t.srv.events.insertMessageEvents([...messageEvents(wsA, T(HOUR), { sent: 200, bounced: 0 })]);
    await evaluate(T0 + 2 * HOUR);
    rules = await rulesIn();
    expect(rules[0]).toMatchObject({ state: 'ok', firingSince: null });
    events = await eventRows();
    expect(events).toHaveLength(1);
    expect(events[0].state).toBe('resolved');
    expect(events[0].resolved_at).not.toBeNull();
    const resolved = await eventually(
      async () => received.filter((r) => r.path === '/alerts' && JSON.parse(r.body).type === 'alert.resolved'),
      (rows) => rows.length === 1,
    );
    expect(resolved).toHaveLength(1);
    expect((await alertMessages()).some((m) => m.idempotency_key.includes('resolved'))).toBe(true);
    await evaluate(T0 + 2 * HOUR + 5 * 60_000);
    expect(received.filter((r) => r.path === '/alerts' && JSON.parse(r.body).type === 'alert.resolved')).toHaveLength(1);

    // A fresh breach 50 minutes after the resolve is inside the one-hour cooldown: no new episode.
    await t.srv.events.insertMessageEvents([...messageEvents(wsA, T(2.5 * HOUR), { sent: 200, bounced: 20 })]);
    await evaluate(T0 + 2.83 * HOUR);
    expect(await eventRows()).toHaveLength(1);
    expect(received.filter((r) => r.path === '/alerts' && JSON.parse(r.body).type === 'alert.firing')).toHaveLength(1);

    // After the cooldown the same condition fires again as a new episode.
    await evaluate(T0 + 3.1 * HOUR);
    events = await eventRows();
    expect(events).toHaveLength(2);
    expect(events.filter((e) => e.state === 'firing')).toHaveLength(1);
  }, 30_000);

  it('does not fire a deliverability rule below its minimum volume', async () => {
    // A separate hour, so the previous test's synthetic volume is outside this rule's window.
    const base = T0 + 10 * HOUR;
    await t.srv.events.insertMessageEvents([...messageEvents(wsA, T(base - 10 * 60_000), { sent: 50, bounced: 10 })]);
    await api().call('alerts.create', {
      name: 'Small sample',
      kind: 'deliverability',
      config: { metric: 'bounce', window: 'PT1H', threshold: 0.05, minSent: 100 },
      channels: [{ type: 'webhook', webhookId: endpoint.id }],
    });
    await evaluate(base);
    expect((await rulesIn())[0]).toMatchObject({ state: 'ok' });
    // No firing episode is opened, so there is nothing to notify.
    expect(await eventRows()).toHaveLength(0);
  });

  it('fires a signup_drop rule against the previous window, and not below the previous-window floor', async () => {
    const base = T0 + 20 * HOUR;
    const at = (offset: number) => new Date(base + offset).toISOString();
    await t.srv.events.insert([...signupEvents(wsA, at(-90 * 60_000), 20), ...signupEvents(wsA, at(-30 * 60_000), 2)]);
    const rule = await api().call('alerts.create', {
      name: 'Signup drop',
      kind: 'signup_drop',
      config: { window: 'PT1H', dropPercent: 50, minPrevious: 10 },
      channels: [{ type: 'webhook', webhookId: endpoint.id }],
    });
    const floor = await api().call('alerts.create', {
      name: 'Needs a bigger baseline',
      kind: 'signup_drop',
      config: { window: 'PT1H', dropPercent: 50, minPrevious: 25 },
      channels: [{ type: 'webhook', webhookId: endpoint.id }],
    });

    await evaluate(base);

    const rules = await rulesIn();
    expect(rules.find((r) => r.id === rule.rule.id)).toMatchObject({ state: 'firing' });
    expect(rules.find((r) => r.id === floor.rule.id)).toMatchObject({ state: 'ok' });
    const events = await eventRows();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ state: 'firing', value: 2 });
    // 20 previous × (1 − 50%) = 10.
    expect(events[0].threshold).toBe(10);
  });

  it('counts failed journey steps, with a journey filter and a strict count threshold', async () => {
    await t.srv.events.insertJourneyEvents([
      ...failedJourneyEvents(wsA, JOURNEY_A, T(-10 * 60_000), 5),
      ...failedJourneyEvents(wsA, JOURNEY_B, T(-10 * 60_000), 4, 100),
    ]);
    const all = await api().call('alerts.create', {
      name: 'Any journey errors',
      kind: 'journey_errors',
      config: { window: 'PT1H', threshold: 5 },
      channels: [{ type: 'webhook', webhookId: endpoint.id }],
    });
    const onlyA = await api().call('alerts.create', {
      name: 'Journey A errors',
      kind: 'journey_errors',
      config: { window: 'PT1H', threshold: 5, journeyId: JOURNEY_A },
      channels: [{ type: 'webhook', webhookId: endpoint.id }],
    });

    await evaluate(T0);
    // Exactly at the threshold is not "above" it; the other journey adds 4, so the all-journeys rule fires.
    let rules = await rulesIn();
    expect(rules.find((r) => r.id === onlyA.rule.id)).toMatchObject({ state: 'ok' });
    expect(rules.find((r) => r.id === all.rule.id)).toMatchObject({ state: 'firing' });
    expect((await eventRows())[0].value).toBe(9);

    // One more failure in journey A moves it above the threshold too.
    await t.srv.events.insertJourneyEvents([...failedJourneyEvents(wsA, JOURNEY_A, T(-5 * 60_000), 1, 200)]);
    await evaluate(T0 + 60_000);
    rules = await rulesIn();
    expect(rules.find((r) => r.id === onlyA.rule.id)).toMatchObject({ state: 'firing' });
    expect((await eventRows()).filter((e) => e.state === 'firing')).toHaveLength(2);
  });

  it('keeps every metric read inside the rule’s workspace', async () => {
    // The same bad data in wsB must not fire a wsA rule, even with an identical rule in both.
    const base = T0 + 30 * HOUR;
    const at = new Date(base - 10 * 60_000).toISOString();
    await t.srv.events.insertMessageEvents([
      ...messageEvents(wsA, at, { sent: 200, bounced: 20 }),
      ...messageEvents(wsB, at, { sent: 200, bounced: 0 }),
    ]);
    await api().call('alerts.create', {
      name: 'Only A',
      kind: 'deliverability',
      config: { metric: 'bounce', window: 'PT1H', threshold: 0.05, minSent: 100 },
      channels: [{ type: 'webhook', webhookId: endpoint.id }],
    });
    await evaluate(base);
    expect((await rulesIn(wsA))[0]).toMatchObject({ state: 'firing' });
    expect(await rulesIn(wsB)).toHaveLength(0);
    expect(await eventRows(wsB)).toHaveLength(0);
  });
});

describe('alert commands', () => {
  it('applies sensible defaults, validates configuration and manages the rule lifecycle', async () => {
    const created = await api().call('alerts.create', {
      name: 'Defaults',
      kind: 'deliverability',
      config: {},
      channels: [{ type: 'webhook', webhookId: endpoint.id }],
    });
    expect(created.rule.config).toMatchObject({ metric: 'bounce', window: 'PT24H', threshold: 0.05, minSent: 100 });
    expect(created.rule.state).toBe('ok');

    const complaint = await api().call('alerts.create', {
      name: 'Complaints',
      kind: 'deliverability',
      config: { metric: 'complaint' },
      channels: [{ type: 'email', userIds: [owner.id] }],
    });
    expect(complaint.rule.config).toMatchObject({ metric: 'complaint', threshold: 0.001 });

    const signup = await api().call('alerts.create', {
      name: 'Signup defaults',
      kind: 'signup_drop',
      config: {},
      channels: [{ type: 'webhook', webhookId: endpoint.id }],
    });
    expect(signup.rule.config).toMatchObject({ window: 'PT24H', dropPercent: 50, minPrevious: 10 });

    const journey = await api().call('alerts.create', {
      name: 'Journey defaults',
      kind: 'journey_errors',
      config: {},
      channels: [{ type: 'webhook', webhookId: endpoint.id }],
    });
    expect(journey.rule.config).toMatchObject({ window: 'PT1H', threshold: 5 });

    expect(
      (
        await rejects(
          api().call('alerts.create', {
            name: 'Bad window',
            kind: 'deliverability',
            config: { window: 'PT30M' },
            channels: [{ type: 'webhook', webhookId: endpoint.id }],
          }),
        )
      ).message,
    ).toMatch(/window: Use a duration between PT1H and P7D/);

    expect(
      (
        await rejects(
          api().call('alerts.create', {
            name: 'Unknown endpoint',
            kind: 'journey_errors',
            config: {},
            channels: [{ type: 'webhook', webhookId: `whk_${'f'.repeat(32)}` }],
          }),
        )
      ).message,
    ).toContain('webhook endpoint');

    const got = await api().call('alerts.get', { id: created.rule.id });
    expect(got.rule.id).toBe(created.rule.id);
    expect(got.openEvent).toBeNull();

    const updated = await api().call('alerts.update', { id: created.rule.id, name: 'Renamed', enabled: false });
    expect(updated.rule).toMatchObject({ name: 'Renamed', enabled: false });
    expect((await rulesIn()).find((r) => r.id === created.rule.id)?.name).toBe('Renamed');

    await api().call('alerts.delete', { id: created.rule.id });
    expect((await rulesIn()).some((r) => r.id === created.rule.id)).toBe(false);
    expect((await rejects(api().call('alerts.get', { id: created.rule.id }))).message).toContain('No alert rule');
  });

  it('sends a test notification to both channels without opening a firing event', async () => {
    const rule = await api().call('alerts.create', {
      name: 'Test me',
      kind: 'signup_drop',
      config: { window: 'PT24H', dropPercent: 50, minPrevious: 10 },
      channels: [
        { type: 'webhook', webhookId: endpoint.id },
        { type: 'email', userIds: [owner.id] },
      ],
    });
    const result = await api().call('alerts.test', { id: rule.rule.id });
    expect(result.notifications).toHaveLength(2);
    expect(result.notifications.every((n) => n.event === 'test' && n.status === 'sent')).toBe(true);
    const deliveries = await eventually(
      async () => received.filter((r) => r.path === '/alerts' && JSON.parse(r.body).type === 'alert.test'),
      (rows) => rows.length === 1,
    );
    expect(JSON.parse(deliveries[0].body)).toMatchObject({ type: 'alert.test', rule: { id: rule.rule.id } });
    expect(await alertMessages()).toHaveLength(1);
    expect(await eventRows()).toHaveLength(0);
  });

  it('lets readers read but not write, and never crosses a tenant boundary', async () => {
    const rule = await api().call('alerts.create', {
      name: 'Tenant A only',
      kind: 'journey_errors',
      config: {},
      channels: [{ type: 'webhook', webhookId: endpoint.id }],
    });
    const reader = t.api(viewer, wsA);
    expect((await reader.call('alerts.list', {})).rules.map((r) => r.id)).toEqual([rule.rule.id]);
    expect((await reader.call('alerts.get', { id: rule.rule.id })).rule.id).toBe(rule.rule.id);
    expect((await reader.call('alerts.history', {})).events).toEqual([]);
    expect(
      (
        await rejects(
          reader.call('alerts.create', {
            name: 'Nope',
            kind: 'journey_errors',
            config: {},
            channels: [{ type: 'webhook', webhookId: endpoint.id }],
          }),
        )
      ).message,
    ).toContain('permission');

    // wsB cannot see, read or delete wsA's rule.
    expect(await rulesIn(wsB)).toHaveLength(0);
    expect((await rejects(api(wsB).call('alerts.get', { id: rule.rule.id }))).message).toContain('No alert rule');
    expect((await rejects(api(wsB).call('alerts.delete', { id: rule.rule.id }))).message).toContain('No alert rule');
  });
});
