import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, rejects, startTestServer, type User } from './harness';

// Phase 2, e-mail: templates, providers and the send gateway, end to end through a real SMTP
// exchange. Delivery events arrive as Postmark webhooks (the relay is "SMTP to Postmark").

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws: string;
const inbox: { to: string[]; data: string }[] = [];
const smtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  onData(stream, session, cb) {
    let data = '';
    stream.on('data', (c) => (data += c));
    stream.on('end', () => {
      inbox.push({ to: session.envelope.rcptTo.map((r) => r.address), data });
      cb();
    });
  },
});
const SMTP_PORT = 2527;

beforeAll(async () => {
  await new Promise<void>((r) => smtp.listen(SMTP_PORT, '127.0.0.1', () => r()));
  t = await startTestServer('test_p2', 3296);
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']]);
}, 60_000);
afterAll(async () => {
  await t?.close();
  await new Promise<void>((r) => smtp.close(() => r()));
});

const template = {
  purpose: 'marketing_email',
  subject: 'Hej {{ profile.firstName }}, new tents',
  mjml: `<mjml><mj-body><mj-section><mj-column>
    <mj-text>Hej {{ profile.firstName }}! {{ event.properties.sku }} is back.</mj-text>
    <mj-button href="https://shop.example.com/tents?x=1&y=2">See tents</mj-button>
    <mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text>
  </mj-column></mj-section></mj-body></mjml>`,
};

/** Decodes quoted-printable soft line breaks enough to search the message. */
const flat = (raw: string) => raw.replace(/=\r?\n/g, '').replace(/=3D/g, '=');

async function person(serverKey: string, userId: string, email: string, marketing: boolean) {
  const res = await fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${serverKey}:`).toString('base64')}` },
    body: JSON.stringify({
      batch: [
        { type: 'identify', userId, traits: { email, firstName: userId === 'u-ada' ? 'Ada' : 'Bo' }, timestamp: '2026-10-21T08:00:00Z' },
        {
          type: 'track',
          event: 'Segment Consent Preference Updated',
          userId,
          timestamp: '2026-10-21T08:00:01Z',
          context: { consent: { categoryPreferences: { marketing_email: marketing } } },
        },
      ],
    }),
  });
  expect(res.status).toBe(200);
  const api = t.api(owner);
  const { profileId } = await eventually(
    () => api.call('profiles.find', { type: 'user_id', value: userId }),
    (r) => !!r.profileId,
  );
  await eventually(
    () => api.call('profiles.get', { profileId: profileId! }),
    (p) => p.consent.length > 0,
  );
  return profileId!;
}

describe('e-mail end to end', () => {
  let ada: string;
  let bo: string;
  let templateId: string;
  let webhookPath: string;

  it('validates and publishes a template, and previews it', async () => {
    const api = t.api(owner);
    const bad = await rejects(
      api.call('artifacts.create', {
        type: 'email_template',
        name: 'Broken',
        content: { ...template, mjml: template.mjml.replace('unsubscribe_url', 'x') },
      }),
    );
    expect(bad.status).toBe(400);
    expect(bad.message).toContain('unsubscribe link');
    const created = await api.call('artifacts.create', { type: 'email_template', name: 'Tents are back', content: template });
    templateId = created.artifactId;
    const preview = await api.call('templates.preview', {
      artifactId: templateId,
      data: { profile: { firstName: 'Test' }, event: { properties: { sku: 'TENT-2' } } },
    });
    expect(preview.subject).toBe('Hej Test, new tents');
    expect(preview.text).toContain('TENT-2 is back');
  });

  it('refuses to send an unpublished template, then sends a published one through SMTP', async () => {
    const api = t.api(owner);
    const { key } = await api.call('sources.create', { name: 'Backend', kind: 'server' });
    ada = await person(key, 'u-ada', 'ada@example.com', true);
    bo = await person(key, 'u-bo', 'bo@example.com', false);

    expect(await api.call('messages.sendEmail', { profileId: ada, templateId })).toMatchObject({
      status: 'failed',
      reason: expect.stringMatching(/^not_published/),
    });
    await api.call('artifacts.requestPublish', { artifactId: templateId, note: 'Launch' });

    const p = await api.call('emailProviders.create', {
      name: 'Relay',
      adapter: 'smtp',
      config: { host: '127.0.0.1', port: SMTP_PORT, requireTls: false, events: 'postmark' },
      secrets: { password: 'relay-password' },
      fromEmail: 'news@shop.example.com',
      fromName: 'Fjeldvej',
      useFor: ['marketing', 'transactional'],
    });
    webhookPath = p.webhookPath;
    expect((await api.call('emailProviders.list', {})).providers[0]).toMatchObject({
      hasCredentials: true,
      useFor: ['marketing', 'transactional'],
    });
    expect(JSON.stringify(await api.call('emailProviders.list', {}))).not.toContain('relay-password');

    const sent = await api.call('messages.sendEmail', {
      profileId: ada,
      templateId,
      idempotencyKey: 'welcome-ada',
      data: { event: { properties: { sku: 'TENT-2' } } },
    });
    expect(sent).toMatchObject({ status: 'queued', duplicate: false });
    expect(await api.call('messages.sendEmail', { profileId: ada, templateId, idempotencyKey: 'welcome-ada' })).toMatchObject({
      messageId: sent.messageId,
      duplicate: true,
    });

    const mail = await eventually(
      async () => inbox.find((m) => m.to.includes('ada@example.com')),
      (m) => !!m,
    );
    const raw = flat(mail!.data);
    expect(raw).toMatch(/^Subject: Hej Ada, new tents/m);
    expect(raw).toContain('TENT-2 is back');
    expect(raw).toMatch(new RegExp(`^X-AM-Message-Id: ${sent.messageId}`, 'mi'));
    expect(raw).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click/m);
    expect(raw).toContain(`${t.base}/c/`);
    expect(raw).not.toContain('href="https://shop.example.com/tents');

    const { messages } = await eventually(
      () => api.call('messages.list', { profileId: ada }),
      (r) => r.messages[0]?.status === 'sent' && r.messages[0].events.length === 2,
    );
    expect(messages[0].events.map((e) => e.type)).toEqual(['queued', 'sent']);
  });

  it('explains why a person without consent gets nothing', async () => {
    const r = await t.api(owner).call('messages.sendEmail', { profileId: bo, templateId });
    expect(r).toMatchObject({ status: 'suppressed', reason: expect.stringContaining('no_lawful_basis') });
    expect(inbox.some((m) => m.to.includes('bo@example.com'))).toBe(false);
  });

  it('counts clicks and redirects only signed links', async () => {
    const raw = flat(inbox.find((m) => m.to.includes('ada@example.com'))!.data);
    const click = raw.match(new RegExp(`${t.base}/c/([A-Za-z0-9_.-]+)`))![0];
    const res = await fetch(click, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://shop.example.com/tents?x=1&y=2');
    expect((await fetch(`${click}x`, { redirect: 'manual' })).status).toBe(404);
    await eventually(
      () => t.api(owner).call('messages.list', { profileId: ada }),
      (r) => r.messages[0].events.some((e) => e.type === 'clicked'),
    );
  });

  it('applies provider webhooks: a hard bounce suppresses the address', async () => {
    const api = t.api(owner);
    const { messages } = await api.call('messages.list', { profileId: ada });
    const bounce = {
      RecordType: 'Bounce',
      ID: 7,
      Type: 'HardBounce',
      Description: 'Unknown user',
      MessageID: 'pm-x',
      BouncedAt: '2026-10-22T09:00:00Z',
      Metadata: { am_message_id: messages[0].id },
    };
    expect((await fetch(`${t.base}${webhookPath}x`, { method: 'POST', body: JSON.stringify(bounce) })).status).toBe(404);
    const res = await fetch(`${t.base}${webhookPath}`, { method: 'POST', body: JSON.stringify(bounce) });
    expect(await res.json()).toEqual({ ok: true, events: 1 });
    const after = await eventually(
      () => api.call('messages.list', { profileId: ada }),
      (r) => r.messages[0].status === 'bounced',
    );
    expect(after.messages[0].events.map((e) => e.type)).toContain('bounced');
    expect(await api.call('messages.sendEmail', { profileId: ada, templateId })).toMatchObject({
      status: 'suppressed',
      reason: expect.stringContaining('suppression list (hard_bounce)'),
    });
    const stats = await eventually(
      () => api.call('messages.stats', { templateId }),
      (s) => (s.counts.suppressed ?? 0) >= 2,
    );
    expect(stats.counts).toMatchObject({ sent: 1, bounced: 1, clicked: 1 });
    expect(stats.rates).toMatchObject({ bounced: 100, clicked: 100 });
  });

  it('records a one-click unsubscribe as a withdrawal of consent', async () => {
    const api = t.api(owner);
    const { key } = await api.call('sources.create', { name: 'Backend 2', kind: 'server' });
    const cy = await person(key, 'u-cy', 'cy@example.com', true);
    await api.call('messages.sendEmail', { profileId: cy, templateId });
    const mail = await eventually(
      async () => inbox.find((m) => m.to.includes('cy@example.com')),
      (m) => !!m,
    );
    const unsub = flat(mail!.data).match(new RegExp(`${t.base}/u/[A-Za-z0-9_.-]+`))![0];
    expect((await fetch(unsub)).status).toBe(200);
    const res = await fetch(unsub, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(res.status).toBe(200);
    const history = await api.call('consent.history', { profileId: cy });
    expect(history.records.at(-1)).toMatchObject({
      purpose: 'marketing_email',
      channel: 'email',
      status: 'withdrawn',
      source: 'unsubscribe',
    });
    expect(await api.call('messages.sendEmail', { profileId: cy, templateId })).toMatchObject({
      status: 'suppressed',
      reason: expect.stringContaining('withdrawn'),
    });
    expect(ws).toBeTruthy();
  });
});

describe('retry schedule', () => {
  it('retries a failed transactional send in seconds, keeps marketing on the old backoff, and reports why', async () => {
    // A workspace of its own, with a provider that refuses connections, so these failures cannot
    // disturb the working relay above.
    const retryWs = await t.workspaceWith([[owner, 'owner']]);
    const api = t.api(owner, retryWs);
    const { key } = await api.call('sources.create', { name: 'Retry backend', kind: 'server' });
    const userId = `u-retry-${Date.now()}`;
    const email = `${userId}@example.com`;
    const res = await fetch(`${t.base}/v1/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
      body: JSON.stringify({
        batch: [
          { type: 'identify', userId, traits: { email }, timestamp: '2026-10-26T08:00:00Z' },
          {
            type: 'track',
            event: 'Segment Consent Preference Updated',
            userId,
            timestamp: '2026-10-26T08:00:01Z',
            context: { consent: { categoryPreferences: { marketing_email: true } } },
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const { profileId } = await eventually(
      () => api.call('profiles.find', { type: 'user_id', value: userId }),
      (r) => !!r.profileId,
    );

    const transactional = await api.call('artifacts.create', {
      type: 'email_template',
      name: 'Confirm your address',
      content: {
        purpose: 'onboarding',
        subject: 'Confirm your address',
        mjml: `<mjml><mj-body><mj-section><mj-column><mj-text>Confirm at {{ confirm_url }}</mj-text></mj-column></mj-section></mj-body></mjml>`,
      },
    });
    const marketing = await api.call('artifacts.create', {
      type: 'email_template',
      name: 'Retry marketing',
      content: { ...template, subject: 'News that retries' },
    });
    await api.call('artifacts.requestPublish', { artifactId: transactional.artifactId, note: 'retry test' });
    await api.call('artifacts.requestPublish', { artifactId: marketing.artifactId, note: 'retry test' });
    await api.call('emailProviders.create', {
      name: 'Dead relay',
      adapter: 'smtp',
      config: { host: '127.0.0.1', port: 2528, requireTls: false },
      secrets: { password: 'irrelevant' },
      fromEmail: 'news@shop.example.com',
      useFor: ['marketing', 'transactional'],
    });

    const txn = await api.call('messages.sendEmail', { profileId: profileId!, templateId: transactional.artifactId });
    const mkt = await api.call('messages.sendEmail', { profileId: profileId!, templateId: marketing.artifactId });
    expect(txn.status).toBe('queued');
    expect(mkt.status).toBe('queued');

    // The worker fails both against the dead relay. A transactional message is due in seconds; a
    // marketing one keeps 30 s on the first attempt.
    const failed = await eventually(
      async () => (await api.call('messages.list', { profileId: profileId!, limit: 10 })).messages,
      (rows) => rows.length === 2 && rows.every((r) => r.attempts >= 1 && r.status === 'queued' && r.nextAttemptAt),
    );
    const txnRow = failed.find((r) => r.templateId === transactional.artifactId)!;
    const mktRow = failed.find((r) => r.templateId === marketing.artifactId)!;
    const secondsUntil = (iso: string | null) => (new Date(iso!).getTime() - Date.now()) / 1000;
    expect(secondsUntil(txnRow.nextAttemptAt)).toBeGreaterThan(5);
    expect(secondsUntil(txnRow.nextAttemptAt)).toBeLessThan(15);
    expect(secondsUntil(mktRow.nextAttemptAt)).toBeGreaterThan(20);
    expect(secondsUntil(mktRow.nextAttemptAt)).toBeLessThan(35);
    expect(txnRow.lastError).toContain('provider_error');
    expect(mktRow.lastError).toContain('provider_error');

    // Move only the transactional retry into the past, as waiting ten seconds would. Its next
    // attempt must then happen; the marketing row stays where its own backoff put it.
    await t.srv.db.admin.query(`UPDATE messages SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [txn.messageId]);
    const retried = await eventually(
      async () => (await api.call('messages.list', { profileId: profileId!, limit: 10 })).messages,
      (rows) => (rows.find((r) => r.id === txn.messageId)?.attempts ?? 0) >= 2,
    );
    expect(retried.find((r) => r.id === txn.messageId)).toMatchObject({
      attempts: 2,
      status: 'queued',
      lastError: expect.stringContaining('provider_error'),
    });
    expect(retried.find((r) => r.id === mkt.messageId)?.attempts).toBe(1);
  }, 30_000);
});
