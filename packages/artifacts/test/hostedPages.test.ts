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
