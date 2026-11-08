import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BRAND_COLORS,
  HOSTED_PAGE_KINDS,
  hostedPageHeaders,
  renderHostedPage,
  renderPreferencesPage,
  resolveBrand,
} from '../src/hostedPages';
import type { Brand } from '../src/types';

// Phase 27 (#529): the hosted confirm/result/unsubscribe pages and the preference centre are
// recipient reading surfaces. The brand leads, every page keeps one heading and a quiet way back,
// the controls stay native and labelled, and nothing tracks a person before they agree.

const branded = (overrides: Partial<Brand> = {}) =>
  resolveBrand({
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
    ...overrides,
  } as Brand);

const stylesOf = (html: string) => html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
const usedVariables = (css: string) => new Set([...css.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]));
const declaredVariables = (css: string) => {
  const root = /:root\{([^}]*)\}/.exec(css);
  return new Set(root ? [...root[1].matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]) : []);
};

const channel = (hex: string) => {
  const value = hex.replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value;
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16) / 255);
};
const luminance = (hex: string) => {
  const [r, g, b] = channel(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};

const preferences = [
  {
    key: 'newsletter',
    name: 'Newsletter',
    description: 'The weekly issue.',
    topics: [
      { key: 'newsletter', name: 'Weekly stories', description: 'One e-mail a week.', status: 'subscribed' as const },
      { key: 'product_news', name: 'Product updates', description: 'Occasional product news.', status: 'unsubscribed' as const },
    ],
  },
];

describe('hosted recipient pages stay brand-led and readable (#529)', () => {
  it.each(HOSTED_PAGE_KINDS)('gives the %s page one heading, a main landmark, the brand header and no script', (kind) => {
    const html = renderHostedPage(kind, branded());

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en-GB">');
    expect(html).toContain('class="skip" href="#main"');
    expect(html).toMatch(/<main[^>]*id="main"/);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain('<header class="brand">');
    expect(html).toContain('alt="Northstar Journal"');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it.each(HOSTED_PAGE_KINDS)('declares every custom property the %s stylesheet reads', (kind) => {
    const css = stylesOf(renderHostedPage(kind, branded()));
    for (const name of usedVariables(css)) expect(declaredVariables(css), `--${name}`).toContain(name);
  });

  it('applies the published brand colours, type and radius without forcing the admin accent', () => {
    const html = renderHostedPage('confirm', branded());
    const css = stylesOf(html);

    expect(css).toContain('--accent:#8baafa');
    expect(css).toContain('--accent-text:#111512');
    expect(css).toContain('--radius:12px');
    expect(css).toContain('--font-stack:Georgia, serif');
    expect(css).toContain('font-family:var(--font-stack)');
    expect(css).not.toContain('#2457d6');
    expect(html).toContain('--measure:36rem');
  });

  it('keeps every copy key overridable and escapes injected copy', () => {
    const html = renderHostedPage('confirmed', branded(), {
      copy: {
        confirmedTitle: 'You are in',
        confirmedBody: 'Thanks </p><script>alert(1)</script>',
        backToSite: 'Return to {site}',
      },
    });

    expect(html).toContain('<h1>You are in</h1>');
    expect(html).toContain('Thanks &lt;/p&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Return to Northstar Journal');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('keeps scanner-safe POST actions and never puts the recipient in a URL', () => {
    const confirm = renderHostedPage('confirm', branded());
    const unsubscribe = renderHostedPage('unsubscribe', branded());

    expect(confirm).toContain('<form method="post">');
    expect(unsubscribe).toContain('<form method="post">');
    expect(confirm).not.toMatch(/method="get"/i);
    expect(confirm).not.toMatch(/<form[^>]*action=/i);
    expect(confirm).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    expect(unsubscribe).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    for (const kind of ['confirmed', 'expired', 'unsubscribed'] as const) {
      expect(renderHostedPage(kind, branded())).not.toContain('<form');
    }
  });

  it('offers the preference centre after unsubscribing and keeps the quiet way back', () => {
    const html = renderHostedPage('unsubscribed', branded(), { manageUrl: 'https://northstar.example/u/p/token' });

    expect(html).toContain('href="https://northstar.example/u/p/token"');
    expect(html).toContain('Manage your preferences');
    expect(html).toContain('Back to Northstar Journal');
  });

  it('adds no tracking pixel or third-party script to a recipient page', () => {
    const withLogo = renderHostedPage('confirmed', branded());
    const withoutLogo = renderHostedPage('confirmed', resolveBrand());

    expect(withLogo.match(/<img\b/g)).toHaveLength(1);
    expect(withLogo).toContain('src="https://northstar.example/logo.svg"');
    expect(withLogo).not.toMatch(/width="1"/);
    expect(withLogo).not.toMatch(/height="1"/);
    expect(withLogo).not.toContain('pixel');
    expect(withLogo).not.toContain('<script');
    expect(withoutLogo).not.toContain('<img');
  });

  it('keeps the exact strict CSP and no-script policy for hosted pages', () => {
    expect(hostedPageHeaders()['content-security-policy']).toBe(
      "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
  });

  it('uses contrast-safe default text and button pairs', () => {
    expect(contrast(DEFAULT_BRAND_COLORS.text, DEFAULT_BRAND_COLORS.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(DEFAULT_BRAND_COLORS.muted, DEFAULT_BRAND_COLORS.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(DEFAULT_BRAND_COLORS.text, DEFAULT_BRAND_COLORS.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(DEFAULT_BRAND_COLORS.accentText, DEFAULT_BRAND_COLORS.accent)).toBeGreaterThanOrEqual(4.5);

    const css = stylesOf(renderHostedPage('confirm', resolveBrand()));
    expect(css).toMatch(/button\{[^}]*color:var\(--accent-text\)/);
    expect(css).not.toContain('--accentText');
  });
});

describe('preference centre stays labelled and brand-led (#529)', () => {
  it('renders grouped labelled choices, one heading and the same POST target', () => {
    const html = renderPreferencesPage(branded(), {
      action: '/u/p/token',
      purposes: preferences,
      leavePurposeName: 'Newsletter',
    });

    expect(html).toContain('<h1>Your preferences</h1>');
    expect(html).toContain('<section class="purpose" aria-labelledby="purpose-newsletter">');
    expect(html).toContain('<h2 id="purpose-newsletter">Newsletter</h2>');
    expect(html).toContain('<fieldset aria-describedby="purpose-newsletter-description">');
    expect(html).toContain('<legend>Topics</legend>');
    expect(html).toContain('<label class="topic"><input type="checkbox" name="topic:newsletter" value="subscribed" checked>');
    expect(html).toContain('name="topic:product_news" value="subscribed"');
    expect(html).toContain('Save preferences');
    expect(html).toContain('Unsubscribe from Newsletter');
    expect(html).toContain('<form method="post" action="/u/p/token">');
    expect(html).not.toContain('<script');
  });

  it('escapes every purpose and topic value', () => {
    const html = renderPreferencesPage(branded(), {
      action: '/u/p/token',
      purposes: [
        {
          key: 'newsletter',
          name: 'Newsletter </h2><script>alert(1)</script>',
          description: '"quoted"',
          topics: [{ key: 'weekly', name: '<b>Weekly</b>', description: '', status: 'subscribed' }],
        },
      ],
    });

    expect(html).toContain('Newsletter &lt;/h2&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;quoted&quot;');
    expect(html).toContain('&lt;b&gt;Weekly&lt;/b&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('announces a saved choice and an error without exposing hidden input', () => {
    const saved = renderPreferencesPage(branded(), { action: '/u/p/token', purposes: preferences, saved: true });
    expect(saved).toContain('<p class="notice" role="status">Your preferences are saved.</p>');

    const failed = renderPreferencesPage(branded(), {
      action: '/u/p/token',
      purposes: preferences,
      error: 'Your choice was not saved. Please try again.',
    });
    expect(failed).toContain('<p class="error" role="alert">Your choice was not saved. Please try again.</p>');
    expect(failed).not.toMatch(/type="hidden"/i);
  });

  it('explains the empty state and keeps the way out available', () => {
    const html = renderPreferencesPage(branded(), { action: '/u/p/token', purposes: [], leavePurposeName: 'Marketing' });

    expect(html).toContain('No topic choices are available for this subscription.');
    expect(html).toContain('Unsubscribe from Marketing');
    expect(html).toContain('<header class="brand">');
    expect(html).toContain('alt="Northstar Journal"');
  });

  it('disables its buttons in the admin preview', () => {
    const html = renderPreferencesPage(branded(), { action: '', purposes: preferences, preview: true });
    expect(html.match(/<button\b[^>]*disabled aria-disabled="true"/g)).toHaveLength(2);
    expect(html.match(/<input\b[^>]*disabled/g)).toHaveLength(2);
  });
});
