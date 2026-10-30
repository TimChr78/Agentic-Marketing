import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runRetentionOnce } from '@agentic-marketing/audience';
import { outbox } from '@agentic-marketing/email';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, rejects, startTestServer, testPort, type User } from './harness';

// Phase 6 (wave 2): what happens to e-mails becomes customer events (segments, journeys and
// webhooks can use clicks), links carry UTM tags, templates can be test-sent to members, and
// signups that were never confirmed are removed.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let key = '';
let ada = '';
const received: { path: string; body: string }[] = [];
let receiverUrl = '';
const receiver = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ path: req.url ?? '', body });
    res.end('ok');
  });
});

const mjml = (body: string) =>
  `<mjml><mj-body><mj-section><mj-column><mj-text>${body}</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>`;

beforeAll(async () => {
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  t = await startTestServer('test_p6', testPort(3292));
  owner = await t.signUp(`owner-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']]);
  const api = t.api(owner);
  await api.call('emailProviders.create', {
    name: 'Outbox',
    adapter: 'log',
    fromEmail: 'news@example.com',
    useFor: ['transactional', 'marketing'],
  });
  key = (await api.call('sources.create', { name: 'Backend', kind: 'server' })).key;
  const res = await fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    body: JSON.stringify({
      batch: [
        { type: 'identify', userId: 'u-ada', traits: { email: 'ada@example.com', firstName: 'Ada' } },
        {
          type: 'track',
          event: 'Segment Consent Preference Updated',
          userId: 'u-ada',
          context: { consent: { categoryPreferences: { marketing_email: true } } },
        },
      ],
    }),
  });
  expect(res.status).toBe(200);
  ada = (
    await eventually(
      () => api.call('profiles.find', { type: 'user_id', value: 'u-ada' }),
      (r) => !!r.profileId,
    )
  ).profileId!;
  await eventually(
    () => api.call('profiles.get', { profileId: ada }),
    (p) => p.consent.length > 0,
  );
}, 60_000);
afterAll(async () => {
  await t?.close();
  receiver.close();
});

describe('e-mail events on profiles', () => {
  let templateId = '';

  it('tags links with UTM parameters and turns a click into a customer event', async () => {
    const api = t.api(owner);
    const segment = await api.call('artifacts.create', {
      type: 'segment',
      name: 'Clicked a newsletter',
      content: { condition: { event: 'Email Link Clicked' } },
    });
    await api.call('artifacts.requestPublish', { artifactId: segment.artifactId, note: 'x' });
    await api.call('webhooks.create', { name: 'n8n', url: `${receiverUrl}/n8n`, events: ['Email Link Clicked'] });
    templateId = (
      await api.call('artifacts.create', {
        type: 'email_template',
        name: 'Signal #1',
        content: {
          purpose: 'marketing_email',
          subject: 'Signal #1',
          mjml: mjml(
            '<a href="https://martechsignal.com/posts/one/">Read</a> <a href="https://other.example/x?utm_source=them">Theirs</a>',
          ),
          utm: { campaign: 'signal-1', domains: ['martechsignal.com'] },
        },
      })
    ).artifactId;
    await api.call('artifacts.requestPublish', { artifactId: templateId, note: 'x' });
    expect(await api.call('messages.sendEmail', { profileId: ada, templateId })).toMatchObject({ status: 'queued' });

    const mail = await eventually(
      async () => outbox.filter((m) => m.to === 'ada@example.com' && m.subject === 'Signal #1'),
      (m) => m.length === 1,
    );
    const tracked = [...mail[0].html.matchAll(/href="([^"]*\/c\/[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    const targets = await Promise.all(tracked.map(async (l) => (await fetch(l, { redirect: 'manual' })).headers.get('location')));
    expect(targets).toContain('https://martechsignal.com/posts/one/?utm_source=newsletter&utm_medium=email&utm_campaign=signal-1');
    expect(targets).toContain('https://other.example/x?utm_source=them');
    expect(targets.some((u) => u?.includes('/u/'))).toBe(false);

    const hook = await eventually(
      async () => received.filter((r) => r.path === '/n8n'),
      (r) => r.length >= 1,
      15_000,
    );
    expect(JSON.parse(hook[0].body)).toMatchObject({
      type: 'event.track',
      data: { event: { name: 'Email Link Clicked', properties: { template_id: templateId, purpose: 'marketing_email' } } },
    });
    await eventually(
      () => api.call('segments.ofProfile', { profileId: ada }),
      (r) => JSON.stringify(r).includes(segment.artifactId),
      15_000,
    );
  });

  it('sends a test only to members, marked as a test', async () => {
    const api = t.api(owner);
    expect(await api.call('templates.sendTest', { artifactId: templateId })).toMatchObject({
      to: owner.email,
      subject: '[Test] Signal #1',
      provider: 'Outbox',
    });
    expect(outbox.filter((m) => m.to === owner.email && m.subject === '[Test] Signal #1')).toHaveLength(1);
    const err = await rejects(api.call('templates.sendTest', { artifactId: templateId, to: 'stranger@example.com' }));
    expect(err.message).toContain('members of this workspace');
  });
});

describe('retention', () => {
  it('removes signups that were never confirmed, and keeps everyone else', async () => {
    const api = t.api(owner);
    const confirm = await api.call('artifacts.create', {
      type: 'email_template',
      name: 'Confirm',
      content: { purpose: 'onboarding', subject: 'Confirm', mjml: mjml('<a href="{{ confirm_url | raw }}">Confirm</a>') },
    });
    await api.call('artifacts.requestPublish', { artifactId: confirm.artifactId, note: 'x' });
    const form = await api.call('artifacts.create', {
      type: 'form',
      name: 'Newsletter',
      content: {
        purposes: ['marketing_email'],
        doubleOptIn: true,
        confirmationTemplate: confirm.artifactId,
        consentText: 'Yes please.',
        successUrl: '/thanks',
        confirmedUrl: '/welcome',
      },
    });
    await api.call('artifacts.requestPublish', { artifactId: form.artifactId, note: 'x' });
    const res = await fetch(`${t.base}/f/${form.artifactId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'never@example.com' }),
    });
    expect(res.status).toBe(200);
    const { profileId } = await eventually(
      () => api.call('profiles.find', { type: 'email', value: 'never@example.com' }),
      (r) => !!r.profileId,
    );

    const deps = { db: t.srv.db, events: t.srv.events, hot: t.srv.hot, unconfirmedDays: 30, logDays: 180 };
    expect((await runRetentionOnce(deps)).profiles).toBe(0); // too recent
    await t.srv.db.admin.query(`UPDATE profiles SET first_seen = now() - interval '31 days'`);
    expect((await runRetentionOnce(deps)).profiles).toBe(1);
    expect((await api.call('profiles.find', { type: 'email', value: 'never@example.com' })).profileId).toBeNull();
    expect((await api.call('profiles.get', { profileId: ada })).consent.length).toBeGreaterThan(0);
    // Not suppressed: they may sign up again.
    expect(profileId).toBeTruthy();
    const again = await fetch(`${t.base}/f/${form.artifactId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'never@example.com' }),
    });
    expect(await again.json()).toEqual({ ok: true, doubleOptIn: true });
    await eventually(
      async () => outbox.filter((m) => m.to === 'never@example.com'),
      (m) => m.length === 2,
    );
  });
});
