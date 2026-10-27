import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { EmailTemplate } from '@agentic-marketing/artifacts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AssetInfo, checkEmailTemplate, clearLinkCache, type EmailCheckOptions, scanHtml } from '../src/checks';

// Pre-send checks (#90) against real rendered MJML: each category has a fixture template, and link
// reachability talks to a local server so 200/404/403 are deterministic and nothing leaves the box.

const base = { purpose: 'marketing_email' };

const mjml = (body: string, head = '') =>
  `<mjml><mj-head>${head}</mj-head><mj-body><mj-section><mj-column>${body}</mj-column></mj-section></mj-body></mjml>`;

const unsubscribe = '<mj-text><a href="{{ unsubscribe_url }}">Unsubscribe</a></mj-text>';

function template(overrides: Partial<EmailTemplate> = {}): EmailTemplate {
  return {
    ...base,
    subject: 'A calm subject',
    preheader: 'A short preview line',
    mjml: mjml(`<mj-text>Hi {{ profile.firstName | default: 'there' }}</mj-text>${unsubscribe}`),
    ...overrides,
  } as EmailTemplate;
}

const opts = (more: Partial<EmailCheckOptions> = {}): EmailCheckOptions => ({ marketing: true, ...more });

const withLink = (href: string, text = 'Read the issue') => mjml(`<mj-text><a href="${href}">${text}</a></mj-text>${unsubscribe}`);

describe('email pre-send checks', () => {
  it('reports a marketing e-mail without an unsubscribe link as blocking', async () => {
    const r = await checkEmailTemplate(template({ mjml: mjml('<mj-text>Hi</mj-text>') }), opts());
    expect(r.findings).toEqual([expect.objectContaining({ category: 'compliance', severity: 'blocking' })]);
    expect(r.summary).toEqual({ blocking: 1, warning: 0, info: 0 });

    const ok = await checkEmailTemplate(template(), opts());
    expect(ok.findings.filter((f) => f.category === 'compliance')).toEqual([]);
  });

  it('does not require an unsubscribe link on transactional mail', async () => {
    const r = await checkEmailTemplate(
      template({ purpose: 'onboarding', mjml: mjml('<mj-text>Hi</mj-text>') }),
      opts({ marketing: false }),
    );
    expect(r.summary.blocking).toBe(0);
  });

  it('notes a purpose that is not marked for e-mail', async () => {
    const r = await checkEmailTemplate(template(), opts({ purposeChannels: ['sms'] }));
    expect(r.findings).toContainEqual(
      expect.objectContaining({
        category: 'compliance',
        severity: 'info',
        message: expect.stringContaining('not marked for the e-mail channel'),
      }),
    );
  });

  it('flags unsafe schemes as blocking, malformed URLs, shorteners and links without text as warnings', async () => {
    const r = await checkEmailTemplate(
      template({
        mjml: mjml(
          `<mj-text><a href="javascript:alert(1)">Open</a></mj-text>
           <mj-text><a href="https://exa mple.com/x">Broken</a></mj-text>
           <mj-text><a href="https://bit.ly/abc">Short</a></mj-text>
           <mj-text><a href="https://example.com/empty"></a></mj-text>${unsubscribe}`,
        ),
      }),
      opts(),
    );
    const links = r.findings.filter((f) => f.category === 'links');
    expect(links).toContainEqual(expect.objectContaining({ severity: 'blocking', message: expect.stringContaining('javascript:') }));
    expect(links).toContainEqual(expect.objectContaining({ severity: 'warning', message: expect.stringContaining('not a valid URL') }));
    expect(links).toContainEqual(expect.objectContaining({ severity: 'warning', message: expect.stringContaining('shortener') }));
    expect(links).toContainEqual(expect.objectContaining({ severity: 'warning', message: expect.stringContaining('no text') }));
  });

  it('accepts mailto and tel links', async () => {
    const r = await checkEmailTemplate(
      template({
        mjml: mjml(`<mj-text><a href="mailto:hi@example.com">Mail</a> <a href="tel:+4512345678">Call</a></mj-text>${unsubscribe}`),
      }),
      opts(),
    );
    expect(r.findings.filter((f) => f.category === 'links')).toEqual([]);
  });

  it('warns about missing alt text and passes a small decorative spacer', async () => {
    const r = await checkEmailTemplate(
      template({
        mjml: mjml(
          `<mj-image src="https://example.com/hero.png" />
           <mj-image src="https://example.com/spacer.png" alt="" width="2px" height="2px" />
           <mj-image src="https://example.com/ok.png" alt="A chart of open rates" />${unsubscribe}`,
        ),
      }),
      opts(),
    );
    const alt = r.findings.filter((f) => f.category === 'images' && f.message.includes('alt text'));
    expect(alt).toHaveLength(1);
    expect(alt[0]).toMatchObject({ severity: 'warning', location: expect.stringContaining('hero.png') });
  });

  it('blocks an image that points at an asset which no longer exists', async () => {
    const missing = 'ast_00000000000000000000000000000000';
    const r = await checkEmailTemplate(
      template({
        mjml: mjml(`<mj-image src="https://links.example/a/${missing}/hero.png" alt="Hero" />${unsubscribe}`),
      }),
      opts({ assets: async () => new Map() }),
    );
    expect(r.findings).toContainEqual(expect.objectContaining({ category: 'images', severity: 'blocking' }));
  });

  it('warns when the images weigh more than 1 MB, and about external SVG', async () => {
    const id = 'ast_11111111111111111111111111111111';
    const assets = new Map<string, AssetInfo>([
      [id, { byteSize: 1_200_000, contentType: 'image/png', width: 1200, height: 600, renditionByteSize: null }],
    ]);
    const r = await checkEmailTemplate(
      template({
        mjml: mjml(
          `<mj-image src="https://links.example/a/${id}/hero.png" alt="Hero" />
           <mj-image src="https://example.com/icon.svg" alt="Icon" />${unsubscribe}`,
        ),
      }),
      opts({ assets: async () => assets }),
    );
    expect(r.findings).toContainEqual(expect.objectContaining({ severity: 'warning', message: expect.stringContaining('MB') }));
    expect(r.findings).toContainEqual(expect.objectContaining({ severity: 'warning', message: expect.stringContaining('SVG') }));
  });

  it('warns when the HTML is over the Gmail clipping size, and notes a missing preheader', async () => {
    const r = await checkEmailTemplate(
      template({ preheader: undefined, mjml: mjml(`<mj-text>${'x'.repeat(110_000)}</mj-text>${unsubscribe}`) }),
      opts(),
    );
    expect(r.findings).toContainEqual(
      expect.objectContaining({ category: 'rendering', severity: 'warning', message: expect.stringContaining('102 KB') }),
    );
    expect(r.findings).toContainEqual(
      expect.objectContaining({ category: 'rendering', severity: 'info', message: expect.stringContaining('preheader') }),
    );
  });

  it('notes personalisation that renders empty and suggests a default', async () => {
    const r = await checkEmailTemplate(template({ mjml: mjml(`<mj-text>Hi {{ profile.firstName }}</mj-text>${unsubscribe}`) }), opts());
    const f = r.findings.find((x) => x.category === 'personalisation' && x.message.includes('profile.firstName'));
    expect(f?.severity).toBe('info');
    expect(f?.fix).toContain("default: 'there'");
    // With a sample value it is fine.
    const ok = await checkEmailTemplate(
      template({
        mjml: mjml(`<mj-text>Hi {{ profile.firstName }}</mj-text>${unsubscribe}`),
        sampleData: { profile: { firstName: 'Ada' } },
      }),
      opts(),
    );
    expect(ok.findings.filter((x) => x.category === 'personalisation')).toEqual([]);
  });

  it('checks the subject: length, capitals, punctuation and spam phrases', async () => {
    const r = await checkEmailTemplate(
      template({
        subject: 'BIG NEWS TODAY: Act now and get FREE MONEY!!! This subject is deliberately long so it passes seventy characters',
      }),
      opts(),
    );
    const subject = r.findings.filter((f) => f.category === 'subject');
    expect(subject).toContainEqual(expect.objectContaining({ severity: 'info', message: expect.stringContaining('characters') }));
    expect(subject).toContainEqual(expect.objectContaining({ severity: 'warning', message: expect.stringContaining('ALL CAPS') }));
    expect(subject).toContainEqual(expect.objectContaining({ severity: 'warning', message: expect.stringContaining('!!!') }));
    expect(subject).toContainEqual(expect.objectContaining({ severity: 'warning', message: expect.stringContaining('“act now”') }));
    expect(subject).toContainEqual(expect.objectContaining({ severity: 'warning', message: expect.stringContaining('“free money”') }));
  });

  it('gives stable, deduplicated ids', async () => {
    const t = template({ mjml: withLink('javascript:alert(1)') });
    const [a, b] = await Promise.all([checkEmailTemplate(t, opts()), checkEmailTemplate(t, opts())]);
    expect(a.findings.map((f) => f.id)).toEqual(b.findings.map((f) => f.id));
    expect(new Set(a.findings.map((f) => f.id)).size).toBe(a.findings.length);
  });

  it('parses links and images from the rendered HTML', () => {
    const { links, images } = scanHtml(
      '<a href="https://example.com/?a=1&amp;b=2">Read <img src="x.png" alt="cover"></a><img src="y.png">',
    );
    expect(links).toEqual([{ href: 'https://example.com/?a=1&b=2', text: 'Read cover' }]);
    expect(images).toEqual([
      { src: 'x.png', alt: 'cover', width: '', height: '' },
      { src: 'y.png', alt: null, width: '', height: '' },
    ]);
  });
});

describe('link reachability', () => {
  let server: Server;
  let baseUrl = '';
  let hits: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      if (req.url === '/gone') return res.writeHead(410).end();
      if (req.url === '/private') return res.writeHead(403).end();
      res.writeHead(200).end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    hits = [];
    clearLinkCache();
  });

  const request = async (url: string, method: 'HEAD' | 'GET') => ({ status: (await fetch(url, { method })).status });

  it('does not fetch anything unless asked', async () => {
    const r = await checkEmailTemplate(template({ mjml: withLink(`${baseUrl}/ok`) }), opts({ request }));
    expect(r.findings.filter((f) => f.category === 'links')).toEqual([]);
    expect(hits).toEqual([]);
  });

  it('treats 404/410 as broken and 401/403/405 as unverified, and 200 as fine', async () => {
    const r = await checkEmailTemplate(
      template({
        mjml: mjml(
          `<mj-text><a href="${baseUrl}/ok">Fine</a> <a href="${baseUrl}/gone">Gone</a> <a href="${baseUrl}/private">Private</a></mj-text>${unsubscribe}`,
        ),
      }),
      opts({ checkLinks: true, request }),
    );
    expect(r.findings).toContainEqual(expect.objectContaining({ severity: 'warning', message: expect.stringContaining('HTTP 410') }));
    expect(r.findings).toContainEqual(expect.objectContaining({ severity: 'info', message: expect.stringContaining('HTTP 403') }));
    expect(r.findings.filter((f) => f.message.includes('HTTP 200'))).toEqual([]);
  });

  it('caches a result for an hour, so a second call does not fetch again', async () => {
    const t = template({ mjml: withLink(`${baseUrl}/ok`) });
    await checkEmailTemplate(t, opts({ checkLinks: true, request }));
    const first = hits.length;
    await checkEmailTemplate(t, opts({ checkLinks: true, request }));
    expect(first).toBeGreaterThan(0);
    expect(hits.length).toBe(first);
  });

  it('never fetches a personalised link', async () => {
    const t = template({
      mjml: mjml(`<mj-text><a href="${baseUrl}/u/{{ profile.id }}">Your account</a></mj-text>${unsubscribe}`),
      sampleData: { profile: { id: 'prf_1234567890' } },
    });
    const r = await checkEmailTemplate(t, opts({ checkLinks: true, request }));
    expect(hits.filter((h) => h.includes('prf_'))).toEqual([]);
    expect(r.findings.filter((f) => f.category === 'links' && f.severity !== 'info')).toEqual([]);
  });

  it('never fetches the platform’s own links', async () => {
    const t = template({ mjml: withLink(`${baseUrl}/ok`) });
    const r = await checkEmailTemplate(t, opts({ checkLinks: true, request, platformUrl: (url) => url.startsWith(baseUrl) }));
    expect(hits).toEqual([]);
    expect(r.findings.filter((f) => f.category === 'links')).toEqual([]);
  });
});
