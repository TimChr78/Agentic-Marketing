import { describe, expect, it } from 'vitest';
import type { BrandColor } from '../src/hostedPages';
import { HOSTED_PAGE_KINDS, renderHostedPage, resolveBrand } from '../src/hostedPages';
import type { Brand } from '../src/types';

// The hosted pages (#112, #113) are plain HTML with one inline stylesheet, so the useful checks
// are on the document itself: every custom property the CSS reads must be declared, and the
// header must not repeat the site name under a logo.

const styleOf = (html: string): string => html.slice(html.indexOf('<style>'), html.indexOf('</style>'));

const usedVariables = (css: string): Set<string> => new Set([...css.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((match) => match[1]));

const declaredVariables = (css: string): Set<string> => {
  const root = /:root\{([^}]*)\}/.exec(css);
  if (!root) return new Set();
  return new Set([...root[1].matchAll(/--([a-z0-9-]+)\s*:/g)].map((match) => match[1]));
};

const allColors: Record<BrandColor, string> = {
  background: '#101010',
  surface: '#1a1a1a',
  text: '#f5f5f5',
  muted: '#c0c0c0',
  accent: '#abcdef',
  accentText: '#0a0b0c',
  border: '#333333',
};

const brandWithEveryColour = (): ReturnType<typeof resolveBrand> => resolveBrand({ colors: allColors } as Brand);

describe('hosted page stylesheet (#112)', () => {
  it.each(HOSTED_PAGE_KINDS)('declares every custom property the %s page reads', (kind) => {
    for (const brand of [resolveBrand(), brandWithEveryColour()]) {
      const css = styleOf(renderHostedPage(kind, brand));
      const declared = declaredVariables(css);
      for (const name of usedVariables(css)) expect(declared, `${kind}: --${name}`).toContain(name);
    }
  });

  it('paints the button text with the brand accentText, not the inherited text colour', () => {
    const brand = resolveBrand({ colors: { ...allColors, accentText: '#abcdef' } } as Brand);
    const css = styleOf(renderHostedPage('confirm', brand));

    expect(css).toContain('--accent-text:#abcdef');
    expect(css).not.toContain('--accentText');
    expect(css).toMatch(/button\{[^}]*color:var\(--accent-text\)/);
  });
});

describe('hosted page header (#113)', () => {
  it('shows the logo without repeating the site name, and keeps the name in the alt text and back link', () => {
    const brand = resolveBrand({
      siteName: 'Example Co',
      siteUrl: 'https://example.com',
      logoUrl: 'https://example.com/logo.svg',
    } as Brand);
    const html = renderHostedPage('confirmed', brand);

    expect(html).not.toContain('class="site-name"');
    expect(html).toContain('alt="Example Co"');
    expect(html).toContain('Back to Example Co');
  });

  it('shows the site name at the top when there is no logo', () => {
    const brand = resolveBrand({ siteName: 'Example Co', siteUrl: 'https://example.com' } as Brand);
    const html = renderHostedPage('confirmed', brand);

    expect(html).toContain('<p class="site-name">Example Co</p>');
    expect(html).not.toContain('<img class="logo"');
  });
});
