import { describe, expect, it } from 'vitest';
import { tagLinks, tagTextLinks, trackLinks, type Utm } from '../src/links';
import { renderTemplate } from '../src/render';

const utm: Utm = { source: 'newsletter', medium: 'email', campaign: 'welcome', domains: ['shop.example.com'] };
const own = 'https://m.example.com/u/token';
const skip = ['https://m.example.com'];

const template = {
  purpose: 'marketing_email',
  subject: 'Welcome',
  mjml: `<mjml><mj-body><mj-section><mj-column>
    <mj-text>Browse <a href="https://shop.example.com/tools/">the tool directory</a>.</mj-text>
    <mj-text><a href="https://other.example.com/x">Elsewhere</a></mj-text>
    <mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text>
  </mj-column></mj-section></mj-body></mjml>`,
  utm,
};

describe('UTM tags in the HTML and text parts', () => {
  it('tags the generated text part with the same rules as the HTML part', async () => {
    const rendered = await renderTemplate(template, { unsubscribe_url: own });
    const html = tagLinks(rendered.html, utm, skip);
    const text = tagTextLinks(rendered.text, utm, skip);

    expect(html).toContain('https://shop.example.com/tools/?utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=welcome');
    expect(text).toContain('https://shop.example.com/tools/?utm_source=newsletter&utm_medium=email&utm_campaign=welcome');
    // A link outside `domains`, the platform's own link and an already-tagged link stay as they are.
    expect(html).not.toContain('other.example.com/x?utm_');
    expect(text).not.toContain('other.example.com/x?utm_');
    expect(text).not.toContain(`${own}?utm_`);
  });

  // #638: MJML passes raw HTML inside mj-text through as written, so `<a href='…'>` and
  // `<a href=…>` reached the sent e-mail untagged and untracked. Only the double-quoted form
  // worked, because both rewriters matched the literal `href="`.
  it('tags and tracks single-quoted and unquoted hrefs, and leaves double-quoted output unchanged', () => {
    const wrap = (url: string) => `https://m.example.com/c/tok?u=${encodeURIComponent(url)}`;
    const double = '<a href="https://shop.example.com/double">Double</a>';
    const single = "<a href='https://shop.example.com/single'>Single</a>";
    const bare = '<a href=https://shop.example.com/bare>Bare</a>';
    const html = `${double}${single}${bare}`;

    // Exactly what the previous double-quoted regex produced: byte for byte.
    expect(tagLinks(double, utm, skip)).toBe(
      '<a href="https://shop.example.com/double?utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=welcome">Double</a>',
    );
    expect(trackLinks(double, wrap, skip)).toBe(`<a href="${wrap('https://shop.example.com/double')}">Double</a>`);

    const tagged = tagLinks(html, utm, skip);
    expect(tagged).toContain("href='https://shop.example.com/single?utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=welcome'");
    // An unquoted value cannot hold "=", so a tagged link is emitted double-quoted.
    expect(tagged).toContain('href="https://shop.example.com/bare?utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=welcome"');

    const tracked = trackLinks(html, wrap, skip);
    expect(tracked).toContain(`href='${wrap('https://shop.example.com/single')}'`);
    expect(tracked).toContain(`href="${wrap('https://shop.example.com/bare')}"`);
  });

  it('leaves skipped schemes, platform links and non-http hrefs alone in every quoting style', () => {
    const wrap = (url: string) => `https://m.example.com/c/tok?u=${encodeURIComponent(url)}`;
    const html =
      "<a href='mailto:hi@example.com'>Mail</a>" +
      '<a href=tel:+4512345678>Call</a>' +
      '<a href="{{ unsubscribe_url }}">Liquid</a>' +
      "<a href='https://m.example.com/u/token'>Own</a>" +
      '<a href="/relative">Relative</a>';

    expect(tagLinks(html, utm, skip)).toBe(html);
    expect(trackLinks(html, wrap, skip)).toBe(html);
  });

  it('tags a hand-written text part, keeping brackets and trailing punctuation outside the URL', async () => {
    const rendered = await renderTemplate(
      {
        ...template,
        text: `Browse https://shop.example.com/tools/. Or [https://shop.example.com/tools/?x=1].
Elsewhere https://other.example.com/x, own ${own}.
Already tagged https://shop.example.com/x?utm_source=old&utm_medium=email.
A bracket URL (https://shop.example.com/a_(b)).`,
      },
      { unsubscribe_url: own },
    );
    const text = tagTextLinks(rendered.text, utm, skip);

    expect(text).toContain('Browse https://shop.example.com/tools/?utm_source=newsletter&utm_medium=email&utm_campaign=welcome.');
    expect(text).toContain('[https://shop.example.com/tools/?x=1&utm_source=newsletter&utm_medium=email&utm_campaign=welcome]');
    expect(text).toContain('Elsewhere https://other.example.com/x, own https://m.example.com/u/token.');
    expect(text).toContain('Already tagged https://shop.example.com/x?utm_source=old&utm_medium=email.');
    // The outer parenthesis is punctuation; the matching one inside the URL stays.
    expect(text).toContain('(https://shop.example.com/a_(b)?utm_source=newsletter&utm_medium=email&utm_campaign=welcome).');
  });
});
