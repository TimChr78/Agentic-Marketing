import type { Brand } from '@agentic-marketing/artifacts';
import { resolveBrand } from '@agentic-marketing/artifacts';
import { describe, expect, it } from 'vitest';
import {
  type ArchiveIssue,
  type ArchiveSettingsView,
  emailParts,
  renderArchiveIndex,
  renderArchiveIssue,
  renderFeed,
  renderSitemap,
  renderWebVersion,
} from '../src/archive';

// Phase 27 (#529): the public archive index, issue, signed web version, feed and sitemap are
// recipient reading surfaces. The rendering functions change only presentation: the paths,
// security headers and list query stay in archiveRoutes and are covered by the server tests.

const brandContent = {
  siteName: 'Northstar Journal',
  siteUrl: 'https://northstar.example',
  logoUrl: 'https://northstar.example/logo.svg',
  logoAlt: 'Northstar Journal',
  language: 'en-GB',
  colors: {
    background: '#f6f7f9',
    surface: '#ffffff',
    text: '#111827',
    muted: '#4b5563',
    accent: '#8baafa',
    accentText: '#111512',
    border: '#d1d5db',
  },
  fontStack: 'Georgia, serif',
  radius: 12,
  archive: {
    enabled: true,
    title: 'The journal',
    description: 'Ideas for a more thoughtful week.',
    slug: 'journal',
    subscribeUrl: 'https://northstar.example/subscribe',
  },
} as unknown as Brand;

const brand = resolveBrand(brandContent);
const base = 'https://links.northstar.example/n/journal';
const settings: ArchiveSettingsView = {
  enabled: true,
  title: 'The journal',
  description: 'Ideas for a more thoughtful week.',
  slug: 'journal',
  indexUrl: `${base}/`,
  feedUrl: `${base}/feed.xml`,
  sitemapUrl: `${base}/sitemap.xml`,
  subscribeUrl: 'https://northstar.example/subscribe',
};
const issue = (n: number): ArchiveIssue => ({
  artifactId: `bct_${String(n).padStart(32, '0')}`,
  name: `Issue ${n}`,
  slug: `issue-${n}`,
  subject: `Issue ${n}`,
  summary: `Summary ${n}`,
  sentAt: new Date(Date.UTC(2026, 10, n, 9)).toISOString(),
  url: `${base}/issue-${n}`,
});
const issues = [issue(2), issue(1)];

const stylesOf = (html: string) => html.slice(html.indexOf('<style>'), html.indexOf('</style>'));

describe('archive index keeps the brand and a readable list (#529)', () => {
  it('renders one heading, a labelled list, dates, summaries and pagination', () => {
    const html = renderArchiveIndex(brandContent, brand, settings, issues, base, 1);

    expect(html).toContain('<html lang="en-GB">');
    expect(html).toContain('class="skip" href="#main"');
    expect(html).toMatch(/<main[^>]*id="main"/);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain('<h1>The journal</h1>');
    expect(html).toContain('<ul class="issues">');
    expect(html).toContain('<article>');
    expect(html).toContain(`<time datetime="2026-11-02T09:00:00.000Z">`);
    expect(html).toContain('href="https://links.northstar.example/n/journal/issue-2"');
    expect(html).toContain('Summary 2');
    expect(html).toContain('aria-labelledby="subscribe-title"');
    expect(html).toContain('href="https://northstar.example/subscribe"');
    expect(html).toContain('RSS feed');
    expect(html).not.toContain('<script');
  });

  it('applies the published brand rather than the admin accent', () => {
    const html = renderArchiveIndex(brandContent, brand, settings, issues, base, 1);
    const css = stylesOf(html);

    expect(css).toContain('--accent:#8baafa');
    expect(css).toContain('--font-stack:Georgia, serif');
    expect(css).toContain('--radius:12px');
    expect(css).toContain('font-family:var(--font-stack)');
    expect(css).not.toContain('#2457d6');
    expect(html).toContain('<header class="brand">');
    expect(html).toContain('alt="Northstar Journal"');
  });

  it('pages and clamps the archive with a labelled navigation', () => {
    const many = Array.from({ length: 21 }, (_, i) => issue(21 - i));
    const second = renderArchiveIndex(brandContent, brand, settings, many, base, 99);

    expect(second).toContain('aria-label="Archive pages"');
    expect(second).toContain('aria-current="page">Page 2 of 2</span>');
    expect(second).toContain('href="https://links.northstar.example/n/journal/?page=1"');
    expect(second).toContain('← Newer');
  });

  it('has an explicit empty state and escapes issue text', () => {
    const empty = renderArchiveIndex(brandContent, brand, settings, [], base, 1);
    expect(empty).toContain('No issues have been published yet.');

    const hostile = renderArchiveIndex(
      brandContent,
      brand,
      settings,
      [{ ...issue(1), subject: '</h2><script>alert(1)</script>', summary: '"><img src=x>' }],
      base,
      1,
    );
    expect(hostile).toContain('&lt;/h2&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(hostile).toContain('&quot;&gt;&lt;img src=x&gt;');
    expect(hostile).not.toContain('<script>alert(1)</script>');
  });
});

describe('archive issue stays a safe public reading page (#529)', () => {
  const email = `<style>.issue{color:#111827}</style><body><h1>Hello</h1><p>This week &amp; next.</p>
<img src="https://track.example/pixel.gif" width="1" height="1" alt="">
<img src="https://northstar.example/photo.jpg" alt="A photo">
<script>alert(1)</script><a href="#" onclick="alert(1)">A link</a></body>`;

  it('keeps canonical, social metadata, article JSON-LD and the e-mail content', () => {
    const html = renderArchiveIssue(brandContent, brand, settings, issue(2), email, base);

    expect(html).toContain('<link rel="canonical" href="https://links.northstar.example/n/journal/issue-2">');
    expect(html).toContain('<meta property="og:type" content="article">');
    expect(html).toContain('<meta name="robots" content="index,follow">');
    expect(html).toContain('"@type":"Article"');
    expect(html).toContain('<h1>Issue 2</h1>');
    expect(html).toContain('This week &amp; next.');
    expect(html).toContain('alt="A photo"');
    expect(html).toContain('aria-label="Archive navigation"');
    expect(html).toContain('← All issues');
  });

  it('drops open-tracking pixels, scripts and event handlers', () => {
    const html = renderArchiveIssue(brandContent, brand, settings, issue(2), email, base);

    expect(html).not.toContain('track.example');
    expect(html).not.toMatch(/<script(?![^>]*application\/ld\+json)/);
    expect(html).not.toContain('onclick=');
    expect(html).not.toContain('width="1"');
  });

  it('carries no unsubscribe token or mailto recipient address', () => {
    const html = renderArchiveIssue(brandContent, brand, settings, issue(2), email, base);

    expect(html).not.toMatch(/\/u\/[A-Za-z0-9._-]+/);
    expect(html).not.toContain('mailto:');
  });

  it('renders the signed web version with noindex and its archive link', () => {
    const html = renderWebVersion(brand, 'Issue 2', `${base}/issue-2`, email);

    expect(html).toContain('<meta name="robots" content="noindex,nofollow">');
    expect(html).toContain('<title>Issue 2</title>');
    expect(html).toContain('<h1>Issue 2</h1>');
    expect(html).toContain('href="https://links.northstar.example/n/journal/issue-2"');
    expect(html).toContain('Read the archive');
    expect(html).not.toContain('<link rel="canonical"');
  });

  it('hides the archive link when there is no published issue', () => {
    const html = renderWebVersion(brand, 'Issue 2', null, '<body><p>Hello</p></body>');
    expect(html).not.toContain('Read the archive');
  });

  it('splits e-mail HTML into a body and styles and strips the tracking pixel', () => {
    const parts = emailParts(email);
    expect(parts.styles).toContain('.issue{color:#111827}');
    expect(parts.body).toContain('<h1>Hello</h1>');
    expect(parts.body).toContain('alt="A photo"');
    expect(parts.body).not.toContain('track.example');
    expect(parts.body).not.toContain('<script');
    expect(parts.body).not.toContain('onclick=');
  });
});

describe('archive feed and sitemap outputs stay machine-readable (#529)', () => {
  it('serves RSS with escaped titles, links and dates', () => {
    const xml = renderFeed(brandContent, brand, settings, [{ ...issue(1), subject: 'A & B' }], base);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<rss version="2.0">');
    expect(xml).toContain('<title>A &amp; B</title>');
    expect(xml).toContain(`<link>${base}/issue-1</link>`);
    expect(xml).toContain('<language>en-GB</language>');
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;|#)/);
  });

  it('serves a sitemap with the index and every issue', () => {
    const xml = renderSitemap(issues, base);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain(`<loc>${base}/</loc>`);
    expect(xml).toContain(`<loc>${base}/issue-2</loc>`);
  });
});
