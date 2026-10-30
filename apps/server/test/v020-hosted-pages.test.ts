import { outbox } from '@agentic-marketing/email';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, rejects, startTestServer, testPort, type User } from './harness';

// Branded hosted pages (#37): the double opt-in confirm and expired pages and the unsubscribe
// pages follow the workspace's published brand, each form may override parts of it, and the
// preview command renders the same document with its buttons disabled.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
const SITE = 'https://form.example.com';
const ids = { brand: '', template: '', form: '', marketing: '' };

const api = () => t.api(owner);
const publish = async (artifactId: string) => api().call('artifacts.requestPublish', { artifactId, note: 'test' });
const mailTo = (to: string) => outbox.filter((m) => m.to === to);
const linkFrom = (html: string, pattern: RegExp) => html.match(pattern)![1].replace(/&amp;/g, '&');

const brandContent = () => ({
  siteName: 'Martech Signal',
  siteUrl: 'https://martechsignal.com',
  logoUrl: 'https://cdn.martechsignal.com/logo.png',
  logoAlt: 'Martech Signal logo',
  logoHeight: 40,
  colors: {
    background: '#faf7f2',
    surface: '#ffffff',
    text: '#1a1a1a',
    muted: '#4a4a4a',
    accent: '#1d4ed8',
    accentText: '#ffffff',
    border: '#e5e0d8',
  },
  fontStack: 'Georgia, serif',
  radius: 12,
  language: 'da',
  copy: {
    confirmTitle: 'Bekræft din tilmelding',
    confirmBody: 'Ét klik, og du er med.',
    confirmButton: 'Ja, tilmeld mig',
    confirmedTitle: 'Du er tilmeldt',
    expiredTitle: 'Linket er udløbet',
    expiredBody: 'Tilmeld dig igen, så sender vi et nyt link.',
    unsubscribeTitle: 'Afmeld',
    unsubscribeBody: 'Du modtager ikke flere e-mails.',
    unsubscribeButton: 'Afmeld',
    unsubscribedTitle: 'Afmeldt',
    unsubscribedBody: 'Du er afmeldt.',
    backToSite: 'Tilbage til {site}',
  },
});

beforeAll(async () => {
  t = await startTestServer('test_pages02', testPort(3404));
  owner = await t.signUp(`pages-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  await api().call('emailProviders.create', {
    name: 'Relay',
    adapter: 'log',
    fromEmail: 'signal@martechsignal.com',
    useFor: ['transactional', 'marketing'],
  });
  ids.brand = (await api().call('artifacts.create', { type: 'brand', name: 'MartechSignal brand', content: brandContent() })).artifactId;
  await publish(ids.brand);
  ids.template = (
    await api().call('artifacts.create', {
      type: 'email_template',
      name: 'Confirm subscription',
      content: {
        purpose: 'onboarding',
        subject: 'Confirm your subscription',
        mjml: '<mjml><mj-body><mj-section><mj-column><mj-text><a href="{{ confirm_url | raw }}">Confirm</a></mj-text></mj-column></mj-section></mj-body></mjml>',
      },
    })
  ).artifactId;
  await publish(ids.template);
  ids.form = (
    await api().call('artifacts.create', {
      type: 'form',
      name: 'Newsletter',
      content: {
        purposes: ['marketing_email'],
        doubleOptIn: true,
        confirmationTemplate: ids.template,
        consentText: 'Send me the newsletter.',
        successUrl: `${SITE}/thanks`,
        confirmedUrl: `${SITE}/welcome`,
        allowedOrigins: [SITE],
        hostedPages: { colors: { accent: '#0f766e' }, copy: { confirmTitle: 'Formens egen titel' } },
      },
    })
  ).artifactId;
  await publish(ids.form);
}, 60_000);

afterAll(() => t?.close());

describe('the double opt-in confirm page', () => {
  it('uses the published brand, lets the form override it, and still confirms only on POST', async () => {
    const post = await fetch(`${t.base}/f/${ids.form}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: SITE },
      body: new URLSearchParams({ email: 'ada@example.com' }).toString(),
      redirect: 'manual',
    });
    expect(post.status).toBe(303);
    const mail = await eventually(
      async () => mailTo('ada@example.com'),
      (m) => m.length === 1,
    );
    let link = linkFrom(mail[0].html, /href="([^"]*\/(?:c|f\/confirm)\/[^"]+)"/);
    if (link.includes('/c/')) link = (await fetch(link, { redirect: 'manual' })).headers.get('location')!;
    expect(link).toContain('/f/confirm/');

    const res = await fetch(link);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    // The POST redirects to the site's welcome page; form-action covers that redirect (#115).
    expect(res.headers.get('content-security-policy')).toContain(`form-action 'self' ${SITE};`);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('<html lang="da">');
    expect(html).toContain('Martech Signal');
    expect(html).toContain('src="https://cdn.martechsignal.com/logo.png"');
    expect(html).toContain('alt="Martech Signal logo"');
    expect(html).toContain('height="40"');
    expect(html).not.toContain('class="site-name"'); // the logo replaces the name line (#113)
    expect(html).toContain('--background:#faf7f2');
    expect(html).toContain('--accent:#0f766e'); // the form's override wins
    expect(html).toContain('Formens egen titel');
    expect(html).not.toContain('Bekræft din tilmelding');
    expect(html).toContain('Ét klik, og du er med.');
    expect(html).toContain('Ja, tilmeld mig');
    expect(html).toContain('<form method="post">');

    // A mail scanner opening the link must not confirm on the person's behalf.
    const { profileId } = await eventually(
      () => api().call('profiles.find', { type: 'email', value: 'ada@example.com' }),
      (p) => !!p.profileId,
    );
    expect((await api().call('consent.history', { profileId: profileId! })).records).toHaveLength(0);

    const confirmed = await fetch(link, { method: 'POST', redirect: 'manual' });
    expect(confirmed.status).toBe(303);
    expect(confirmed.headers.get('location')).toBe(`${SITE}/welcome`);
    const { records } = await eventually(
      () => api().call('consent.history', { profileId: profileId! }),
      (r) => r.records.length > 0,
    );
    expect(records[0]).toMatchObject({ purpose: 'marketing_email', status: 'granted', source: 'form' });
    expect((await fetch(link, { method: 'POST', redirect: 'manual' })).status).toBe(303);
  }, 30_000);

  it('shows the branded confirmed page in place when the form has no confirmedUrl (#115)', async () => {
    const form = (
      await api().call('artifacts.create', {
        type: 'form',
        name: 'No thank-you page',
        content: {
          purposes: ['marketing_email'],
          doubleOptIn: true,
          confirmationTemplate: ids.template,
          consentText: 'Send me the newsletter.',
          successUrl: `${SITE}/thanks`,
          allowedOrigins: [SITE],
        },
      })
    ).artifactId;
    await publish(form);
    const post = await fetch(`${t.base}/f/${form}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: SITE },
      body: new URLSearchParams({ email: 'bea@example.com' }).toString(),
      redirect: 'manual',
    });
    expect(post.status).toBe(303);
    const mail = await eventually(
      async () => mailTo('bea@example.com'),
      (m) => m.length === 1,
    );
    let link = linkFrom(mail[0].html, /href="([^"]*\/(?:c|f\/confirm)\/[^"]+)"/);
    if (link.includes('/c/')) link = (await fetch(link, { redirect: 'manual' })).headers.get('location')!;

    const page = await fetch(link);
    expect(page.status).toBe(200);
    // Nothing to redirect to, so the page allows posting to itself only.
    expect(page.headers.get('content-security-policy')).toContain("form-action 'self';");

    const confirmed = await fetch(link, { method: 'POST', redirect: 'manual' });
    expect(confirmed.status).toBe(200);
    expect(confirmed.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await confirmed.text();
    expect(html).toContain('Du er tilmeldt'); // the brand's confirmedTitle
    expect(html).not.toContain('<form');
    const { profileId } = await api().call('profiles.find', { type: 'email', value: 'bea@example.com' });
    const { records } = await eventually(
      () => api().call('consent.history', { profileId: profileId! }),
      (r) => r.records.length > 0,
    );
    expect(records[0]).toMatchObject({ purpose: 'marketing_email', status: 'granted', source: 'form' });

    // The same link confirms once; a second click shows the same page and records nothing new.
    expect((await fetch(link, { method: 'POST', redirect: 'manual' })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 500));
    expect((await api().call('consent.history', { profileId: profileId! })).records).toHaveLength(1);
  }, 30_000);

  it('does not use a draft brand until it is published', async () => {
    const mail = await eventually(
      async () => mailTo('ada@example.com'),
      (m) => m.length === 1,
    );
    let link = linkFrom(mail[0].html, /href="([^"]*\/(?:c|f\/confirm)\/[^"]+)"/);
    if (link.includes('/c/')) link = (await fetch(link, { redirect: 'manual' })).headers.get('location')!;

    const content = (await api().call('artifacts.get', { artifactId: ids.brand })).version.content as Record<string, unknown>;
    await api().call('artifacts.updateDraft', {
      artifactId: ids.brand,
      content: { ...content, siteName: 'Draft Signal', logoAlt: 'Draft Signal logo' },
    });
    expect(await (await fetch(link)).text()).toContain('Martech Signal');
    expect(await (await fetch(link)).text()).not.toContain('Draft Signal');

    await publish(ids.brand);
    expect(await (await fetch(link)).text()).toContain('Draft Signal');
  });

  it('renders the expired page with a way back to the brand site, or the form origin', async () => {
    const expired = t.srv.email.links.sign({
      k: 'doi',
      w: ws,
      f: ids.form,
      v: 1,
      a: 'anon',
      s: new Date().toISOString(),
      x: Date.now() - 1000,
    });
    const branded = await fetch(`${t.base}/f/confirm/${expired}`);
    expect(branded.status).toBe(410);
    const html = await branded.text();
    expect(html).toContain('Linket er udløbet');
    expect(html).toContain('href="https://martechsignal.com"');
    expect(html).toContain('Tilbage til Draft Signal');

    // Without a site URL on the brand, the form's first allowed origin is the way back.
    const content = (await api().call('artifacts.get', { artifactId: ids.brand })).version.content as Record<string, unknown>;
    const { siteUrl: _omitted, ...withoutSite } = content;
    await api().call('artifacts.updateDraft', { artifactId: ids.brand, content: withoutSite });
    await publish(ids.brand);
    const fallback = await fetch(`${t.base}/f/confirm/${expired}`);
    expect(fallback.status).toBe(410);
    const fallbackHtml = await fallback.text();
    expect(fallbackHtml).toContain(`href="${SITE}"`);
    expect(fallbackHtml).toContain('Tilbage til Draft Signal');
    expect((await fetch(`${t.base}/f/confirm/not-a-token`)).status).toBe(410);

    // Put the site URL back for the unsubscribe pages, which have no form to fall back to.
    await api().call('artifacts.updateDraft', { artifactId: ids.brand, content });
    await publish(ids.brand);
  });
});

describe('the unsubscribe page', () => {
  it('uses the brand, never unsubscribes on GET, and keeps the RFC 8058 one-click POST', async () => {
    await api().call('profiles.import', {
      label: 'Hosted pages test',
      rows: [
        {
          email: 'bo@example.com',
          consent: [{ purpose: 'marketing_email', status: 'granted', recordedAt: '2025-01-01T00:00:00Z' }],
        },
      ],
    });
    const { profileId } = await eventually(
      () => api().call('profiles.find', { type: 'email', value: 'bo@example.com' }),
      (p) => !!p.profileId,
    );
    ids.marketing = (
      await api().call('artifacts.create', {
        type: 'email_template',
        name: 'Newsletter',
        content: {
          purpose: 'marketing_email',
          subject: 'News',
          mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>News</mj-text><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>',
        },
      })
    ).artifactId;
    await publish(ids.marketing);
    await api().call('messages.sendEmail', { profileId: profileId!, templateId: ids.marketing });
    const mail = await eventually(
      async () => mailTo('bo@example.com'),
      (m) => m.length === 1,
    );
    const link = linkFrom(mail[0].html, new RegExp(`(${t.base}/u/[A-Za-z0-9_.-]+)`));

    const page = await fetch(link);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Draft Signal');
    expect(html).toContain('--accent:#1d4ed8');
    expect(html).toContain('Afmeld');
    expect(page.headers.get('content-security-policy')).toContain("form-action 'self';");
    expect(html).toContain('Tilbage til Draft Signal');
    expect(html).toContain('href="https://martechsignal.com"');
    expect(html).toContain('<form method="post">');
    const before = (await api().call('consent.history', { profileId: profileId! })).records.length;
    expect(before).toBe(1);

    const oneClick = await fetch(link, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(oneClick.status).toBe(200);
    const done = await oneClick.text();
    expect(done).toContain('Afmeldt');
    expect(done).toContain('Du er afmeldt.');
    const history = await eventually(
      () => api().call('consent.history', { profileId: profileId! }),
      (r) => r.records.length > 1,
    );
    expect(history.records.at(-1)).toMatchObject({ purpose: 'marketing_email', status: 'withdrawn', source: 'unsubscribe' });
    expect((await fetch(`${t.base}/u/not-a-token`)).status).toBe(404);
  }, 30_000);
});

describe('hostedPages.preview', () => {
  it('renders every page with the brand and a disabled button', async () => {
    for (const page of ['confirm', 'confirmed', 'expired', 'unsubscribe', 'unsubscribed'] as const) {
      const { html } = await api().call('hostedPages.preview', {
        page,
        brand: { siteName: 'Preview Co', siteUrl: 'https://preview.example', colors: { accent: '#123456' }, language: 'fr' },
      });
      expect(html).toContain('<!doctype html>');
      expect(html).toContain('<html lang="fr">');
      expect(html).toContain('Preview Co');
      expect(html).toContain('--accent:#123456');
      if (page === 'confirm' || page === 'unsubscribe') expect(html).toContain('disabled aria-disabled="true"');
      else expect(html).not.toContain('<button');
    }
  });

  it('applies a form override and its origin, and escapes everything', async () => {
    const withForm = await api().call('hostedPages.preview', {
      page: 'confirm',
      formId: ids.form,
      brand: { siteName: 'No site', copy: { confirmTitle: 'Preview title' } },
    });
    expect(withForm.html).toContain('No site');
    expect(withForm.html).toContain('Formens egen titel');
    expect(withForm.html).toContain('--accent:#0f766e');

    const expired = await api().call('hostedPages.preview', {
      page: 'expired',
      formId: ids.form,
      brand: { siteName: 'No site' },
    });
    expect(expired.html).toContain(`href="${SITE}"`);

    const escaped = await api().call('hostedPages.preview', {
      page: 'confirm',
      brand: {
        siteName: '<script>alert(1)</script>',
        copy: { confirmTitle: '<b>Hi</b>', confirmBody: 'Click {site} now' },
      },
    });
    expect(escaped.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escaped.html).not.toContain('<script>');
    expect(escaped.html).toContain('&lt;b&gt;Hi&lt;/b&gt;');
    expect(escaped.html).toContain('Click &lt;script&gt;alert(1)&lt;/script&gt; now');
  });

  it('rejects an invalid colour and font stack with field-level errors', async () => {
    const content = (await api().call('artifacts.get', { artifactId: ids.brand })).version.content as Record<string, unknown>;
    const badColor = await rejects(
      api().call('artifacts.updateDraft', {
        artifactId: ids.brand,
        content: { ...content, colors: { ...(content.colors as object), accent: '#12345' } },
      }),
    );
    expect(badColor.message).toContain('colors.accent');
    const badFont = await rejects(
      api().call('artifacts.updateDraft', {
        artifactId: ids.brand,
        content: { ...content, fontStack: 'Arial; } body { display: none }' },
      }),
    );
    expect(badFont.message).toContain('fontStack');
    const badUrl = await rejects(
      api().call('artifacts.updateDraft', {
        artifactId: ids.brand,
        content: { ...content, siteUrl: 'http://example.com' },
      }),
    );
    expect(badUrl.message).toContain('siteUrl');

    const form = (await api().call('artifacts.get', { artifactId: ids.form })).version.content as Record<string, unknown>;
    const badOverride = await rejects(
      api().call('artifacts.updateDraft', {
        artifactId: ids.form,
        content: { ...form, hostedPages: { colors: { accent: 'red' } } },
      }),
    );
    expect(badOverride.message).toContain('hostedPages.colors.accent');
  });
});
