import type { EmailTemplate } from '@agentic-marketing/artifacts';
import { Parser } from 'htmlparser2';
import { describe, expect, it, vi } from 'vitest';
import { expectLinear } from '../../../test-support/linear';
import { emailPublishProblems } from '../src/checks';
import { validateTemplate } from '../src/render';
import { MAX_UNSUBSCRIBE_CHECK_MS, MAX_UNSUBSCRIBE_NESTING, unsubscribeLinkProblem } from '../src/unsubscribe';

// Review of #637 (P2): the gate only checked that an <a href> with the unsubscribe URL existed.
// A link nobody can see or click — inline display:none, an ancestor style, a <template>, or an
// empty anchor — passed and had no other publish blocker. The predicate must find a usable link
// and the gate must say why it refused one.

const URL = 'https://links.example.com/u/token';
const link = (attrs = '', text = 'Unsubscribe') => `<a href="${URL}"${attrs}>${text}</a>`;

const rejected: { name: string; html: string; reason: 'hidden' | 'empty' | 'missing' }[] = [
  // #775 and the 0.14.10 review: specificity decides before document order.
  {
    name: 'a repeated id outweighs a tag-and-id rule (0.14.10 review round 2)',
    html: `<html><head><style>a#footer{display:block} #footer#footer{display:none}</style></head><body><a id="footer" href="${URL}">Unsubscribe</a></body></html>`,
    reason: 'hidden',
  },
  {
    name: 'a repeated id rule placed before a single-id rule still wins',
    html: `<html><head><style>#footer#footer{display:none} #footer{display:block}</style></head><body><a id="footer" href="${URL}">Unsubscribe</a></body></html>`,
    reason: 'hidden',
  },
  {
    name: 'an id rule hides the link despite a later class rule that shows it',
    html: `<html><head><style>#x{display:none} .u{display:block}</style></head><body><a id="x" class="u" href="${URL}">Unsubscribe</a></body></html>`,
    reason: 'hidden',
  },
  {
    name: 'a class rule makes the text white on white despite a later tag rule',
    html: `<html><head><style>.f{color:#fff} a{color:#000}</style></head><body style="background:#fff"><a class="f" href="${URL}">Unsubscribe</a></body></html>`,
    reason: 'hidden',
  },
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
  // 0.14.9 review (P2): htmlparser2 12 parses these as raw text; browsers never render their content.
  { name: 'link text inside noembed', html: `<a href="${URL}"><noembed><span hidden>Unsubscribe</span></noembed></a>`, reason: 'empty' },
  { name: 'link text inside noframes', html: `<a href="${URL}"><noframes>Unsubscribe</noframes></a>`, reason: 'empty' },
  { name: 'link text inside iframe', html: `<a href="${URL}"><iframe>Unsubscribe</iframe></a>`, reason: 'empty' },
  // 0.14.9 review round 2 (P2): SVG title, desc and metadata are never rendered.
  { name: 'a link inside an SVG title', html: `<svg><title><a href="${URL}">Unsubscribe</a></title></svg>`, reason: 'hidden' },
  { name: 'a link inside an SVG desc', html: `<svg><desc><a href="${URL}">Unsubscribe</a></desc></svg>`, reason: 'hidden' },
  { name: 'a link inside SVG metadata', html: `<svg><metadata><a href="${URL}">Unsubscribe</a></metadata></svg>`, reason: 'hidden' },
  // 0.14.9 review round 3 (P2 and #707 P3s): nothing inside inline SVG or MathML counts.
  { name: 'a link inside an SVG textarea', html: `<svg><textarea><a href="${URL}">Unsubscribe</a></textarea></svg>`, reason: 'hidden' },
  { name: 'a link inside a MathML textarea', html: `<math><textarea><a href="${URL}">Unsubscribe</a></textarea></math>`, reason: 'hidden' },
  { name: 'a link inside SVG defs', html: `<svg><defs><a href="${URL}">Unsubscribe</a></defs></svg>`, reason: 'hidden' },
  {
    name: 'a link inside an SVG clipPath',
    html: `<svg><clipPath><a href="${URL}"><text>Unsubscribe</text></a></clipPath></svg>`,
    reason: 'hidden',
  },
  {
    name: 'a link inside a MathML annotation',
    html: `<math><annotation-xml><a href="${URL}">Unsubscribe</a></annotation-xml></math>`,
    reason: 'hidden',
  },
  {
    name: 'a link inside SVG foreignObject',
    html: `<svg><foreignObject><a href="${URL}">Unsubscribe</a></foreignObject></svg>`,
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
  // #746: opacity, font-size and colour rules are applied through the same cascade as display and
  // background, with the same tag/class/id selector support.
  {
    name: 'a class rule with opacity:0',
    html: `<html><head><style>.h { opacity: 0; }</style></head><body>${link(' class="h"')}</body></html>`,
    reason: 'hidden',
  },
  {
    name: 'an id rule with opacity:0',
    html: `<html><head><style>#h { opacity: 0; }</style></head><body>${link(' id="h"')}</body></html>`,
    reason: 'hidden',
  },
  {
    name: 'a tag rule with opacity:0',
    html: `<html><head><style>a { opacity: 0; }</style></head><body>${link()}</body></html>`,
    reason: 'hidden',
  },
  {
    name: 'a class rule with font-size:0',
    html: `<html><head><style>.h { font-size: 0; }</style></head><body>${link(' class="h"')}</body></html>`,
    reason: 'hidden',
  },
  {
    name: 'an id rule with font-size:0',
    html: `<html><head><style>#h { font-size: 0; }</style></head><body>${link(' id="h"')}</body></html>`,
    reason: 'hidden',
  },
  {
    name: 'a tag rule with font-size:0',
    html: `<html><head><style>a { font-size: 0; }</style></head><body>${link()}</body></html>`,
    reason: 'hidden',
  },
  {
    name: 'a class rule with colour:transparent',
    html: `<html><head><style>.h { color: transparent; }</style></head><body>${link(' class="h"')}</body></html>`,
    reason: 'hidden',
  },
  {
    name: 'an id rule with colour:transparent',
    html: `<html><head><style>#h { color: transparent; }</style></head><body>${link(' id="h"')}</body></html>`,
    reason: 'hidden',
  },
  {
    name: 'a tag rule with colour:transparent',
    html: `<html><head><style>a { color: transparent; }</style></head><body>${link()}</body></html>`,
    reason: 'hidden',
  },
  {
    name: 'a class rule with white text and a white background',
    html: `<html><head><style>.h { color: white; background: white; }</style></head><body>${link(' class="h"')}</body></html>`,
    reason: 'hidden',
  },
  {
    name: 'an important opacity rule over an inline opacity:1',
    html: `<html><head><style>.h { opacity: 0 !important; }</style></head><body>${link(' class="h" style="opacity:1"')}</body></html>`,
    reason: 'hidden',
  },
  {
    name: 'an important font-size rule over an inline font size',
    html: `<html><head><style>.h { font-size: 0 !important; }</style></head><body>${link(' class="h" style="font-size:13px"')}</body></html>`,
    reason: 'hidden',
  },
  {
    name: 'an important colour rule over an inline colour',
    html: `<html><head><style>.h { color: transparent !important; }</style></head><body>${link(' class="h" style="color:#111827"')}</body></html>`,
    reason: 'hidden',
  },
  {
    name: 'an important opacity hide over a later normal unhide',
    html: `<html><head><style>.a { opacity: 0 !important; } .b { opacity: 1; }</style></head><body>${link(' class="a b"')}</body></html>`,
    reason: 'hidden',
  },
  {
    name: 'an important font-size hide then a later normal declaration in the same rule',
    html: `<html><head><style>.h { font-size: 0 !important; font-size: 13px; }</style></head><body>${link(' class="h"')}</body></html>`,
    reason: 'hidden',
  },
  {
    name: 'a later normal colour rule that hides',
    html: `<html><head><style>.a { color: #111827; } .b { color: transparent; }</style></head><body>${link(' class="a b"')}</body></html>`,
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

  // #746: the same cascade applies to opacity, font-size and colour rules. An inline declaration
  // beats a normal rule, an inline !important beats an important rule, and a later normal
  // declaration wins inside a rule.
  it('accepts an inline opacity:1 over a normal opacity rule', () => {
    const html = `<html><head><style>.h { opacity: 0; }</style></head><body>${link(' class="h" style="opacity:1"')}</body></html>`;
    expect(unsubscribeLinkProblem(html, URL)).toBeNull();
  });

  it('accepts an inline font size over a normal font-size:0 rule', () => {
    const html = `<html><head><style>.h { font-size: 0; }</style></head><body>${link(' class="h" style="font-size:13px"')}</body></html>`;
    expect(unsubscribeLinkProblem(html, URL)).toBeNull();
  });

  it('accepts an inline colour over a normal transparent colour rule', () => {
    const html = `<html><head><style>.h { color: transparent; }</style></head><body>${link(' class="h" style="color:#111827"')}</body></html>`;
    expect(unsubscribeLinkProblem(html, URL)).toBeNull();
  });

  it('accepts an inline !important over an important hiding rule', () => {
    const html = `<html><head><style>.h { opacity: 0 !important; }</style></head><body>${link(' class="h" style="opacity:1 !important"')}</body></html>`;
    expect(unsubscribeLinkProblem(html, URL)).toBeNull();
  });

  it('accepts an opacity rule that a later normal rule overrides', () => {
    const html = `<html><head><style>.a { opacity: 0; } .b { opacity: 1; }</style></head><body>${link(' class="a b"')}</body></html>`;
    expect(unsubscribeLinkProblem(html, URL)).toBeNull();
  });

  it('accepts the later normal declaration inside one opacity rule', () => {
    const html = `<html><head><style>.h { opacity: 0; opacity: 1; }</style></head><body>${link(' class="h"')}</body></html>`;
    expect(unsubscribeLinkProblem(html, URL)).toBeNull();
  });

  it('accepts a zero font-size rule on the anchor when the text resets it', () => {
    const html = `<html><head><style>.h { font-size: 0; }</style></head><body><a class="h" href="${URL}"><span style="font-size:13px">Unsubscribe</span></a></body></html>`;
    expect(unsubscribeLinkProblem(html, URL)).toBeNull();
  });

  it('accepts a white colour rule on a black background', () => {
    const html = `<html><head><style>.h { color: white; }</style></head><body><div style="background:#000">${link(' class="h"')}</div></body></html>`;
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
    expect(unsubscribeLinkProblem(deep, URL)).toBe('too_complex');
    const fine = `${'<div>'.repeat(60)}<a href="${URL}">Unsubscribe</a>${'</div>'.repeat(60)}`;
    expect(unsubscribeLinkProblem(fine, URL)).toBeNull();
  });

  it('pause() stops the parser at the nesting limit (review round 6)', () => {
    // The predicate rejects a document one level past the limit either way, so it cannot show
    // whether the rest of the document was parsed. This mirrors the check's parser and options:
    // once the 513th tag opens, no further open or text callback may run.
    let opened = 0;
    let text = 0;
    const parser = new Parser(
      {
        onopentag() {
          opened++;
          if (opened > MAX_UNSUBSCRIBE_NESTING) parser.pause();
        },
        ontext() {
          text++;
        },
      },
      { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
    );
    parser.write(`${'<div>'.repeat(MAX_UNSUBSCRIBE_NESTING + 50)}${'<span>text</span>'.repeat(50)}`);
    expect(opened).toBe(MAX_UNSUBSCRIBE_NESTING + 1);
    expect(text).toBe(0);
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

  it('stays linear for many opacity, font-size and colour rules and many elements (#746)', () => {
    // Each rule's value is long and matches many elements: parsing it per element would be
    // quadratic. The value is parsed once per declaration, like backgrounds since review round 7.
    expectLinear(
      (n) => {
        const value = `0.${'0'.repeat(n)}`;
        const style = `.o{opacity:${value}}.f{font-size:${value}em}.c{color:rgb(${value},0,0)}`;
        return `<html><head><style>${style}</style></head><body>${'<div class="o f c">x</div>'.repeat(n)}<a href="${URL}">Unsubscribe</a></body></html>`;
      },
      (html) => unsubscribeLinkProblem(html, URL),
      2_000,
    );
    // Many distinct rules and many elements: matching each new bucket stays a map lookup per
    // class, and the three declarations are parsed once per rule.
    expectLinear(
      (n) => {
        const style = Array.from({ length: n }, (_, i) => `.x${i}{opacity:1;font-size:13px;color:#111827}`).join('');
        const divs = Array.from({ length: n }, (_, i) => `<div class="x${i}">x</div>`).join('');
        return `<html><head><style>${style}</style></head><body>${divs}<a href="${URL}">Unsubscribe</a></body></html>`;
      },
      (html) => unsubscribeLinkProblem(html, URL),
      2_000,
    );
  });

  it('stops and rejects once the check runs past its time budget (review round 8)', () => {
    let now = 0;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => {
      now += MAX_UNSUBSCRIBE_CHECK_MS / 4;
      return now;
    });
    try {
      const html = `${'<div>x</div>'.repeat(20)}<a href="${URL}">Unsubscribe</a>`;
      expect(unsubscribeLinkProblem(html, URL)).toBe('too_complex');
    } finally {
      spy.mockRestore();
    }
    expect(unsubscribeLinkProblem(`<a href="${URL}">Unsubscribe</a>`, URL)).toBeNull();
  });

  it('stays linear for many entities inside a link with long style values (review round 9)', () => {
    expectLinear(
      (n) => {
        const x = 'x'.repeat(n);
        return `<a href="${URL}" style="color:rgb(${x}b);background:rgb(${x}c)">${'&amp;'.repeat(n)}</a>`;
      },
      (html) => unsubscribeLinkProblem(html, URL),
      20_000,
    );
  });

  it('checks the time budget inside text, not only at opening tags (review round 9)', () => {
    let calls = 0;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => {
      calls++;
      // The first calls (start, style pass, the anchor's opening tag) stay within the budget.
      return calls <= 3 ? 0 : MAX_UNSUBSCRIBE_CHECK_MS * 2;
    });
    try {
      expect(unsubscribeLinkProblem(`<a href="${URL}">${'&amp;'.repeat(50)}</a>`, URL)).toBe('too_complex');
    } finally {
      spy.mockRestore();
    }
  });

  it('still recognises a long but valid colour (review round 10)', () => {
    expect(unsubscribeLinkProblem(link(` style="color:rgba(0,0,0,${' '.repeat(60)}0)"`), URL)).toBe('hidden');
    expect(unsubscribeLinkProblem(link(` style="color:rgba(0,0,0,0.${'0'.repeat(80)})"`), URL)).toBe('hidden');
    expect(unsubscribeLinkProblem(link(` style="color:rgb(${' '.repeat(80)}0,0,0)"`), URL)).toBeNull();
  });

  it('still applies a compound hiding rule in a normal stylesheet', () => {
    const html = `<html><head><style>.foot.gone{display:none}</style></head><body><a class="foot gone" href="${URL}">Unsubscribe</a></body></html>`;
    expect(unsubscribeLinkProblem(html, URL)).toBe('hidden');
  });
});

// The href is compared after HTML entity decoding, because that is the URL a reader clicks. A
// template that encodes the ampersand twice produces a different (literal) URL, so it must not be
// treated as the rendered unsubscribe URL, and a malformed entity must never make the check throw.
describe('the unsubscribe link is compared after one round of entity decoding', () => {
  const withQuery = (html: string) => `<p><a href="${html}">Unsubscribe</a></p>`;

  it('decodes a single-encoded ampersand', () => {
    expect(unsubscribeLinkProblem(withQuery(`${URL}?a=1&amp;b=2`), `${URL}?a=1&b=2`)).toBeNull();
  });

  it('decodes numeric and hexadecimal character references', () => {
    expect(unsubscribeLinkProblem(withQuery(`${URL}?a=1&#38;b=2`), `${URL}?a=1&b=2`)).toBeNull();
    expect(unsubscribeLinkProblem(withQuery(`${URL}?a=1&#x26;b=2`), `${URL}?a=1&b=2`)).toBeNull();
  });

  // Double encoding is not decoded twice: `&amp;amp;` is the literal text `&amp;` in the href.
  it('does not decode a double-encoded ampersand a second time', () => {
    expect(unsubscribeLinkProblem(withQuery(`${URL}?a=1&amp;amp;b=2`), `${URL}?a=1&b=2`)).toBe('missing');
    expect(unsubscribeLinkProblem(withQuery(`${URL}?a=1&amp;amp;b=2`), `${URL}?a=1&amp;b=2`)).toBeNull();
  });

  it('treats a malformed entity literally instead of failing the check', () => {
    // `&#;` and an unknown named reference are not character references; both stay as written.
    expect(unsubscribeLinkProblem(withQuery(`${URL}?a=1&#;b=2`), `${URL}?a=1&#;b=2`)).toBeNull();
    expect(unsubscribeLinkProblem(withQuery(`${URL}?a=1&#;b=2`), `${URL}?a=1&b=2`)).toBe('missing');
    expect(unsubscribeLinkProblem(withQuery(`${URL}?a=1&notanentity;b=2`), `${URL}?a=1&notanentity;b=2`)).toBeNull();
    expect(unsubscribeLinkProblem(withQuery(`${URL}?a=1&notanentity;b=2`), `${URL}?a=1&b=2`)).toBe('missing');
  });

  it('decodes the legacy semicolon-less ampersand the way a browser does', () => {
    expect(unsubscribeLinkProblem(withQuery(`${URL}?a=1&amp b=2`), `${URL}?a=1& b=2`)).toBeNull();
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

  it('rejects a link whose only text is inside noembed at save and at publish as empty (0.14.9 review)', async () => {
    // Content inside noembed is never rendered, so the link has no text a reader can see.
    const t = template('<mj-text><a href="{{ unsubscribe_url }}"><noembed><span hidden>Unsubscribe</span></noembed></a></mj-text>');
    expect((await validateTemplate(t)).join(' ')).toContain('no text');
    expect((await emailPublishProblems(t, { marketing: true })).join(' ')).toContain('no text');
  });

  it('rejects a link inside an SVG title at save and at publish (0.14.9 review round 2)', async () => {
    const t = template('<mj-text><svg><title><a href="{{ unsubscribe_url }}">Unsubscribe</a></title></svg></mj-text>');
    expect(await validateTemplate(t)).not.toEqual([]);
    expect(await emailPublishProblems(t, { marketing: true })).not.toEqual([]);
  });

  it('rejects a link inside an SVG textarea at save and at publish (0.14.9 review round 3)', async () => {
    const t = template('<mj-text><svg><textarea><a href="{{ unsubscribe_url }}">Unsubscribe</a></textarea></svg></mj-text>');
    expect(await validateTemplate(t)).not.toEqual([]);
    expect(await emailPublishProblems(t, { marketing: true })).not.toEqual([]);
  });

  it('still accepts a visible footer link next to an inline SVG icon', async () => {
    const t = template(
      '<mj-text><svg width="12" height="12"><circle r="6" /></svg> <a href="{{ unsubscribe_url }}">Unsubscribe</a></mj-text>',
    );
    expect(await validateTemplate(t)).toEqual([]);
  });

  it('ignores a selector that names two different ids, which matches nothing', () => {
    const html = `<html><head><style>#a#footer{display:none}</style></head><body><a id="footer" href="${URL}">Unsubscribe</a></body></html>`;
    expect(unsubscribeLinkProblem(html, URL)).toBeNull();
  });

  it('keeps a footer visible when a more specific rule gives it a dark colour (0.14.10 review)', () => {
    const html = `<html><head><style>#footer{color:black} a{color:white}</style></head><body style="background:#fff"><a id="footer" href="${URL}">Unsubscribe</a></body></html>`;
    expect(unsubscribeLinkProblem(html, URL)).toBeNull();
    const shown = `<html><head><style>#x{display:block} a{display:none}</style></head><body><a id="x" href="${URL}">Unsubscribe</a></body></html>`;
    expect(unsubscribeLinkProblem(shown, URL)).toBeNull();
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

  // #746: a simple <style> rule that hides by opacity, font-size or colour is refused at save and
  // at publish, for tag, class and id selectors.
  const ruleHides: { name: string; css: string; attrs: string }[] = [
    { name: 'a class opacity rule', css: '.h { opacity: 0; }', attrs: ' class="h"' },
    { name: 'an id opacity rule', css: '#h { opacity: 0; }', attrs: ' id="h"' },
    { name: 'a tag opacity rule', css: 'a { opacity: 0; }', attrs: '' },
    { name: 'a class font-size rule', css: '.h { font-size: 0; }', attrs: ' class="h"' },
    { name: 'an id font-size rule', css: '#h { font-size: 0; }', attrs: ' id="h"' },
    { name: 'a tag font-size rule', css: 'a { font-size: 0; }', attrs: '' },
    { name: 'a class colour rule', css: '.h { color: transparent; }', attrs: ' class="h"' },
    { name: 'an id colour rule', css: '#h { color: transparent; }', attrs: ' id="h"' },
    { name: 'a tag colour rule', css: 'a { color: transparent; }', attrs: '' },
  ];

  it.each(ruleHides)('rejects $name at save and at publish (#746)', async ({ css, attrs }) => {
    const t = template(`<mj-text><a${attrs} href="{{ unsubscribe_url }}">Unsubscribe</a></mj-text>`, `<mj-style>${css}</mj-style>`);
    expect((await validateTemplate(t)).join(' ')).toContain('hidden');
    expect((await emailPublishProblems(t, { marketing: true })).join(' ')).toContain('hidden');
  });

  const importantHides: { name: string; rule: string; inline: string }[] = [
    { name: 'opacity', rule: 'opacity: 0 !important', inline: 'opacity: 1' },
    { name: 'font-size', rule: 'font-size: 0 !important', inline: 'font-size: 13px' },
    { name: 'colour', rule: 'color: transparent !important', inline: 'color: #111827' },
  ];

  it.each(importantHides)(
    'rejects an important $name rule over an inline value at save and at publish (#746)',
    async ({ rule, inline }) => {
      const t = template(
        `<mj-text><a class="h" style="${inline}" href="{{ unsubscribe_url }}">Unsubscribe</a></mj-text>`,
        `<mj-style>.h { ${rule}; }</mj-style>`,
      );
      expect((await validateTemplate(t)).join(' ')).toContain('hidden');
      expect((await emailPublishProblems(t, { marketing: true })).join(' ')).toContain('hidden');
    },
  );

  it.each(importantHides)('accepts an inline $name over a normal rule at save and at publish (#746)', async ({ rule, inline }) => {
    const normal = rule.replace(' !important', '');
    const t = template(
      `<mj-text><a class="h" style="${inline}" href="{{ unsubscribe_url }}">Unsubscribe</a></mj-text>`,
      `<mj-style>.h { ${normal}; }</mj-style>`,
    );
    await expect(validateTemplate(t)).resolves.toEqual([]);
    await expect(emailPublishProblems(t, { marketing: true })).resolves.toEqual([]);
  });

  it('accepts a zero font-size rule when the text resets it at save and at publish (#746)', async () => {
    const t = template(
      '<mj-text><a class="h" href="{{ unsubscribe_url }}"><span style="font-size:13px">Unsubscribe</span></a></mj-text>',
      '<mj-style>.h { font-size: 0; }</mj-style>',
    );
    await expect(validateTemplate(t)).resolves.toEqual([]);
    await expect(emailPublishProblems(t, { marketing: true })).resolves.toEqual([]);
  });

  it('accepts a footer whose rules set visible opacity, font size and colour (#746)', async () => {
    const t = template(
      '<mj-text><a class="footer" href="{{ unsubscribe_url }}">Unsubscribe</a></mj-text>',
      '<mj-style>.footer { opacity: 1; font-size: 13px; color: #111827; }</mj-style>',
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
