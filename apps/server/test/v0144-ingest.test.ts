import { runRetentionOnce } from '@agentic-marketing/audience';
import { outbox } from '@agentic-marketing/email';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// 0.14.4 (#623, #624, #627): a strict tracking plan still lets the platform's own signup, import
// and e-mail carrier events through; declared property problems do not depend on the unknown*
// settings; and retention finds unconfirmed form signups whatever anonymous id the client sent.

const PORT = testPort(4331);
const SITE = 'https://signup.example.com';
const nextFrame = (body: string) =>
  `<mjml><mj-body><mj-section><mj-column><mj-text>${body}</mj-text></mj-column></mj-section></mj-body></mjml>`;

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let strictWs = '';
let plainWs = '';

const api = (ws = strictWs) => t.api(owner, ws);

async function createForm(ws: string, opts: { doubleOptIn: boolean; confirmationTemplate?: string }) {
  const a = api(ws);
  const { artifactId } = await a.call('artifacts.create', {
    type: 'form',
    name: `Signup ${Date.now()}`,
    content: {
      purposes: ['marketing_email'],
      doubleOptIn: opts.doubleOptIn,
      ...(opts.confirmationTemplate ? { confirmationTemplate: opts.confirmationTemplate } : {}),
      consentText: 'I agree to receive the newsletter.',
      successUrl: `${SITE}/thanks`,
      confirmedUrl: `${SITE}/welcome`,
      allowedOrigins: [SITE],
    },
  });
  await a.call('artifacts.requestPublish', { artifactId, note: 'test form' });
  return artifactId;
}

async function submit(formId: string, email: string, anonymousId?: string) {
  return fetch(`${t.base}/f/${formId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: SITE },
    body: JSON.stringify({ email, ...(anonymousId ? { anonymousId } : {}) }),
  });
}

async function profileOf(ws: string, email: string) {
  return eventually(
    () => api(ws).call('profiles.find', { type: 'email', value: email }),
    (r) => !!r.profileId,
  );
}

beforeAll(async () => {
  t = await startTestServer('test_v0144_ingest', PORT);
  owner = await t.signUp(`owner-0144-${Date.now()}@example.com`);
  strictWs = await t.workspaceWith([[owner, 'owner']]);
  plainWs = await t.workspaceWith([[owner, 'owner']]);

  const { artifactId } = await api().call('artifacts.create', {
    type: 'tracking_plan',
    name: 'Strict product analytics',
    content: { unknownEvents: 'block', unknownProperties: 'block', events: [] },
  });
  await api().call('artifacts.requestPublish', { artifactId, note: 'strict plan' });
}, 60_000);

afterAll(() => t?.close());

describe('a strict tracking plan and the platform carrier events (#624)', () => {
  it('accepts a newsletter signup end to end and records its consent', async () => {
    const form = await createForm(strictWs, { doubleOptIn: false });
    const email = 'strict-signup@example.com';
    const res = await submit(form, email);
    expect(await res.json()).toEqual({ ok: true, doubleOptIn: false });

    const { profileId } = await profileOf(strictWs, email);
    expect(profileId).toBeTruthy();
    const profile = await eventually(
      () => api().call('profiles.get', { profileId: profileId! }),
      (p) => p.consent.length > 0,
    );
    expect(profile.consent.map((c) => c.purpose)).toContain('marketing_email');
  });

  it('records imported consent instead of rejecting the carrier event', async () => {
    const email = 'strict-import@example.com';
    const out = await api().call('profiles.import', {
      label: 'Kit export',
      rows: [{ email, consent: [{ purpose: 'marketing_email', status: 'granted', proof: { system: 'Kit' } }] }],
    });
    expect(out).toMatchObject({ accepted: 1, rejected: [] });

    const { profileId } = await profileOf(strictWs, email);
    const profile = await eventually(
      () => api().call('profiles.get', { profileId: profileId! }),
      (p) => p.consent.length > 0,
    );
    expect(profile.consent).toEqual([expect.objectContaining({ purpose: 'marketing_email', status: 'granted', source: 'import' })]);
  });

  it('gives a public /v1 client no bypass for a platform event name', async () => {
    const { key } = await api().call('sources.create', { name: 'Public server', kind: 'server' });
    const res = await fetch(`${t.base}/v1/track`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
      body: JSON.stringify({ type: 'track', event: 'Form Submitted', anonymousId: 'public-client' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      success: false,
      rejected: [{ error: 'Event "Form Submitted" is not in the tracking plan.' }],
    });
  });
});

describe('retention of unconfirmed form signups (#627)', () => {
  let form = '';
  const unconfirmed = { email: 'retention-unconfirmed@example.com', anon: 'sdk-client-unconfirmed' };
  const confirmed = { email: 'retention-confirmed@example.com', anon: 'sdk-client-confirmed' };
  const active = { email: 'retention-active@example.com', anon: 'sdk-client-active' };

  beforeAll(async () => {
    const a = api(plainWs);
    await a.call('emailProviders.create', {
      name: 'Outbox',
      adapter: 'log',
      fromEmail: 'news@example.com',
      useFor: ['transactional', 'marketing'],
    });
    const template = await a.call('artifacts.create', {
      type: 'email_template',
      name: 'Confirm',
      content: { purpose: 'onboarding', subject: 'Confirm', mjml: nextFrame('<a href="{{ confirm_url | raw }}">Confirm</a>') },
    });
    await a.call('artifacts.requestPublish', { artifactId: template.artifactId, note: 'confirm' });
    form = await createForm(plainWs, { doubleOptIn: true, confirmationTemplate: template.artifactId });

    for (const person of [unconfirmed, confirmed, active]) expect((await submit(form, person.email, person.anon)).status).toBe(200);

    // Confirm one of them through the link the double opt-in mail carries.
    const mail = await eventually(
      async () => outbox.filter((m) => m.to === confirmed.email),
      (m) => m.length === 1,
    );
    let link = mail[0].html.match(/href="([^"]*\/(?:c|f\/confirm)\/[^"]+)"/)![1].replace(/&amp;/g, '&');
    if (link.startsWith('/')) link = `${t.base}${link}`;
    if (link.includes('/c/')) link = (await fetch(link, { redirect: 'manual' })).headers.get('location')!;
    if (link.startsWith('/')) link = `${t.base}${link}`;
    expect((await fetch(link, { method: 'POST', redirect: 'manual' })).status).toBe(303);
    const { profileId } = await profileOf(plainWs, confirmed.email);
    await eventually(
      () => a.call('consent.history', { profileId: profileId! }),
      (r) => r.records.length > 0,
    );

    // The third person goes on to do something that is not a form submission: an ordinary event.
    const { key } = await a.call('sources.create', { name: 'Activity', kind: 'server' });
    const res = await fetch(`${t.base}/v1/track`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
      body: JSON.stringify({ type: 'track', event: 'Viewed Pricing', anonymousId: active.anon }),
    });
    expect(res.status).toBe(200);

    // Retention only considers people whose first sighting is older than the window.
    await t.srv.db.admin.query(`UPDATE profiles SET first_seen = now() - interval '31 days' WHERE workspace_id = $1`, [plainWs]);
    // The event store is the record of activity, so wait until the sink has each person's events.
    for (const person of [unconfirmed, confirmed])
      await eventually(
        async () =>
          (await t.srv.events.eventsOf(plainWs, { anonymousIds: [person.anon], userIds: [] })).some((e) => e.name === 'Form Submitted'),
        Boolean,
      );
    await eventually(
      async () =>
        (await t.srv.events.eventsOf(plainWs, { anonymousIds: [active.anon], userIds: [] })).some((e) => e.name === 'Viewed Pricing'),
      Boolean,
    );
  }, 60_000);

  it('removes the unconfirmed signup that used a client anonymousId', async () => {
    const result = await runRetentionOnce({ db: t.srv.db, events: t.srv.events, hot: t.srv.hot, unconfirmedDays: 30, logDays: 180 });
    expect(result.profiles).toBe(1);
    expect((await profileOf(plainWs, unconfirmed.email)).profileId).toBeNull();
  });

  it('keeps the confirmed subscriber', async () => {
    expect((await profileOf(plainWs, confirmed.email)).profileId).toBeTruthy();
  });

  it('keeps a signup that has other activity', async () => {
    expect((await profileOf(plainWs, active.email)).profileId).toBeTruthy();
  });
});
