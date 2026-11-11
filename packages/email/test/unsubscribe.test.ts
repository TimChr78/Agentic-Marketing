import type { EmailTemplate } from '@agentic-marketing/artifacts';
import { describe, expect, it } from 'vitest';
import { emailPublishProblems } from '../src/checks';
import { validateTemplate } from '../src/render';
import { unsubscribeLinkProblem } from '../src/unsubscribe';

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
];

describe('the unsubscribe link must be visible and clickable (#637 review)', () => {
  it.each(rejected)('rejects $name with the reason $reason', ({ html, reason }) => {
    expect(unsubscribeLinkProblem(html, URL)).toBe(reason);
  });

  it('accepts a normal visible text link', () => {
    expect(unsubscribeLinkProblem(`<p>${link()}</p>`, URL)).toBeNull();
  });

  it('accepts an image link with alt text', () => {
    expect(unsubscribeLinkProblem(`<p><a href="${URL}"><img src="x.png" alt="Unsubscribe"></a></p>`, URL)).toBeNull();
  });

  it('accepts a link whose colour differs from its background', () => {
    expect(unsubscribeLinkProblem(link(' style="color:#111827;background-color:#ffffff"'), URL)).toBeNull();
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

  it('rejects a link hidden by an mj-style class rule', async () => {
    const t = template(
      '<mj-text><a class="gone" href="{{ unsubscribe_url }}">Unsubscribe</a></mj-text>',
      '<mj-style>.gone { display: none; }</mj-style>',
    );
    expect((await validateTemplate(t)).join(' ')).toContain('hidden');
    expect((await emailPublishProblems(t, { marketing: true })).join(' ')).toContain('hidden');
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
