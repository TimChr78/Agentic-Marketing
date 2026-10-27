import http from 'node:http';
import { outbox } from '@agentic-marketing/email';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, rejects, startTestServer, type User } from './harness';

// #100: a public newsletter archive on the links host, and a signed "view in browser" page per
// message. The archive is rendered from the template version that was sent with empty
// personalisation; the web version is the only place a recipient's own data appears.

const MAIN_PORT = 3418;
const PUBLIC_PORT = 3419;
const SLUG = 'signal-archive';
const SITE = 'https://martechsignal.example';

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let templateId = '';
let segmentId = '';
let sentBroadcast = '';
let issueSlug = '';
let issueUrl = '';
let webPath = '';
let messageId = '';

const api = (workspaceId?: string) => t.api(owner, workspaceId);
const publish = (artifactId: string) => api().call('artifacts.requestPublish', { artifactId, note: 'v028 archive test' });

const raw = (port: number, path: string, method = 'GET') =>
  new Promise<number>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { connection: 'close' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });

const mjml = `<mjml><mj-body><mj-section><mj-column>
  <mj-image src="https://example.invalid/pixel.gif" width="1px" height="1px" alt="" />
  <mj-text>Hi {{ profile.firstName | default: 'there' }},</mj-text>
  <mj-text>This week: attribution &amp; the inbox.</mj-text>
  <mj-text><a href="{{ web_url | raw }}">View in browser</a></mj-text>
  <mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text>
</mj-column></mj-section></mj-body></mjml>`;

const brandContent = (archive: Record<string, unknown>) => ({
  siteName: 'Martech Signal',
  siteUrl: SITE,
  language: 'en',
  archive,
});

/** Publishes a broadcast, then records a completed run without sending (sendAt is in the future). */
async function finishRun(broadcastId: string) {
  const { publishedVersion } = await api().call('artifacts.get', { artifactId: broadcastId });
  await t.srv.db.admin.query(
    `INSERT INTO broadcast_runs (workspace_id, broadcast_id, version, status, send_at, started_at, finished_at)
     VALUES ($1, $2, $3, 'done', now(), now(), now())
     ON CONFLICT (workspace_id, broadcast_id)
     DO UPDATE SET status = 'done', started_at = now(), finished_at = now()`,
    [ws, broadcastId, publishedVersion],
  );
}

beforeAll(async () => {
  t = await startTestServer('test_archive_v028', MAIN_PORT, {
    PUBLIC_PORT: String(PUBLIC_PORT),
    PUBLIC_URL: `http://localhost:${MAIN_PORT}`,
    PUBLIC_LINKS_URL: `http://localhost:${MAIN_PORT}`,
  });
  owner = await t.signUp(`archive-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']], 'none');
  await api().call('emailProviders.create', {
    name: 'Outbox',
    adapter: 'log',
    fromEmail: 'news@martechsignal.example',
    useFor: ['transactional', 'marketing'],
  });

  const brand = (
    await api().call('artifacts.create', {
      type: 'brand',
      name: 'Brand',
      content: brandContent({
        enabled: true,
        title: 'The Signal archive',
        description: 'Every issue of the Signal, on the web.',
        slug: SLUG,
        subscribeUrl: `${SITE}/#signup`,
      }),
    })
  ).artifactId;
  await publish(brand);

  templateId = (
    await api().call('artifacts.create', {
      type: 'email_template',
      name: 'Signal #42',
      content: {
        purpose: 'marketing_email',
        subject: 'Signal #42: attribution & the inbox',
        preheader: 'Plus three tools worth a look',
        mjml,
        sampleData: { profile: { firstName: 'Sample' } },
      },
    })
  ).artifactId;
  await publish(templateId);

  segmentId = (
    await api().call('artifacts.create', {
      type: 'segment',
      name: 'Subscribers',
      content: { description: 'Everyone who allows the newsletter.', condition: { consent: 'marketing_email' } },
    })
  ).artifactId;
  await publish(segmentId);

  const broadcast = async (name: string, archive: Record<string, unknown>) =>
    (
      await api().call('artifacts.create', {
        type: 'broadcast',
        name,
        content: {
          template: templateId,
          segment: segmentId,
          sendAt: new Date(Date.now() + 86_400_000).toISOString(),
          archive,
        },
      })
    ).artifactId;

  sentBroadcast = await broadcast('Signal #42', { publish: true, summary: 'A summary & more' });
  await publish(sentBroadcast);
  await finishRun(sentBroadcast);

  // Published but not marked for the archive: must never appear.
  const unpublished = await broadcast('Never archived', { publish: false });
  await publish(unpublished);
  await finishRun(unpublished);

  // Marked for the archive but never sent: must not appear either.
  await broadcast('Not sent yet', { publish: true });
}, 90_000);

afterAll(() => t?.close());

describe('the web version of one message', () => {
  it('renders that recipient’s e-mail without tracking and with a working unsubscribe link', async () => {
    await api().call('profiles.import', {
      label: 'Archive readers',
      rows: [
        {
          email: 'ada@example.com',
          traits: { firstName: 'Ada' },
          consent: [{ purpose: 'marketing_email', status: 'granted', recordedAt: '2025-01-01T00:00:00Z' }],
        },
      ],
    });
    const { profileId } = await eventually(
      () => api().call('profiles.find', { type: 'email', value: 'ada@example.com' }),
      (p) => !!p.profileId,
    );
    const sent = await api().call('messages.sendEmail', { profileId: profileId!, templateId });
    messageId = sent.messageId;
    const mail = await eventually(
      async () => outbox.filter((m) => m.messageId === messageId),
      (m) => m.length === 1,
    );
    const web = mail[0].html.match(new RegExp(`(http://localhost:${MAIN_PORT}/n/w/[^"']+)`))?.[1];
    expect(web).toBeTruthy();
    webPath = new URL(web!.replace(/&amp;/g, '&')).pathname;

    const page = await fetch(`${t.base}${webPath}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('private, no-store');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await page.text();
    expect(html).toContain('Hi Ada');
    expect(html).toContain('View in browser');
    expect(html).not.toContain('/c/');
    expect(html).not.toContain('pixel.gif');
    expect(html).not.toContain('width="1"');
    const unsubscribe = html.match(new RegExp(`(http://localhost:${MAIN_PORT}/u/[^"']+)`))?.[1];
    expect(unsubscribe).toBeTruthy();
    expect((await fetch(unsubscribe!.replace(/&amp;/g, '&'))).status).toBe(200);
  }, 30_000);

  it('rejects a tampered token with 404 and an expired token with 410', async () => {
    expect((await fetch(`${t.base}${webPath}x`)).status).toBe(404);
    const expired = t.srv.email.links.sign({ w: ws, m: messageId, x: Date.now() - 1000 });
    expect((await fetch(`${t.base}/n/w/${expired}`)).status).toBe(410);
    expect((await fetch(`${t.base}/n/w/not-a-token`)).status).toBe(404);
  });
});

describe('the public archive', () => {
  it('lists only sent, published issues with their date and summary', async () => {
    const { settings, issues } = await api().call('archive.issues', {});
    expect(settings).toMatchObject({ enabled: true, slug: SLUG, indexUrl: `${t.base}/n/${SLUG}/` });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      artifactId: sentBroadcast,
      subject: 'Signal #42: attribution & the inbox',
      summary: 'A summary & more',
    });
    issueSlug = issues[0].slug;
    issueUrl = issues[0].url;
    expect(issueSlug).toMatch(/^signal-42-attribution-the-inbox-\d{4}-\d{2}-\d{2}$/);

    const index = await fetch(`${t.base}/n/${SLUG}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('cache-control')).toContain('max-age=300');
    const html = await index.text();
    expect(html).toContain('The Signal archive');
    expect(html).toContain('Signal #42: attribution &amp; the inbox');
    expect(html).toContain('A summary &amp; more');
    expect(html).toContain(`${SITE}/#signup`);
    expect(html).not.toContain('Never archived');
    expect(html).not.toContain('Not sent yet');
  });

  it('renders the issue without personal data or unsubscribe links and with SEO meta', async () => {
    const page = await fetch(issueUrl);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Hi there'); // empty profile, template default
    expect(html).not.toContain('Hi Ada');
    expect(html).not.toContain('Hi Sample');
    expect(html).not.toContain('/u/');
    expect(html).toContain('href="#"');
    expect(html).toContain(`<link rel="canonical" href="${issueUrl}">`);
    expect(html).toContain('<meta property="og:type" content="article">');
    expect(html).toContain('<meta name="twitter:card" content="summary">');
    expect(html).toContain('<meta name="robots" content="index,follow">');
    expect(html).toContain('"@type":"Article"');
    expect(html).toContain('"headline":"Signal #42: attribution & the inbox"');
  });

  it('serves RSS 2.0 and a sitemap that escape and link the issues', async () => {
    const feed = await fetch(`${t.base}/n/${SLUG}/feed.xml`);
    expect(feed.status).toBe(200);
    expect(feed.headers.get('content-type')).toContain('application/rss+xml');
    const xml = await feed.text();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<rss version="2.0">');
    expect(xml).toContain('</rss>');
    expect(xml).toContain('<title>Signal #42: attribution &amp; the inbox</title>');
    expect(xml).toContain(`<link>${issueUrl}</link>`);
    expect(xml).toContain('<guid isPermaLink="true">');
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;|#)/);

    const sitemap = await fetch(`${t.base}/n/${SLUG}/sitemap.xml`);
    expect(sitemap.status).toBe(200);
    const map = await sitemap.text();
    expect(map).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(map).toContain(`<loc>${t.base}/n/${SLUG}/</loc>`);
    expect(map).toContain(`<loc>${issueUrl}</loc>`);
  });

  it('is served by the public-only listener and still rejects dot-segments there', async () => {
    expect((await fetch(`${t.publicBase}/n/${SLUG}/`)).status).toBe(200);
    expect((await fetch(`${t.publicBase}${webPath}`)).status).toBe(200);
    expect([400, 404]).toContain(await raw(PUBLIC_PORT, `/n/../v1/workspace.get`, 'POST'));
    expect(await raw(PUBLIC_PORT, `/n/%2e%2e/v1/workspace.get`, 'POST')).toBe(400);
    expect(await raw(PUBLIC_PORT, '/v1/workspace.get', 'POST')).toBe(404);
  });

  it('removes an issue when a later published version unpublishes it', async () => {
    const live = (await api().call('artifacts.get', { artifactId: sentBroadcast })).version.content as Record<string, unknown>;
    await api().call('artifacts.updateDraft', {
      artifactId: sentBroadcast,
      content: { ...live, archive: { publish: false } },
    });
    await publish(sentBroadcast);
    expect((await api().call('archive.issues', {})).issues).toHaveLength(0);
    expect((await fetch(`${t.base}/n/${SLUG}/`)).text()).not.toContain('Signal #42');
    expect((await fetch(issueUrl)).status).toBe(404);
  });

  it('rejects an archive slug already used by another workspace', async () => {
    const other = await t.workspaceWith([[owner, 'owner']], 'none');
    const brand = await api(other).call('artifacts.create', {
      type: 'brand',
      name: 'Other brand',
      content: brandContent({ enabled: true, slug: SLUG }),
    });
    const error = await rejects(api(other).call('artifacts.requestPublish', { artifactId: brand.artifactId, note: 'clash' }));
    expect(error.message).toMatch(/already used by another workspace/);
  });

  it('returns 404 for an unknown slug, issue or disabled archive', async () => {
    expect((await fetch(`${t.base}/n/no-such-archive/`)).status).toBe(404);
    expect((await fetch(`${t.base}/n/${SLUG}/no-such-issue`)).status).toBe(404);

    const brand = (await api().call('artifacts.list', { type: 'brand', limit: 1 })).artifacts[0];
    const content = (await api().call('artifacts.get', { artifactId: brand.id })).version.content as Record<string, unknown>;
    await api().call('artifacts.updateDraft', {
      artifactId: brand.id,
      content: { ...content, archive: { ...(content.archive as object), enabled: false } },
    });
    await publish(brand.id);
    expect((await fetch(`${t.base}/n/${SLUG}/`)).status).toBe(404);
    expect((await fetch(`${t.base}/n/${SLUG}/feed.xml`)).status).toBe(404);
  });
});
