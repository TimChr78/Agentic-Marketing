import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rejects, startTestServer, type User } from './harness';

// Pre-send checks (#90) through the real command: rendered with sample data, findings grouped by
// severity, link reachability through the egress guard (loopback is allowed by the harness), and
// blocking findings refusing requestPublish and requestPublishBundle.

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let receiver: Server;
let links = '';
let hits: string[] = [];
let segmentId = '';
const stamp = Date.now();

const mjml = (body: string) =>
  `<mjml><mj-body><mj-section><mj-column>${body}<mj-text><a href="{{ unsubscribe_url }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>`;

async function createTemplate(name: string, body: string, extra: Record<string, unknown> = {}) {
  const r = await t.api(owner).call('artifacts.create', {
    type: 'email_template',
    name,
    content: {
      purpose: 'marketing_email',
      subject: `A calm subject for ${name}`,
      preheader: 'One line that inboxes show',
      mjml: mjml(body),
      ...extra,
    },
  });
  return r.artifactId;
}

beforeAll(async () => {
  t = await startTestServer('test_v028_checks', 3462);
  owner = await t.signUp(`owner-checks-${stamp}@example.com`);
  await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner);
  await api.call('emailProviders.create', {
    name: 'Outbox',
    adapter: 'log',
    fromEmail: 'news@example.com',
    useFor: ['transactional', 'marketing'],
  });
  const segment = await api.call('artifacts.create', {
    type: 'segment',
    name: 'Subscribers',
    content: { condition: { consent: 'marketing_email' } },
  });
  segmentId = segment.artifactId;
  await api.call('artifacts.requestPublish', { artifactId: segmentId, note: 'audience' });

  receiver = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url === '/missing') return res.writeHead(404).end();
    if (req.url === '/forbidden') return res.writeHead(403).end();
    res.writeHead(200).end('ok');
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  links = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => receiver?.close(resolve));
  await t?.close();
});

describe('templates.check', () => {
  it('reports compliance, images, rendering and subject findings on the rendered e-mail', async () => {
    const artifactId = await createTemplate(
      'Issue with problems',
      '<mj-text>Hi {{ profile.firstName }}!</mj-text><mj-image src="https://example.com/hero.png" />',
      {
        subject: 'URGENT NEWS ALERT: Act now for FREE MONEY!!! Our very long subject line keeps going well past seventy characters',
        preheader: undefined,
      },
    );
    const r = await t.api(owner).call('templates.check', { artifactId });
    expect(r.version).toBe(1);
    expect(r.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.summary.blocking + r.summary.warning + r.summary.info).toBe(r.findings.length);
    const categories = new Set(r.findings.map((f) => f.category));
    expect([...categories].sort()).toEqual(['images', 'personalisation', 'rendering', 'subject']);
    expect(r.findings).toContainEqual(
      expect.objectContaining({ category: 'images', severity: 'warning', message: expect.stringContaining('alt text') }),
    );
    expect(r.findings).toContainEqual(
      expect.objectContaining({ category: 'personalisation', message: expect.stringContaining('profile.firstName') }),
    );
    expect(r.findings).toContainEqual(expect.objectContaining({ category: 'rendering', message: expect.stringContaining('preheader') }));
    expect(r.findings).toContainEqual(expect.objectContaining({ category: 'subject', message: expect.stringContaining('act now') }));
  });

  it('flags a marketing e-mail without an unsubscribe link as blocking, and notes a purpose for another channel', async () => {
    const api = t.api(owner);
    const created = await api.call('artifacts.create', {
      type: 'email_template',
      name: 'No unsubscribe',
      content: {
        purpose: 'onboarding',
        subject: 'Hello',
        mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section></mj-body></mjml>',
      },
    });
    // Saving already refuses this combination, so reach it the way a legacy version could: change
    // the stored purpose to a marketing one that is meant for another channel.
    await t.srv.db.admin.query(
      `UPDATE artifact_versions SET content = jsonb_set(content, '{purpose}', '"marketing_sms"') WHERE artifact_id = $1`,
      [created.artifactId],
    );
    const r = await api.call('templates.check', { artifactId: created.artifactId });
    expect(r.findings).toContainEqual(
      expect.objectContaining({ category: 'compliance', severity: 'blocking', message: expect.stringContaining('unsubscribe') }),
    );
    expect(r.findings).toContainEqual(
      expect.objectContaining({
        category: 'compliance',
        severity: 'info',
        message: expect.stringContaining('not marked for the e-mail channel'),
      }),
    );
  });

  it('checks links only when asked, through the egress guard, and caches each URL', async () => {
    const artifactId = await createTemplate(
      'Links',
      `<mj-text><a href="${links}/ok">Fine</a> <a href="${links}/missing">Missing</a> <a href="${links}/forbidden">Private</a> <a href="http://10.0.0.1/internal">Internal</a></mj-text>`,
    );
    hits = [];
    const quick = await t.api(owner).call('templates.check', { artifactId });
    expect(quick.findings.filter((f) => f.category === 'links')).toEqual([]);
    expect(hits).toEqual([]);

    const full = await t.api(owner).call('templates.check', { artifactId, checkLinks: true });
    expect(full.findings).toContainEqual(expect.objectContaining({ severity: 'warning', message: expect.stringContaining('HTTP 404') }));
    expect(full.findings).toContainEqual(expect.objectContaining({ severity: 'info', message: expect.stringContaining('HTTP 403') }));
    // A private address is refused before a socket opens, and reported instead of fetched.
    expect(full.findings).toContainEqual(
      expect.objectContaining({ severity: 'warning', message: expect.stringMatching(/private address|not a valid URL/) }),
    );
    const fetched = hits.length;

    const again = await t.api(owner).call('templates.check', { artifactId, checkLinks: true });
    expect(again.findings.map((f) => f.id).sort()).toEqual(full.findings.map((f) => f.id).sort());
    expect(hits.length).toBe(fetched);
  });

  it('never fetches a personalised link', async () => {
    const artifactId = await createTemplate('Personal', `<mj-text><a href="${links}/u/{{ profile.id }}">Your account</a></mj-text>`, {
      sampleData: { profile: { id: 'prf_1234567890' } },
    });
    hits = [];
    const r = await t.api(owner).call('templates.check', { artifactId, checkLinks: true });
    expect(hits.filter((h) => h.includes('prf_'))).toEqual([]);
    expect(r.findings.filter((f) => f.category === 'links' && f.severity !== 'info')).toEqual([]);
  });

  it('refuses a template that points at an asset which no longer exists, and allows a real one', async () => {
    const api = t.api(owner);
    const gone = await createTemplate(
      'Missing asset',
      '<mj-image src="https://links.example/a/ast_00000000000000000000000000000000/hero.png" alt="Hero" />',
    );
    const refused = await rejects(api.call('artifacts.requestPublish', { artifactId: gone, note: 'ship it' }));
    expect(refused.message).toMatch(/does not exist/);

    // 1×1 transparent PNG: a real asset in this workspace is fine.
    const asset = await api.call('assets.upload', {
      fileName: 'dot.png',
      contentType: 'image/png',
      dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      altText: 'A single pixel',
    });
    const withAsset = await createTemplate('Real asset', `<mj-image src="${asset.url}" alt="A single pixel" />`);
    const r = await api.call('templates.check', { artifactId: withAsset });
    expect(r.findings.filter((f) => f.category === 'images')).toEqual([]);
    expect((await api.call('artifacts.requestPublish', { artifactId: withAsset, note: 'fine' })).status).toBe('published');
  });

  it('refuses to publish a blocking finding, alone and in a bundle; warnings do not block', async () => {
    const api = t.api(owner);
    const unsafe = await createTemplate('Unsafe', '<mj-text><a href="javascript:alert(1)">Open</a></mj-text>');
    const refused = await rejects(api.call('artifacts.requestPublish', { artifactId: unsafe, note: 'ship it' }));
    expect(refused.message).toMatch(/cannot be published yet/);
    expect(refused.message).toMatch(/javascript:/);

    const broadcast = await api.call('artifacts.create', {
      type: 'broadcast',
      name: 'Send the unsafe issue',
      content: { template: unsafe, segment: segmentId },
    });
    const bundled = await rejects(
      api.call('artifacts.requestPublishBundle', { artifactIds: [broadcast.artifactId, unsafe], note: 'weekly' }),
    );
    expect(bundled.message).toMatch(/javascript:/);

    // An image without alt text and no preheader are warnings/notes: publish still works.
    const warnOnly = await createTemplate('Warn only', '<mj-image src="https://example.com/hero.png" />', { preheader: undefined });
    const published = await api.call('artifacts.requestPublish', { artifactId: warnOnly, note: 'fine to send' });
    expect(published.status).toBe('published');
  });
});
