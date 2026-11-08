import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HOSTED_PAGE_KINDS, hostedPageHeaders, renderHostedPage, renderPreferencesPage, resolveBrand } from '../src/hostedPages';

// Phase 28 (#559) content polish pins the recipient-facing output. The admin chrome in this task
// changes; the confirm/result/unsubscribe pages, the preference centre and their headers must
// stay byte-identical. The digests below were captured from the branch head before the polish
// edits and are asserted again after them: any change to recipient colours, paths, headers or
// machine-facing output fails here instead of shipping silently.
//
// The archive and web-version renderers are not touched by this task and keep their own exact
// output tests in packages/audience/test/phase27-archive-rendering.test.ts.

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const brand = resolveBrand({
  siteName: 'Northstar Journal',
  siteUrl: 'https://northstar.example',
  logoUrl: 'https://northstar.example/logo.svg',
  logoAlt: 'Northstar Journal',
  logoHeight: 36,
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
  language: 'en-GB',
} as never);

/** The published bytes on the branch head before this task edited anything. */
const PINNED: Record<(typeof HOSTED_PAGE_KINDS)[number], string> = {
  confirm: 'c8ec529bde58dcfbe7fb18e0879864d8f84afdd78b6a798bc64155d148e3f2c5',
  confirmed: '5115a870c1d841b360e0070608add1ce521df3efad1547b291491da018c21da1',
  expired: 'd155c231f64dfd4cb9cc8ea5a96588970875b591064a70e46cb5c756a1e9abc3',
  unsubscribe: '1bb26b7f3d9c7847f7d26e1f385c0b2619240cb124d1cf6ac5e6f4a791eea93a',
  unsubscribed: '7cd3c59f042d208923e3e64ded7fe8a901a6c5494e60f119fee10f13d6f5094e',
};

const preferences = () =>
  renderPreferencesPage(brand, {
    action: '/u/p/token',
    purposes: [
      {
        key: 'newsletter',
        name: 'Newsletter',
        description: 'The weekly issue.',
        topics: [{ key: 'newsletter', name: 'Weekly stories', description: 'One e-mail a week.', status: 'subscribed' }],
      },
    ],
    leavePurposeName: 'Newsletter',
  });

describe('recipient pages keep their exact bytes (#559)', () => {
  it.each(HOSTED_PAGE_KINDS)('renders the %s page unchanged', (kind) => {
    expect(sha256(renderHostedPage(kind, brand))).toBe(PINNED[kind]);
  });

  it('renders the preference centre unchanged', () => {
    expect(sha256(preferences())).toBe('6ad66bafb86dea1f3a916f584767887a9bff1cf76df44942c4596764715df225');
  });

  it('keeps the exact security headers', () => {
    expect(hostedPageHeaders()).toEqual({
      'content-security-policy':
        "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
  });

  it('keeps the published brand colours rather than the admin palette', () => {
    const html = renderHostedPage('confirm', brand);
    const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));

    expect(css).toContain('--background:#f6f7f9');
    expect(css).toContain('--surface:#ffffff');
    expect(css).toContain('--text:#111827');
    expect(css).toContain('--muted:#4b5563');
    expect(css).toContain('--accent:#8baafa');
    expect(css).toContain('--accent-text:#111512');
    expect(css).toContain('--border:#d1d5db');
    expect(css).toContain('--radius:12px');
    expect(css).not.toContain('#2457d6');
  });

  it('keeps the POST form, the confirm path and script-free output', () => {
    const confirm = renderHostedPage('confirm', brand);
    const unsubscribe = renderHostedPage('unsubscribe', brand);

    expect(confirm).toContain('<form method="post">');
    expect(unsubscribe).toContain('<form method="post">');
    expect(confirm).not.toMatch(/<form[^>]*action=/i);
    expect(confirm).not.toContain('<script');
    expect(confirm).toContain('<header class="brand">');
  });

  it('keeps the preference POST target and the label texts', () => {
    const html = preferences();

    expect(html).toContain('<form method="post" action="/u/p/token">');
    expect(html).toContain('Save preferences');
    expect(html).toContain('Unsubscribe from Newsletter');
    expect(html).not.toContain('<script');
  });
});
