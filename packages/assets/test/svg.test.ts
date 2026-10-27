import { describe, expect, it } from 'vitest';
import { sanitiseSvg } from '../src/svg';

// The url() rule of the SVG sanitiser (#111): only references inside the document survive, also
// when the url( is unterminated or quoted, which CSS accepts and a matched-pair pattern misses.
const svg = (inner: string) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${inner}<rect width="10" height="10"/></svg>`);
const out = (inner: string) => {
  const r = sanitiseSvg(svg(inner));
  return { text: r.svg, removed: r.sanitized };
};

describe('SVG url() references', () => {
  it('keeps url(#id)', () => {
    const r = out('<defs><linearGradient id="g"/></defs><path d="M0 0h1" fill="url(#g)"/>');
    expect(r.text).toContain('fill="url(#g)"');
    expect(r.removed).toEqual([]);
  });

  it.each([
    ['unterminated', 'url(http://evil.example/x'],
    ['quoted', "url('https://evil.example/x')"],
    ['spaced', 'url(  //evil.example/x )'],
    ['upper case', 'URL(http://evil.example/x)'],
  ])('drops an external url (%s) in an attribute and in style', (_label, value) => {
    const attr = out(`<path d="M0 0h1" fill="${value.replace(/"/g, '&quot;')}"/>`);
    expect(attr.text).not.toContain('evil.example');
    const style = out(`<path d="M0 0h1" style="fill:${value.replace(/"/g, '&quot;')}"/>`);
    expect(style.text).not.toContain('evil.example');
  });
});
