import { outbox } from '@agentic-marketing/email';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, rejects, startTestServer, type User } from './harness';

// Pilot (MarTechSignal): a static site on Cloudflare Pages collects newsletter signups with a
// no-JS form and double opt-in, imports its existing subscribers with their consent, and sends a
// weekly newsletter as a broadcast to a consent-based segment.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
const ids = { form: '', confirm: '', newsletter: '', segment: '' };
const SITE = 'https://martechsignal.com';

const mjml = (body: string) =>
  `<mjml><mj-body><mj-section><mj-column><mj-text>${body}</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>`;
const post = (formId: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(`${t.base}/f/${formId}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: SITE, 'x-forwarded-for': '203.0.113.7', ...headers },
    body: new URLSearchParams(fields).toString(),
  });
const mailTo = (to: string) => outbox.filter((m) => m.to === to);

beforeAll(async () => {
  t = await startTestServer('test_pilot', 3297);
  owner = await t.signUp(`tim-${Date.now()}@example.com`);
  await t.workspaceWith([[owner, 'owner']], 'none');
  await t.api(owner).call('emailProviders.create', {
    name: 'Relay',
    adapter: 'log',
    fromEmail: 'signal@martechsignal.com',
    useFor: ['transactional', 'marketing'],
  });
}, 60_000);
afterAll(() => t?.close());

describe('signup form with double opt-in', () => {
  it('needs a confirmation template that may be sent before consent', async () => {
    const api = t.api(owner);
    const create = async (name: string, purpose: string, body: string) => {
      const a = await api.call('artifacts.create', { type: 'email_template', name, content: { purpose, subject: name, mjml: mjml(body) } });
      await api.call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'x' });
      return a.artifactId;
    };
    const wrong = await create('Confirm (marketing)', 'marketing_email', '<a href="{{ confirm_url | raw }}">Confirm</a>');
    ids.confirm = await create(
      'Confirm your subscription',
      'onboarding',
      'Hi {{ profile.firstName }}, <a href="{{ confirm_url | raw }}">confirm here</a>.',
    );
    const form = (confirmationTemplate: string) => ({
      purposes: ['marketing_email'],
      doubleOptIn: true,
      confirmationTemplate,
      consentText: 'Send me the weekly MartechSignal newsletter. Unsubscribe any time.',
      successUrl: `${SITE}/subscribe/check-your-inbox/`,
      confirmedUrl: `${SITE}/subscribe/welcome/`,
      errorUrl: `${SITE}/subscribe/oops/`,
      allowedOrigins: [SITE],
    });
    ids.form = (await api.call('artifacts.create', { type: 'form', name: 'Newsletter', content: form(wrong) })).artifactId;
    expect((await rejects(api.call('artifacts.requestPublish', { artifactId: ids.form, note: 'x' }))).message).toContain('needs consent');
    await api.call('artifacts.updateDraft', { artifactId: ids.form, content: form(ids.confirm) });
    await api.call('artifacts.requestPublish', { artifactId: ids.form, note: 'Go' });
  });

  it('accepts a plain HTML post, refuses bad input, and fools bots', async () => {
    const ok = await post(ids.form, { email: 'Ada@Example.com', firstName: 'Ada', page: `${SITE}/tools/` });
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe(`${SITE}/subscribe/check-your-inbox/`);

    const bad = await post(ids.form, { email: 'not-an-email' });
    expect(bad.headers.get('location')).toBe(`${SITE}/subscribe/oops/?error=invalid_email`);
    const elsewhere = await post(ids.form, { email: 'x@example.com' }, { origin: 'https://evil.example' });
    expect(elsewhere.headers.get('location')).toContain('error=origin_not_allowed');
    const bot = await post(ids.form, { email: 'bot@example.com', am_hp: 'http://spam' });
    expect(bot.headers.get('location')).toBe(`${SITE}/subscribe/check-your-inbox/`);

    const json = await fetch(`${t.base}/f/${ids.form}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: SITE },
      body: JSON.stringify({ email: 'cy@example.com' }),
    });
    expect(await json.json()).toEqual({ ok: true, doubleOptIn: true });
  });

  it('records consent only after the confirmation, with proof', async () => {
    const api = t.api(owner);
    const mail = await eventually(
      async () => mailTo('ada@example.com'),
      (m) => m.length === 1,
    );
    expect(mail[0].subject).toBe('Confirm your subscription');
    expect(mailTo('bot@example.com')).toHaveLength(0);
    const { profileId } = await api.call('profiles.find', { type: 'email', value: 'ada@example.com' });
    expect((await api.call('consent.history', { profileId: profileId! })).records).toHaveLength(0);

    // The link may be wrapped for click counting; follow it to the confirmation page.
    let link = mail[0].html.match(/href="([^"]*\/(?:c|f\/confirm)\/[^"]+)"/)![1].replace(/&amp;/g, '&');
    if (link.includes('/c/')) link = (await fetch(link, { redirect: 'manual' })).headers.get('location')!;
    expect(link).toContain('/f/confirm/');
    const pageRes = await fetch(link);
    expect(await pageRes.text()).toContain('<form method="post">');
    const confirmed = await fetch(link, { method: 'POST', redirect: 'manual' });
    expect(confirmed.headers.get('location')).toBe(`${SITE}/subscribe/welcome/`);
    await fetch(link, { method: 'POST', redirect: 'manual' }); // a second click changes nothing

    const { records } = await eventually(
      () => api.call('consent.history', { profileId: profileId! }),
      (r) => r.records.length > 0,
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      purpose: 'marketing_email',
      status: 'granted',
      source: 'form',
      proof: { form_id: ids.form, double_opt_in: true },
    });
  });

  it('can require a Cloudflare Turnstile token', async () => {
    const api = t.api(owner);
    const draft = (await api.call('artifacts.get', { artifactId: ids.form })).version.content as Record<string, unknown>;
    await api.call('artifacts.updateDraft', { artifactId: ids.form, content: { ...draft, turnstile: true } });
    await api.call('artifacts.requestPublish', { artifactId: ids.form, note: 'Turnstile on' });
    // Forms are read fresh per submission; without a valid token the post is refused.
    const res = await post(ids.form, { email: 'dan@example.com' });
    expect(res.headers.get('location')).toContain('error=challenge_failed');
    await api.call('artifacts.updateDraft', { artifactId: ids.form, content: { ...draft, turnstile: false } });
    await api.call('artifacts.requestPublish', { artifactId: ids.form, note: 'Turnstile off' });
  });
});

describe('importing subscribers from the old newsletter tool', () => {
  it('keeps their consent history and proof, and ignores a re-import', async () => {
    const api = t.api(owner);
    const rows = [
      {
        email: 'bo@example.com',
        traits: { firstName: 'Bo' },
        consent: [
          {
            purpose: 'marketing_email',
            status: 'granted' as const,
            recordedAt: '2025-03-01T10:00:00Z',
            proof: { system: 'Kit', form: 'Homepage' },
          },
        ],
      },
      { email: 'eve@example.com', consent: [{ purpose: 'telepathy', status: 'granted' as const }] },
    ];
    const r = await api.call('profiles.import', { label: 'Kit export 2026-10-22', rows });
    expect(r).toMatchObject({ accepted: 1, rejected: [{ index: 1, error: 'unknown purpose "telepathy"' }] });
    const { profileId } = await eventually(
      () => api.call('profiles.find', { type: 'email', value: 'bo@example.com' }),
      (x) => !!x.profileId,
    );
    const { records } = await eventually(
      () => api.call('consent.history', { profileId: profileId! }),
      (x) => x.records.length > 0,
    );
    expect(records[0]).toMatchObject({
      status: 'granted',
      source: 'import',
      recordedAt: '2025-03-01T10:00:00.000Z',
      proof: { system: 'Kit', import_label: 'Kit export 2026-10-22' },
    });
    await api.call('profiles.import', { label: 'Kit export again', rows: rows.slice(0, 1) });
    await new Promise((res) => setTimeout(res, 1500));
    expect((await api.call('consent.history', { profileId: profileId! })).records).toHaveLength(1);
  });
});

describe('weekly newsletter as a broadcast', () => {
  it('previews, sends once to subscribers only, and reports', async () => {
    const api = t.api(owner);
    ids.segment = (
      await api.call('artifacts.create', {
        type: 'segment',
        name: 'Newsletter subscribers',
        content: { condition: { consent: 'marketing_email' } },
      })
    ).artifactId;
    await api.call('artifacts.requestPublish', { artifactId: ids.segment, note: 'x' });
    const issue = await api.call('artifacts.create', {
      type: 'email_template',
      name: 'Signal #42',
      content: {
        purpose: 'marketing_email',
        subject: 'Signal #42: agents eat the stack',
        mjml: mjml('Hi {{ profile.firstName | default: "there" }}, this week…'),
      },
    });
    await api.call('artifacts.requestPublish', { artifactId: issue.artifactId, note: 'x' });
    ids.newsletter = (
      await api.call('artifacts.create', {
        type: 'broadcast',
        name: 'Signal #42',
        content: { template: issue.artifactId, segment: ids.segment },
      })
    ).artifactId;

    const preview = await eventually(
      () => api.call('broadcasts.preview', { artifactId: ids.newsletter }),
      (p) => p.audience === 2,
    );
    expect(preview).toMatchObject({ audience: 2, wouldSend: 2 });
    expect((await api.call('broadcasts.status', { artifactId: ids.newsletter })).run.status).toBe('not_scheduled');

    await api.call('artifacts.requestPublish', { artifactId: ids.newsletter, note: 'Friday issue' });
    const done = await eventually(
      () => api.call('broadcasts.status', { artifactId: ids.newsletter }),
      (s) => s.run.status === 'done' && (s.messages.sent ?? 0) === 2,
      15_000,
    );
    expect(done.run).toMatchObject({ recipients: 2, queued: 2, skipped: 0 });
    for (const to of ['ada@example.com', 'bo@example.com'])
      expect(mailTo(to).filter((m) => m.subject.startsWith('Signal #42'))).toHaveLength(1);
    expect(mailTo('cy@example.com').filter((m) => m.subject.startsWith('Signal #42'))).toHaveLength(0);
  });

  it('can be cancelled before it goes out', async () => {
    const api = t.api(owner);
    const { content } = (await api.call('artifacts.get', { artifactId: ids.newsletter })).version;
    const later = await api.call('artifacts.create', {
      type: 'broadcast',
      name: 'Signal #43',
      content: { ...(content as object), sendAt: new Date(Date.now() + 86_400_000).toISOString() },
    });
    await api.call('artifacts.requestPublish', { artifactId: later.artifactId, note: 'Next week' });
    await eventually(
      () => api.call('broadcasts.status', { artifactId: later.artifactId }),
      (s) => s.run.status === 'scheduled',
    );
    expect(await api.call('broadcasts.cancel', { artifactId: later.artifactId })).toMatchObject({ status: 'cancelled' });
    expect((await rejects(api.call('broadcasts.cancel', { artifactId: later.artifactId }))).message).toContain('already cancelled');
  });
});
