import { outbox, smsOutbox } from '@agentic-marketing/email';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, rejects, startTestServer, testPort, type User } from './harness';

// Phase 7 (wave 2): SMS as a second channel (consent, budget, STOP and HELP), and the delivery
// policy that applies to every marketing message: frequency caps, quiet hours, health.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ada = '';
let webhookPath = '';
const PHONE = '+4512345678';

const mjml = (body: string) =>
  `<mjml><mj-body><mj-section><mj-column><mj-text>${body}</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>`;
const hhmm = (d: Date) => d.toISOString().slice(11, 16);

async function publish(type: string, name: string, content: unknown) {
  const api = t.api(owner);
  const a = await api.call('artifacts.create', { type: type as 'note', name, content: content as Record<string, unknown> });
  await api.call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'x' });
  return a.artifactId;
}
let policyId = '';
async function policy(content: Record<string, unknown>) {
  if (!policyId) {
    policyId = await publish('delivery_policy', 'Delivery policy', content);
    return;
  }
  await t.api(owner).call('artifacts.updateDraft', { artifactId: policyId, content });
  await t.api(owner).call('artifacts.requestPublish', { artifactId: policyId, note: 'x' });
}
const messageOf = async (templateId: string) =>
  (await t.api(owner).call('messages.list', { profileId: ada, limit: 50 })).messages.filter((m) => m.templateId === templateId);
const form = (fields: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});

beforeAll(async () => {
  t = await startTestServer('test_p7', testPort(3291));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']]);
  const api = t.api(owner);
  await api.call('emailProviders.create', {
    name: 'Outbox',
    adapter: 'log',
    fromEmail: 'news@example.com',
    useFor: ['transactional', 'marketing'],
  });
  const sms = await api.call('smsProviders.create', {
    name: 'Texts',
    adapter: 'log',
    sender: 'Signal',
    useFor: ['transactional', 'marketing'],
    billing: { pricePerSegment: 0.1, monthlyBudget: 0.25, currency: 'EUR', helpText: 'MartechSignal texts. Reply STOP to stop.' },
  });
  webhookPath = sms.webhookPath;
  const { key } = await api.call('sources.create', { name: 'Backend', kind: 'server' });
  await fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({
      batch: [
        {
          type: 'identify',
          userId: 'u-ada',
          traits: { email: 'ada@example.com', phone: PHONE, firstName: 'Ada', timezone: 'Europe/Copenhagen' },
        },
        {
          type: 'track',
          event: 'Segment Consent Preference Updated',
          userId: 'u-ada',
          context: { consent: { categoryPreferences: { marketing_email: true, marketing_sms: true } } },
        },
      ],
    }),
  });
  ada = (
    await eventually(
      () => api.call('profiles.find', { type: 'user_id', value: 'u-ada' }),
      (r) => !!r.profileId,
    )
  ).profileId!;
  await eventually(
    () => api.call('profiles.get', { profileId: ada }),
    (p) => p.consent.length >= 2,
  );
  // No quiet hours while testing sends, so the results do not depend on the time of day.
  await policy({ quietHours: [] });
}, 60_000);
afterAll(() => t?.close());

describe('SMS', () => {
  let offer = '';

  it('previews the text with the opt-out footer, segments and cost', async () => {
    offer = await publish('sms_template', 'Offer', {
      purpose: 'marketing_sms',
      body: 'Hi {{ profile.firstName }}, 20% off this week.',
      sampleData: { profile: { firstName: 'Ada' } },
    });
    expect(await t.api(owner).call('smsTemplates.preview', { artifactId: offer })).toMatchObject({
      body: 'Hi Ada, 20% off this week. Reply STOP to opt out.',
      encoding: 'GSM-7',
      segments: 1,
      estimatedCost: { amount: 0.1, currency: 'EUR' },
    });
    const emoji = await t.api(owner).call('smsTemplates.preview', { artifactId: offer, data: { profile: { firstName: '🙂' } } });
    expect(emoji).toMatchObject({ encoding: 'UCS-2', segments: 1 });
  });

  it('texts a person with consent, and records the status callback', async () => {
    expect(await t.api(owner).call('messages.sendSms', { profileId: ada, templateId: offer })).toMatchObject({ status: 'queued' });
    const sent = await eventually(
      async () => smsOutbox.filter((m) => m.to === PHONE),
      (m) => m.length === 1,
    );
    expect(sent[0]).toMatchObject({ from: 'Signal', body: 'Hi Ada, 20% off this week. Reply STOP to opt out.' });
    expect(sent[0].statusUrl).toContain(`${webhookPath}/status`);
    const res = await fetch(sent[0].statusUrl, form({ MessageSid: `log-${sent[0].messageId}`, MessageStatus: 'delivered' }));
    expect(res.status).toBe(200);
    const [m] = await eventually(
      () => messageOf(offer),
      (x) => x[0]?.status === 'delivered',
    );
    expect(m).toMatchObject({ channel: 'sms', segments: 1 });
  });

  it('stops at the monthly budget', async () => {
    const long = await publish('sms_template', 'Shipping', {
      purpose: 'service_sms',
      body: `Your order has shipped. ${'Track it in your account. '.repeat(8)}`,
    });
    await t.api(owner).call('messages.sendSms', { profileId: ada, templateId: long });
    const [m] = await eventually(
      () => messageOf(long),
      (x) => x[0]?.status === 'suppressed',
    );
    expect(m.reason).toContain("this month's SMS budget");
  });

  it('honours STOP and answers HELP', async () => {
    const help = await fetch(`${t.base}${webhookPath}/inbound`, form({ From: PHONE, Body: 'help' }));
    expect(await help.text()).toContain('<Message>MartechSignal texts. Reply STOP to stop.</Message>');
    const stop = await fetch(`${t.base}${webhookPath}/inbound`, form({ From: PHONE, Body: 'Stop please' }));
    expect(stop.status).toBe(200);
    const { records } = await t.api(owner).call('consent.history', { profileId: ada });
    expect(records.find((r) => r.purpose === 'marketing_sms' && r.status === 'withdrawn')).toMatchObject({
      channel: 'sms',
      source: 'unsubscribe',
    });
    expect(await t.api(owner).call('messages.sendSms', { profileId: ada, templateId: offer, idempotencyKey: 'after-stop' })).toMatchObject({
      status: 'suppressed',
    });
    // E-mail consent is untouched.
    expect(records.some((r) => r.purpose === 'marketing_email' && r.status === 'withdrawn')).toBe(false);
  });

  it('refuses webhooks without a valid token', async () => {
    expect((await fetch(`${t.base}/hooks/sms/forged.token/inbound`, form({ From: PHONE, Body: 'STOP' }))).status).toBe(404);
  });
});

describe('delivery policy', () => {
  let issue = '';

  it('caps marketing e-mails per person', async () => {
    await policy({ quietHours: [], frequencyCaps: [{ channel: 'email', max: 1, days: 7 }] });
    issue = await publish('email_template', 'Issue', { purpose: 'marketing_email', subject: 'Issue', mjml: mjml('This week…') });
    const api = t.api(owner);
    await api.call('messages.sendEmail', { profileId: ada, templateId: issue, idempotencyKey: 'one' });
    await eventually(
      () => messageOf(issue),
      (x) => x[0]?.status === 'sent',
    );
    await api.call('messages.sendEmail', { profileId: ada, templateId: issue, idempotencyKey: 'two' });
    const second = await eventually(
      () => messageOf(issue),
      (x) => x.length === 2 && x[0].status === 'suppressed',
    );
    expect(second[0].reason).toBe('frequency_cap: 1 e-mails in 7 days (at most 1)');
    expect(outbox.filter((m) => m.subject === 'Issue')).toHaveLength(1);
  });

  it("holds marketing messages during quiet hours, in the person's time zone", async () => {
    const now = new Date();
    // Ada's time zone is Copenhagen; a UTC window around now would be wrong for her, so the
    // window is set in her local time.
    const local = new Date(`${now.toLocaleString('en-US', { timeZone: 'Europe/Copenhagen' })} UTC`);
    await policy({
      quietHours: [
        { channel: 'email', start: hhmm(new Date(local.getTime() - 3_600_000)), end: hhmm(new Date(local.getTime() + 3_600_000)) },
      ],
    });
    const later = await publish('email_template', 'Later', { purpose: 'marketing_email', subject: 'Later', mjml: mjml('Not now') });
    await t.api(owner).call('messages.sendEmail', { profileId: ada, templateId: later });
    const [m] = await eventually(
      () => messageOf(later),
      (x) => x[0]?.reason?.startsWith('quiet_hours') ?? false,
    );
    expect(m.status).toBe('queued');
    expect(Date.parse(m.notBefore!)).toBeGreaterThan(now.getTime() + 3_000_000);
    expect(outbox.filter((x) => x.subject === 'Later')).toHaveLength(0);
  });

  it('reports bounce and complaint rates', async () => {
    const h = await t.api(owner).call('deliverability.health', {});
    expect(h).toMatchObject({
      windowDays: 7,
      autoPause: true,
      thresholds: { complaintStop: 0.003 },
      email: { marketing: { status: 'ok' } },
    });
    expect(h.sms.marketing.sent).toBe(1);
  });

  it('checks the sending domain only for providers of this workspace', async () => {
    const err = await rejects(t.api(owner).call('emailProviders.checkDomain', { id: `epr_${'0'.repeat(32)}` }));
    expect(err.message).toContain('No e-mail provider');
  });
});
