import type { EmailTemplate } from '@agentic-marketing/artifacts';
import { describe, expect, it } from 'vitest';
import { expectLinear } from '../../../test-support/linear';
import { emailPublishProblems } from '../src/checks';
import { validateTemplate } from '../src/render';
import { MAX_UNSUBSCRIBE_NESTING, unsubscribeLinkProblem } from '../src/unsubscribe';

// Review of #637 (P2): the gate only checked that an <a href> with the unsubscribe URL existed.
// A link nobody can see or click — inline display:none, an ancestor style, a <template>, or an
// empty anchor — passed and had no other publish blocker. The predicate must find a usable link
// and the gate must say why it refused one.

const URL = 'https://links.example.com/u/token';
const link = (attrs = '', text = 'Unsubscribe') => `<a href="${URL}"${attrs}>${text}</a>`;

const rejected: { name: string; html: string; reason: 'hidden' | 'empty' | 'missing' }[] = [
  { name: 'inline display:none', html: link(' style="display:none"'), reason: 'hidden' },
  { name: 'the hidden attribute', html: link(' hidden'), reason: 'hidden' },
  { name: 'aria-hidden="true"', html: link(' aria-hidden="true"'), reason: 'hidden' },
  { name: 'visibility:hidden with !important', html: link(' style="visibility: hidden !important"'), reason: 'hidden' },
  { name: 'opacity:0', html: link(' style="opacity:0"'), reason: 'hidden' },
  { name: 'font-size:0', html: link(' style="font-size: 0px"'), reason: 'hidden' },
  { name: 'max-height:0 with overflow:hidden', html: link(' style="max-height:0;overflow:hidden"'), reason: 'hidden' },
  { name: 'height:0 with overflow:hidden', html: link(' style="height:0px; overflow: hidden"'), reason: 'hidden' },
  { name: 'width:0 with overflow:hidden', html: link(' style="width:0;overflow:hidden"'), reason: 'hidden' },
  { name: 'mso-hide:all', html: link(' style="mso-hide:all"'), reason: 'hidden' },
  { name: 'colour equal to the background', html: link(' style="color:#ffffff;background-color:#FFFFFF"'), reason: 'hidden' },
  { name: 'an ancestor with display:none', html: `<div style="display:none"><p>${link()}</p></div>`, reason: 'hidden' },
  {
    name: 'an ancestor with visibility:hidden',
    html: `<table><tr><td style="visibility:hidden">${link()}</td></tr></table>`,
    reason: 'hidden',
  },
  { name: 'a link inside <template>', html: `<template>${link()}</template>`, reason: 'hidden' },
  { name: 'a link inside <head>', html: `<html><head>${link()}</head><body>Body</body></html>`, reason: 'hidden' },
  { name: 'a link inside <noscript>', html: `<noscript>${link()}</noscript>`, reason: 'hidden' },
  { name: 'an empty anchor', html: `<a href="${URL}"></a>`, reason: 'empty' },
  { name: 'an anchor with only whitespace', html: `<a href="${URL}"> \n\t </a>`, reason: 'empty' },
  { name: 'an image with an empty alt', html: `<a href="${URL}"><img src="x.png" alt=""></a>`, reason: 'empty' },
  { name: 'a link only inside a comment', html: `<!-- ${link()} -->`, reason: 'hidden' },
  // Review round 2 (P2): content inside the link is checked at the content node, not just at the
  // anchor and its ancestors. A display:none span is not visible content, even though the anchor
  // itself is visible.
  {
    name: 'a hidden span inside the link',
    html: `<a href="${URL}"><span style="display:none">Unsubscribe</span></a>`,
    reason: 'hidden',
  },
  {
    name: 'a span with visibility:hidden inside the link',
    html: `<a href="${URL}"><span style="visibility:hidden">Unsubscribe</span></a>`,
    reason: 'hidden',
  },
  {
    name: 'a span with font-size:0 inside the link',
    html: `<a href="${URL}"><span style="font-size:0">Unsubscribe</span></a>`,
    reason: 'hidden',
  },
  {
    name: 'a span with the hidden attribute inside the link',
    html: `<a href="${URL}"><span hidden>Unsubscribe</span></a>`,
    reason: 'hidden',
  },
  {
    name: 'a span hidden by a class rule inside the link',
    html: `<html><head><style>.gone { display: none; }</style></head><body><a href="${URL}"><span class="gone">Unsubscribe</span></a></body></html>`,
    reason: 'hidden',
  },
  {
    name: 'a hidden image inside the link',
    html: `<a href="${URL}"><img src="x.png" alt="Unsubscribe" style="display:none"></a>`,
    reason: 'hidden',
  },
  // Review round 3 (P2): invisible colours, and the last declaration of a property winning.
  { name: 'transparent text', html: link(' style="color:transparent"'), reason: 'hidden' },
  { name: 'zero-alpha rgba text', html: link(' style="color:rgba(0,0,0,0)"'), reason: 'hidden' },
  { name: 'zero-alpha shorthand hex text', html: link(' style="color:#0000"'), reason: 'hidden' },
  { name: 'white on white', html: link(' style="color:#fff;background:#FFFFFF"'), reason: 'hidden' },
  { name: 'display:inline then display:none', html: link(' style="display:inline;display:none"'), reason: 'hidden' },
  { name: 'display:block then display:none', html: link(' style="display:block;display:none"'), reason: 'hidden' },
  // Review round 4 (P2): a transparent background shows the ancestor's background through it.
  {
    name: 'white text with a transparent background on a white parent',
    html: `<div style="background:#fff"><a href="${URL}" style="color:#fff;background-color:transparent">Unsubscribe</a></div>`,
    reason: 'hidden',
  },
  {
    name: 'white text with a zero-alpha background on a white parent',
    html: `<div style="background-color:#ffffff"><a href="${URL}" style="color:white;background:rgba(0,0,0,0)">Unsubscribe</a></div>`,
    reason: 'hidden',
  },
  // Review round 5: backgrounds that need compositing, the shorthand colour, the later of
  // background/background-color, and the bgcolor attribute.
  {
    name: 'white text on a semi-transparent white background over white',
    html: `<div style="background:#fff"><a href="${URL}" style="color:white;background:rgba(255,255,255,0.5)">Unsubscribe</a></div>`,
    reason: 'hidden',
  },
  {
    name: 'white text on a gradient shorthand ending in white over black',
    html: `<div style="background:#000"><a href="${URL}" style="color:white;background:linear-gradient(transparent,transparent) #fff">Unsubscribe</a></div>`,
    reason: 'hidden',
  },
  {
    name: 'a later background shorthand overriding background-color',
    html: link(' style="color:white;background-color:black;background:white"'),
    reason: 'hidden',
  },
  {
    name: 'white text in a white bgcolor table cell under a black parent',
    html: `<div style="background:#000"><table><tr><td bgcolor="#ffffff"><a href="${URL}" style="color:white">Unsubscribe</a></td></tr></table></div>`,
    reason: 'hidden',
  },
  {
    name: 'white text in a white font element under a white parent',
    html: `<div style="background:#fff"><font color="white"><a href="${URL}">Unsubscribe</a></font></div>`,
    reason: 'hidden',
  },
  { name: 'an important hide then a later unhide', html: link(' style="display:none !important;display:block"'), reason: 'hidden' },
  {
    name: 'an important class rule over an inline unhide',
    html: `<html><head><style>.footer { display: none !important; }</style></head><body>${link(' class="footer" style="display:block"')}</body></html>`,
    reason: 'hidden',
  },
  {
    name: 'a later rule that hides',
    html: `<html><head><style>.a { display: block; } .b { display: none; }</style></head><body>${link(' class="a b"')}</body></html>`,
    reason: 'hidden',
  },
];

describe('the unsubscribe link must be visible and clickable (#637 review)', () => {
  it.each(rejected)('rejects $name with the reason $reason', ({ html, reason }) => {
    expect(unsubscribeLinkProblem(html, URL)).toBe(reason);
  });

  it('accepts a normal visible text link', () => {
    expect(unsubscribeLinkProblem(`<p>${link()}</p>`, URL)).toBeNull();
  });

  it('accepts a link with one hidden span and one visible span', () => {
    expect(
      unsubscribeLinkProblem(`<a href="${URL}"><span style="display:none">Unsubscribe</span> <span>Unsubscribe</span></a>`, URL),
    ).toBeNull();
  });

  // Review round 2 (P3): the anchor's font-size:0 is overridden by the span that holds the text.
  it('accepts a zero font size on the anchor when the text resets it', () => {
    expect(
      unsubscribeLinkProblem(`<a href="${URL}" style="font-size:0"><span style="font-size:13px">Unsubscribe</span></a>`, URL),
    ).toBeNull();
  });

  it('accepts display:none followed by display:block', () => {
    expect(unsubscribeLinkProblem(link(' style="display:none;display:block"'), URL)).toBeNull();
  });

  // Review round 3 (P3): the inline declaration wins over a non-important class rule.
  it('accepts an inline display:block over a hiding class rule', () => {
    const html = `<html><head><style>.footer { display: none; }</style></head><body>${link(' class="footer" style="display:block"')}</body></html>`;
    expect(unsubscribeLinkProblem(html, URL)).toBeNull();
  });

  it('accepts the later of two simple rules', () => {
    const html = `<html><head><style>.a { display: none; } .b { display: block; }</style></head><body>${link(' class="a b"')}</body></html>`;
    expect(unsubscribeLinkProblem(html, URL)).toBeNull();
  });

  it('accepts a link whose text recolours itself under a hidden-colour anchor', () => {
    expect(
      unsubscribeLinkProblem(
        `<a href="${URL}" style="color:#ffffff;background-color:#ffffff"><span style="color:#111827">Unsubscribe</span></a>`,
        URL,
      ),
    ).toBeNull();
  });

  it('accepts an image link with alt text', () => {
    expect(unsubscribeLinkProblem(`<p><a href="${URL}"><img src="x.png" alt="Unsubscribe"></a></p>`, URL)).toBeNull();
  });

  it('accepts a link whose colour differs from its background', () => {
    expect(unsubscribeLinkProblem(link(' style="color:#111827;background-color:#ffffff"'), URL)).toBeNull();
  });

  it('accepts dark text on a semi-transparent white background over white', () => {
    expect(
      unsubscribeLinkProblem(
        `<div style="background:#fff"><a href="${URL}" style="color:#111827;background:rgba(255,255,255,0.5)">Unsubscribe</a></div>`,
        URL,
      ),
    ).toBeNull();
  });

  it('accepts white text on a gradient shorthand ending in black', () => {
    expect(
      unsubscribeLinkProblem(
        `<div style="background:#000"><a href="${URL}" style="color:white;background:linear-gradient(transparent,transparent) #000">Unsubscribe</a></div>`,
        URL,
      ),
    ).toBeNull();
  });

  it('accepts white text when background-color comes after the shorthand', () => {
    expect(unsubscribeLinkProblem(link(' style="color:white;background:white;background-color:black"'), URL)).toBeNull();
  });

  it('accepts white text in a black bgcolor table cell', () => {
    expect(
      unsubscribeLinkProblem(
        `<table><tr><td bgcolor="#000000"><a href="${URL}" style="color:white">Unsubscribe</a></td></tr></table>`,
        URL,
      ),
    ).toBeNull();
  });

  it('accepts a zero dimension without overflow:hidden (a collapsed box is not our concern)', () => {
    expect(unsubscribeLinkProblem(link(' style="height:0"'), URL)).toBeNull();
  });

  it('rejects a link hidden by a simple class rule in <style>', () => {
    const html = `<html><head><style>.gone { display: none; }</style></head><body>${link(' class="gone"')}</body></html>`;
    expect(unsubscribeLinkProblem(html, URL)).toBe('hidden');
  });

  it('rejects a link whose ancestor id is hidden by a <style> rule', () => {
    const html = `<html><head><style>#footer { visibility: hidden; }</style></head><body><div id="footer">${link()}</div></body></html>`;
    expect(unsubscribeLinkProblem(html, URL)).toBe('hidden');
  });

  it('does not evaluate selectors it cannot model, such as a rule inside @media', () => {
    const html = `<html><head><style>@media (max-width: 600px) { .gone { display: none; } }</style></head><body>${link(' class="gone"')}</body></html>`;
    expect(unsubscribeLinkProblem(html, URL)).toBeNull();
  });

  it('stays linear with many content nodes inside the link', () => {
    expectLinear(
      (n) => `<a href="${URL}">${'<span style="display:none">x</span>'.repeat(n)}</a>`,
      (html) => unsubscribeLinkProblem(html, URL),
      5_000,
    );
  });

  it('stays linear with many compound style rules and many elements (review round 5)', () => {
    expectLinear(
      (n) =>
        `<html><head><style>${'.x.y{background:#fff}'.repeat(n)}</style></head><body>${'<div>x</div>'.repeat(n)}<a href="${URL}">Unsubscribe</a></body></html>`,
      (html) => unsubscribeLinkProblem(html, URL),
      2_000,
    );
  });

  it('stays linear for one selector naming many classes against many elements (review round 6)', () => {
    expectLinear(
      (n) =>
        `<html><head><style>${'.x'.repeat(n)}{display:none}</style></head><body>${'<div class="x">x</div>'.repeat(n)}<a href="${URL}">Unsubscribe</a></body></html>`,
      (html) => unsubscribeLinkProblem(html, URL),
      2_000,
    );
  });

  it('stays linear for deep nesting and rejects it past the limit (review round 6)', () => {
    expectLinear(
      (n) => `${'<div>'.repeat(n)}<a href="${URL}">Unsubscribe</a>${'</div>'.repeat(n)}`,
      (html) => unsubscribeLinkProblem(html, URL),
      8_000,
    );
    const deep = `${'<div>'.repeat(MAX_UNSUBSCRIBE_NESTING + 1)}<a href="${URL}">Unsubscribe</a>`;
    expect(unsubscribeLinkProblem(deep, URL)).toBe('too_deep');
    const fine = `${'<div>'.repeat(60)}<a href="${URL}">Unsubscribe</a>${'</div>'.repeat(60)}`;
    expect(unsubscribeLinkProblem(fine, URL)).toBeNull();
  });

  it('parses a long stylesheet background once, not per matching element (review round 7)', () => {
    expectLinear(
      (n) =>
        `<html><head><style>.x{background:linear-gradient(${'red,'.repeat(n)}blue) #fff}</style></head><body>${'<div class="x">x</div>'.repeat(n)}<a href="${URL}">Unsubscribe</a></body></html>`,
      (html) => unsubscribeLinkProblem(html, URL),
      2_000,
    );
  });

  it('parses a background shared by a long selector list once (review round 8)', () => {
    expectLinear(
      (n) => {
        const selectors = Array.from({ length: n }, (_, i) => `.x${i}`).join(',');
        const divs = Array.from({ length: n }, (_, i) => `<div class="x${i}">x</div>`).join('');
        return `<html><head><style>${selectors}{background:linear-gradient(${'red,'.repeat(n)}blue) #fff}</style></head><body>${divs}<a href="${URL}">Unsubscribe</a></body></html>`;
      },
      (html) => unsubscribeLinkProblem(html, URL),
      2_000,
    );
  });

  it('still applies a compound hiding rule in a normal stylesheet', () => {
    const html = `<html><head><style>.foot.gone{display:none}</style></head><body><a class="foot gone" href="${URL}">Unsubscribe</a></body></html>`;
    expect(unsubscribeLinkProblem(html, URL)).toBe('hidden');
  });
});

const mjml = (body: string, head = '') =>
  `<mjml><mj-head>${head}</mj-head><mj-body><mj-section><mj-column>${body}</mj-column></mj-section></mj-body></mjml>`;

const template = (body: string, head = ''): EmailTemplate =>
  ({ purpose: 'marketing_email', subject: 'A calm subject', mjml: mjml(body, head) }) as EmailTemplate;

describe('the gate refuses an unusable unsubscribe link at save and at publish (#637 review)', () => {
  it('rejects a hidden link and says so', async () => {
    const t = template('<mj-text><a style="display:none" href="{{ unsubscribe_url }}">Unsubscribe</a></mj-text>');
    expect((await validateTemplate(t)).join(' ')).toContain('hidden');
    expect((await emailPublishProblems(t, { marketing: true })).join(' ')).toContain('hidden');
  });

  it('rejects a link inside <template> and says it is hidden', async () => {
    const t = template('<mj-text><template><a href="{{ unsubscribe_url }}">Unsubscribe</a></template></mj-text>');
    expect((await validateTemplate(t)).join(' ')).toContain('hidden');
    expect((await emailPublishProblems(t, { marketing: true })).join(' ')).toContain('hidden');
  });

  it('rejects an empty link and says it has no text', async () => {
    const t = template('<mj-text><a href="{{ unsubscribe_url }}"></a></mj-text>');
    expect((await validateTemplate(t)).join(' ')).toContain('no text');
    expect((await emailPublishProblems(t, { marketing: true })).join(' ')).toContain('no text');
  });

  it('rejects a link whose only content is a hidden span, at save and at publish', async () => {
    const t = template('<mj-text><a href="{{ unsubscribe_url }}"><span style="display:none">Unsubscribe</span></a></mj-text>');
    expect((await validateTemplate(t)).join(' ')).toContain('hidden');
    expect((await emailPublishProblems(t, { marketing: true })).join(' ')).toContain('hidden');
  });

  it('accepts a zero font size on the anchor when the text resets it', async () => {
    const t = template(
      '<mj-text><a style="font-size:0" href="{{ unsubscribe_url }}"><span style="font-size:13px">Unsubscribe</span></a></mj-text>',
    );
    await expect(validateTemplate(t)).resolves.toEqual([]);
    await expect(emailPublishProblems(t, { marketing: true })).resolves.toEqual([]);
  });

  it('rejects a link hidden by an mj-style class rule', async () => {
    const t = template(
      '<mj-text><a class="gone" href="{{ unsubscribe_url }}">Unsubscribe</a></mj-text>',
      '<mj-style>.gone { display: none; }</mj-style>',
    );
    expect((await validateTemplate(t)).join(' ')).toContain('hidden');
    expect((await emailPublishProblems(t, { marketing: true })).join(' ')).toContain('hidden');
  });

  it('rejects transparent text at save and at publish', async () => {
    const t = template('<mj-text><a style="color:transparent" href="{{ unsubscribe_url }}">Unsubscribe</a></mj-text>');
    expect((await validateTemplate(t)).join(' ')).toContain('hidden');
    expect((await emailPublishProblems(t, { marketing: true })).join(' ')).toContain('hidden');
  });

  it('rejects white text on a transparent background inside a white section at save and at publish', async () => {
    const t = template(
      '<mj-text container-background-color="#ffffff"><div style="background:#fff"><a style="color:#fff;background-color:transparent" href="{{ unsubscribe_url }}">Unsubscribe</a></div></mj-text>',
    );
    expect((await validateTemplate(t)).join(' ')).toContain('hidden');
    expect((await emailPublishProblems(t, { marketing: true })).join(' ')).toContain('hidden');
  });

  it('rejects a display:inline followed by display:none at save and at publish', async () => {
    const t = template('<mj-text><a style="display:inline;display:none" href="{{ unsubscribe_url }}">Unsubscribe</a></mj-text>');
    expect((await validateTemplate(t)).join(' ')).toContain('hidden');
    expect((await emailPublishProblems(t, { marketing: true })).join(' ')).toContain('hidden');
  });

  it('rejects white text on a semi-transparent white background at save and at publish', async () => {
    const t = template(
      '<mj-text><div style="background:#fff"><a style="color:white;background:rgba(255,255,255,0.5)" href="{{ unsubscribe_url }}">Unsubscribe</a></div></mj-text>',
    );
    expect((await validateTemplate(t)).join(' ')).toContain('hidden');
    expect((await emailPublishProblems(t, { marketing: true })).join(' ')).toContain('hidden');
  });

  it('rejects white text in a white bgcolor table cell at save and at publish', async () => {
    const t = template(
      '<mj-table><tr><td bgcolor="#ffffff"><a style="color:white" href="{{ unsubscribe_url }}">Unsubscribe</a></td></tr></mj-table>',
    );
    expect((await validateTemplate(t)).join(' ')).toContain('hidden');
    expect((await emailPublishProblems(t, { marketing: true })).join(' ')).toContain('hidden');
  });

  it('accepts an inline display:block over a hiding mj-style class rule', async () => {
    const t = template(
      '<mj-text><a class="footer" style="display:block" href="{{ unsubscribe_url }}">Unsubscribe</a></mj-text>',
      '<mj-style>.footer { display: none; }</mj-style>',
    );
    await expect(validateTemplate(t)).resolves.toEqual([]);
    await expect(emailPublishProblems(t, { marketing: true })).resolves.toEqual([]);
  });

  it('still accepts a visible link, including one from a block footer', async () => {
    const footer = { id: `blk_${'a'.repeat(32)}`, mjml: '<mj-text><a href="{{ unsubscribe_url }}">Unsubscribe</a></mj-text>', params: [] };
    const t = template(`<mj-text>Hi</mj-text>{% block '${footer.id}' %}`);
    await expect(validateTemplate(t)).resolves.toEqual([]);
    await expect(
      emailPublishProblems(t, { marketing: true, render: { blocks: (id) => (id === footer.id ? footer : null) } }),
    ).resolves.toEqual([]);
  });
});
