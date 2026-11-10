import { readFileSync } from 'node:fs';
import type { Brand } from '@agentic-marketing/artifacts';
import { resolveBrand } from '@agentic-marketing/artifacts';
import { renderTemplate } from '@agentic-marketing/email';
import { type DefaultTreeAdapterTypes, parse, parseFragment } from 'parse5';
import { describe, expect, it } from 'vitest';
import { expectLinear } from '../../../test-support/linear';
import { activeUrl, emailParts, MAX_EMAIL_NESTING, renderWebVersion, sanitiseEmailBody, scanEmailBody } from '../src/archive';

// CodeQL alerts 4, 3, 2 and 1 (js/bad-tag-filter, js/incomplete-multi-character-sanitization):
// the public archive renders e-mail HTML behind a strict CSP, and `emailParts` is the defence in
// depth. The scanner must be linear, quote-aware and safe on hostile entities.
const body = (html: string) => emailParts(`<style>.issue{color:#111827}</style><body>${html}</body>`).body;

/**
 * What `origin/main` produced for benign input. Its script and handler regexes never matched the
 * benign corpus below (no active elements, no `on*` attributes), so on that input the old output is
 * exactly body/style extraction plus 1×1-pixel removal. Keeping only those steps lets the
 * differential test run without re-adding the regexes CodeQL flags.
 */
function benignReference(html: string): { body: string; styles: string } {
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  const extracted = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  const pixel =
    /<img\b[^>]*(?:(?:width\s*=\s*["']?1(?:px)?["']?[\s\S]*?height\s*=\s*["']?1(?:px)?["']?)|(?:height\s*=\s*["']?1(?:px)?["']?[\s\S]*?width\s*=\s*["']?1(?:px)?["']?))[^>]*>/gi;
  return { body: extracted.replace(pixel, ''), styles };
}

/** The corpus really is benign where it is sanitised (the body), so the reference is the old behaviour. */
const isBenign = (html: string) => {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  return !/<\/?(?:script|iframe|object|embed|frame|applet|base|meta)\b/i.test(body) && !/[\s/"']on[a-z]+\s*=/i.test(body);
};

const ACTIVE_ELEMENTS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'frame',
  'frameset',
  'applet',
  'base',
  // SMIL can retarget an href/xlink:href to javascript: at runtime (#579).
  'animate',
  'set',
  'animatetransform',
  'animatemotion',
  'discard',
]);
const ACTIVE_URL_ATTRIBUTES = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'background', 'poster', 'data', 'srcset']);

/**
 * What a spec-compliant parser with scripting enabled sees in the output. This is deliberately
 * parse5 and not a regex: the hand-written scanner and the browser disagree on cases such as
 * stray quotes in attribute names, unterminated openers and `</noscript>` closing raw text.
 */
function activeContent(html: string): string[] {
  const fragment = parseFragment(html, { scriptingEnabled: true });
  const found: string[] = [];
  const walk = (parent: DefaultTreeAdapterTypes.ParentNode): void => {
    for (const node of parent.childNodes) {
      if (!('tagName' in node)) continue;
      const element = node as DefaultTreeAdapterTypes.Element;
      const name = element.tagName.toLowerCase();
      if (ACTIVE_ELEMENTS.has(name)) found.push(`<${name}>`);
      if (
        name === 'meta' &&
        element.attrs.some((a) => a.name.toLowerCase() === 'http-equiv' && a.value.trim().toLowerCase() === 'refresh')
      ) {
        found.push('<meta http-equiv="refresh">');
      }
      for (const attribute of element.attrs) {
        const attributeName = attribute.name.toLowerCase();
        if (attributeName.startsWith('on')) found.push(`${name}[${attributeName}]`);
        else if (ACTIVE_URL_ATTRIBUTES.has(attributeName) && activeUrl(attribute.value)) found.push(`${name}[${attributeName}]`);
      }
      if (name === 'template') walk((element as DefaultTreeAdapterTypes.Template).content);
      walk(element);
    }
  };
  walk(fragment);
  return found;
}

const expectInert = (html: string) => {
  expect(activeContent(html), html).toEqual([]);
};

describe('archive e-mail body sanitising', () => {
  it.each([
    ['space before the end tag', '<script>alert(1)</script ><p>ok</p>'],
    ['newline before the end tag', '<script>alert(1)</script\n><p>ok</p>'],
    ['uppercase tag names', '<SCRIPT>alert(1)</SCRIPT ><p>ok</p>'],
  ])('neutralises a script block with %s', (_label, html) => {
    const out = body(html);

    expect(out.toLowerCase()).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('<p>ok</p>');
  });

  it('neutralises unquoted event handlers', () => {
    const out = body('<img src="photo.jpg" onload=alert(1)><p>ok</p>');

    expect(out.toLowerCase()).not.toContain('onload');
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('<img src="photo.jpg"');
    expect(out).toContain('<p>ok</p>');
  });

  it('neutralises a nested script tag that reappears after one pass', () => {
    const out = body('<p>ok</p><scr<script>ipt>alert(1)</scr<script>ipt>');

    expect(out.toLowerCase()).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('<p>ok</p>');
  });

  it('removes dangerous embedded elements and javascript: URLs', () => {
    const out = body(
      '<iframe src="https://evil.example"></iframe><object data="x"></object><embed src="x">' +
        '<a href="javascript:alert(1)">bad</a><img src="javascript:alert(1)">',
    );

    expect(out.toLowerCase()).not.toContain('<iframe');
    expect(out.toLowerCase()).not.toContain('<object');
    expect(out.toLowerCase()).not.toContain('<embed');
    expect(out.toLowerCase()).not.toContain('javascript:');
  });

  it('keeps ordinary newsletter markup byte-identical', () => {
    const newsletter =
      '<table role="presentation" style="width:100%"><tr><td style="padding:24px">' +
      '<h1 style="margin:0">Hello</h1><p>Read <a href="https://example.com/story">the story</a>.</p>' +
      '<img src="https://example.com/photo.jpg" alt="A photo" width="600"></td></tr></table>';

    expect(body(newsletter)).toBe(newsletter);
  });

  it('does not confuse prose containing "on" with an event handler', () => {
    expect(body('<p>Click on the button or hang on.</p>')).toContain('Click on the button or hang on.');
  });

  it('still removes a 1×1 tracking pixel', () => {
    const out = body('<img src="https://track.example/open.gif" width="1" height="1" alt=""><p>ok</p>');

    expect(out).not.toContain('track.example');
    expect(out).toContain('<p>ok</p>');
  });
});

describe('archive sanitising: separator and scheme obfuscation (integrator review)', () => {
  const body = (inner: string) => emailParts(`<html><body>${inner}</body></html>`).body;

  it('removes handlers that follow a slash or a closing quote instead of whitespace', () => {
    for (const payload of ['<img/onerror=alert(1) src=x>', '<img src="x"onerror="alert(1)">', "<svg/onload='alert(1)'>"]) {
      expect(body(payload).toLowerCase(), payload).not.toMatch(/on(error|load)\s*=/);
    }
  });

  it('removes javascript: URLs hidden with whitespace, control characters or numeric entities', () => {
    for (const payload of [
      '<a href="java\tscript:alert(1)">x</a>',
      '<a href=" java\nscript:alert(1)">x</a>',
      '<a href="jav&#x09;ascript:alert(1)">x</a>',
      '<a href="&#106;avascript:alert(1)">x</a>',
      '<a href="JaVaScRiPt:alert(1)">x</a>',
    ]) {
      expect(body(payload), payload).not.toMatch(/href\s*=/i);
    }
  });

  it('keeps ordinary links and attributes that merely start with "on"', () => {
    const html = '<a href="https://example.com/one" class="online">Read</a>';
    expect(body(html)).toBe(html);
  });
});

describe('archive sanitising: linear time', () => {
  // Scaling rather than a fixed millisecond limit: the same linear code is many times slower on
  // a shared CI runner, which made absolute budgets flaky.
  const cases: [string, (n: number) => string, number][] = [
    ['unclosed iframes', (n) => '<iframe>'.repeat(n), 16_000],
    ['unclosed scripts', (n) => '<script>'.repeat(n), 16_000],
    ['unterminated quoted attributes', (n) => '<a href="'.repeat(n), 20_000],
    ['lone "<" characters', (n) => '<'.repeat(n), 100_000],
    ['repeated unterminated tags', (n) => '<a '.repeat(n), 40_000],
    ['one unterminated tag with many attributes', (n) => `<p ${'a="x" '.repeat(n)}`, 20_000],
  ];

  it.each(cases)('sanitises %s in linear time', (_label, build, base) => {
    expectLinear(build, body, base);
  });
});

describe('archive sanitising: the linear-time helper', () => {
  it('detects a deliberately quadratic function', () => {
    let sink = 0;
    const quadratic = (input: string) => {
      let count = 0;
      for (let i = 0; i < input.length; i++) {
        for (let j = 0; j < input.length; j++) count++;
      }
      sink = count;
    };

    expect(() => expectLinear((n) => 'x'.repeat(n), quadratic, 2_000)).toThrow(/expected linear scaling/);
    expect(sink).toBeGreaterThan(0);
  });
});

describe('archive sanitising: style/body/pixel extraction is linear (#574, #577)', () => {
  // These builders are what the old extraction regexes backtracked over: an opener with no close.
  // `emailParts` itself is timed because the extraction runs before `sanitiseEmailBody`.
  const cases: [string, (n: number) => string, number][] = [
    ['repeated unterminated <img openers', (n) => '<img'.repeat(n), 4_000],
    ['repeated unterminated <style openers', (n) => '<style'.repeat(n), 2_000],
    ['repeated unterminated <body openers', (n) => '<body'.repeat(n), 2_000],
    // The exact #577 shape: one <img followed by many width=1 height=1 pairs and no ">".
    ['one unterminated img with many width/height pairs (#577)', (n) => `<img${' width=1 height=1'.repeat(n)}`, 200],
  ];

  it.each(cases)('extracts %s in linear time', (_label, build, base) => {
    expectLinear(build, emailParts, base);
  });
});

describe('archive sanitising: numeric entities never throw', () => {
  it.each(['&#99999999;', '&#xFFFFFFFF;', '&#xD800;', '&#0;'])('does not throw on %s in an href', (entity) => {
    expect(() => body(`<a href="${entity}">x</a>`)).not.toThrow();
  });
});

describe('archive sanitising: meta refresh', () => {
  it.each([
    '<meta http-equiv="refresh" content="0;url=https://evil.example/">',
    '<META HTTP-EQUIV="Refresh">',
    '<meta http-equiv = refresh >',
    '<meta http-equiv=\'REFRESH\' content="0">',
    '<meta http-equiv="ref&#114;esh" content="0;url=https://evil.example/">',
    '<meta\thttp-equiv\t=\n" refresh "\t/>',
  ])('removes %s', (html) => {
    const out = body(html);

    expect(out.toLowerCase()).not.toContain('http-equiv');
    expect(out).not.toContain('evil.example');
  });

  it('keeps a benign meta tag byte-identical', () => {
    const html = '<meta name="x" content="y">';
    expect(body(html)).toBe(html);
  });
});

describe('archive sanitising: attribute context', () => {
  it('leaves handler-like text inside an attribute value alone', () => {
    const html = '<p title=" onload=hello ">x</p>';
    expect(body(html)).toBe(html);
  });

  it('does not end a tag at a ">" inside a quoted value', () => {
    const html = '<p title="a > b">x</p>';
    expect(body(html)).toBe(html);
  });
});

describe('archive sanitising: attacks neutralised', () => {
  it.each([
    ['handler directly after a quote', '<img src="x"onerror=alert(1)>', /onerror\s*=/i],
    ['handler after a slash', '<img/onerror=alert(1)>', /onerror\s*=/i],
    ['handler on an SVG child', '<svg><animate onbegin=alert(1)></svg>', /onbegin\s*=/i],
  ])('drops a %s', (_label, html, pattern) => {
    const out = body(html);

    expect(out).not.toMatch(pattern);
    expect(out).not.toContain('alert(1)');
  });

  it.each([
    ['named colon entity', '<a href="javascript&colon;alert(1)">x</a>', /href\s*=/i],
    ['numeric tab entity', '<a href="jav&#x09;ascript:alert(1)">x</a>', /href\s*=/i],
    ['xlink:href', '<a xlink:href="javascript:alert(1)">x</a>', /xlink:href\s*=/i],
    ['form action', '<form action="javascript:alert(1)">x</form>', /action\s*=/i],
    ['button formaction', '<button formaction="javascript:alert(1)">x</button>', /formaction\s*=/i],
  ])('drops an active URL in %s', (_label, html, pattern) => {
    const out = body(html);

    expect(out).not.toMatch(pattern);
    expect(out).not.toContain('javascript:');
  });

  it('drops stray dangerous end tags', () => {
    expect(body('</script >')).toBe('');
  });

  it('cannot rebuild a script tag from a nested opener', () => {
    const out = body('<scr<script>ipt>alert(1)</scr<script>ipt>');

    expect(out.toLowerCase()).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
  });

  it('drops base tags', () => {
    const out = body('<base href="https://evil.example/">');
    expect(out.toLowerCase()).not.toContain('<base');
    expect(out).not.toContain('evil.example');
  });

  it('keeps image data URLs and drops other data URLs', () => {
    const image = '<img src="data:image/png;base64,AAAA">';
    expect(body(image)).toBe(image);
    expect(body('<a href="data:text/html,<script>alert(1)</script>">x</a>')).not.toContain('href=');
  });
});

describe('archive sanitising: benign output is unchanged', () => {
  const fixtures = [
    '<table role="presentation" style="width:100%"><tr><td style="padding:24px">' +
      '<h1 style="margin:0">Hello</h1><p>Read <a href="https://example.com/story">the story</a>.</p>' +
      '<img src="https://example.com/photo.jpg" alt="A photo" width="600"></td></tr></table>',
    '<h1>Hello</h1><p>This week &amp; next.</p>' +
      '<img src="https://northstar.example/photo.jpg" alt="A photo">' +
      '<a href="#" class="button" style="color:#111827">A link</a>',
    '<!doctype html><!-- a comment about the issue --><section id="main"><p>Text</p></section>',
    '<p title="a > b" data-kind="newsletter">A &lt; B</p>',
    '<ul><li>One</li><li>Two <strong>bold</strong></li></ul>',
  ];

  it('matches the old implementation on benign fixtures', () => {
    for (const html of fixtures) {
      expect(isBenign(html), html).toBe(true);
      expect(emailParts(html), html).toEqual(benignReference(html));
    }
  });

  it('takes the scanner fast path on benign fixtures', () => {
    for (const html of fixtures) {
      const extracted = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
      expect(sanitiseEmailBody(extracted), html).toBe(scanEmailBody(extracted));
    }
  });

  it('keeps a rendered newsletter byte-identical', async () => {
    const mjml = readFileSync(new URL('../../../spikes/email-editor/templates/03-newsletter.mjml', import.meta.url), 'utf8');
    const rendered = await renderTemplate({ purpose: 'marketing_email', subject: 'Field notes', mjml }, {});
    const parts = emailParts(rendered.html);

    expect(isBenign(rendered.html)).toBe(true);
    expect(parts).toEqual(benignReference(rendered.html));
    const extracted = rendered.html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? rendered.html;
    expect(sanitiseEmailBody(extracted)).toBe(scanEmailBody(extracted));
  });

  it('matches the old implementation on 20,000 random benign inputs', () => {
    let seed = 0x5eed1234;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const words = ['alpha', 'beta', 'gamma', 'delta', 'story', 'photo', 'hello', 'week', 'a-b', 'x.y', '&amp;'];
    const word = () => pick(words);
    const value = () => Array.from({ length: 1 + Math.floor(random() * 3) }, word).join(pick([' ', '-', '/', '']));
    const tags = [
      'p',
      'div',
      'span',
      'a',
      'img',
      'table',
      'tr',
      'td',
      'h1',
      'h2',
      'strong',
      'em',
      'ul',
      'li',
      'br',
      'hr',
      'section',
      'header',
      'footer',
      'article',
    ];
    const voidTags = new Set(['img', 'br', 'hr']);
    const names = ['class', 'id', 'style', 'title', 'alt', 'width', 'height', 'role', 'aria-label', 'href', 'src', 'data-kind'];
    const attributes = () =>
      Array.from({ length: Math.floor(random() * 4) }, () => {
        const name = pick(names);
        if (random() < 0.1) return name;
        const raw = name === 'href' || name === 'src' ? `https://example.com/${value()}` : value();
        const quote = pick(['"', "'", null]);
        return quote ? `${name}=${quote}${raw}${quote}` : `${name}=${raw.replace(/\s/g, '') || 'x'}`;
      }).join(pick([' ', '  ', '\n']));
    const generate = () => {
      const parts: string[] = [];
      const count = 1 + Math.floor(random() * 8);
      for (let i = 0; i < count; i++) {
        if (random() < 0.45) {
          parts.push(Array.from({ length: 1 + Math.floor(random() * 4) }, word).join(' '));
          continue;
        }
        const name = pick(tags);
        const attrs = attributes();
        const selfClosing = voidTags.has(name) && random() < 0.5;
        parts.push(`<${name}${attrs ? ` ${attrs}` : ''}${selfClosing ? '/' : ''}>`);
        if (!voidTags.has(name) && random() < 0.8) {
          parts.push(Array.from({ length: 1 + Math.floor(random() * 3) }, word).join(' '));
          parts.push(`</${name}>`);
        }
      }
      return `<body>${parts.join('')}</body>`;
    };

    for (let i = 0; i < 20_000; i++) {
      const html = generate();
      expect(isBenign(html), html).toBe(true);
      expect(emailParts(html), html).toEqual(benignReference(html));
    }
  });
});

describe('archive sanitising: comments close where a browser closes them (integrator review)', () => {
  const body = (inner: string) => emailParts(`<html><body>${inner}</body></html>`).body;

  it('treats <!--> and <!---> as empty comments, so a following script is still removed', () => {
    for (const opener of ['<!-->', '<!--->']) {
      const out = body(`${opener}<script>alert(1)</script>ok`);
      expect(out, opener).not.toMatch(/<script/i);
      expect(out).toContain('ok');
    }
  });

  it('ends a comment at --!> as browsers do', () => {
    expect(body('<!-- a --!><script>alert(1)</script>ok')).not.toMatch(/<script/i);
  });

  it('keeps ordinary and MSO conditional comments byte-identical', () => {
    for (const html of ['<!-- note --><p>ok</p>', '<!--[if mso]><table><tr><td><![endif]--><p>ok</p>']) {
      expect(body(html)).toBe(html);
    }
  });
});

describe('archive sanitising: comment scanning stays linear (integrator review)', () => {
  const cases: [string, (n: number) => string, number][] = [
    ['many short comments', (n) => '<!---->'.repeat(n), 30_000],
    ['one long dash run', (n) => `<!--${'-'.repeat(n)}`, 100_000],
    ['spaced comments', (n) => '<!-- -- '.repeat(n), 20_000],
  ];

  it.each(cases)('handles %s in linear time', (_label, build, base) => {
    expectLinear(build, (inner) => emailParts(`<html><body>${inner}</body></html>`), base);
  });
});

describe('archive sanitising: spec-compliant parser is the final judge (Sol re-check)', () => {
  const body = (inner: string) => emailParts(`<html><body>${inner}</body></html>`).body;

  // A surviving `<meta http-equiv=refresh>` navigates despite the CSP, which does not govern
  // refresh. Each payload makes the hand-written scanner and the browser's parser disagree.
  const payloads = [
    ['stray quote in an attribute name', '<meta http-equiv=refresh content="0;url=https://example.org/" x">'],
    ['unterminated opener exposing embedded markup', '<p title="<meta http-equiv=refresh content=0;url=https://example.org/>'],
    ['a script splits the tag name', '<me<script></script>ta http-equiv=refresh content="0;url=https://example.org/">'],
    ['noscript closes before the meta', '<noscript><p title="</noscript><meta http-equiv=refresh content=0;url=https://example.org/>">'],
  ] as const;

  it.each(payloads)('leaves no active content for %s', (_label, payload) => {
    expectInert(body(payload));
  });

  it.each([
    ['uppercase HTTP-EQUIV', '<meta HTTP-EQUIV="REFRESH" content="0;url=https://example.org/">'],
    ['padded Refresh value', '<meta http-equiv=" Refresh " content="0;url=https://example.org/">'],
    ['refresh inside a template', '<template><meta http-equiv="refresh" content="0;url=https://example.org/"></template>'],
    ['stray quote with uppercase HTTP-EQUIV', '<meta HTTP-EQUIV=Refresh content="0;url=https://example.org/" x">'],
  ])('leaves no active content for %s', (_label, payload) => {
    expectInert(body(payload));
  });

  it('parses benign output as inert', () => {
    expect(activeContent(body('<p>Read <a href="https://example.com/story">the story</a>.</p>'))).toEqual([]);
  });

  it('fails closed when the cleaned tree is still active', () => {
    const input = '<p>ok</p>';
    expect(sanitiseEmailBody(input, () => true)).toBe('&lt;p&gt;ok&lt;/p&gt;');
  });

  it('sanitises assembled meta refreshes on the hostile path in linear time', () => {
    const payload = '<me<script></script>ta http-equiv=refresh content="0;url=https://example.org/">';

    expectInert(body(payload.repeat(4_000)));
    expectLinear((n) => payload.repeat(n), body, 4_000);
  });
});

describe('archive sanitising: nesting is bounded before the parse5 judge (#578)', () => {
  const body = (inner: string) => emailParts(`<style>.x{}</style><body>${inner}</body>`).body;

  it('fails closed on nesting deeper than the cap', () => {
    const deep = `${'<div>'.repeat(600)}deep${'</div>'.repeat(600)}`;
    const out = body(deep);

    expect(out).toContain('&lt;div&gt;');
    expect(out).not.toContain('<div>');
  });

  it('takes the fast path and stays byte-identical at a realistic depth', () => {
    const html = `${'<div>'.repeat(40)}<p>Text</p>${'</div>'.repeat(40)}`;
    expect(body(html)).toBe(html);
  });

  it('takes the fast path at the nesting cap', () => {
    const html = `${'<div>'.repeat(512)}x${'</div>'.repeat(512)}`;
    expect(body(html)).toBe(html);
  });

  it('fails closed above the size budget', () => {
    const huge = `<p>${'x'.repeat(1_000_001)}</p>`;
    const out = body(huge);

    expect(out).toContain('&lt;p&gt;');
    expect(out).not.toContain('<p>');
  });

  // parse5 checks the stack of open elements for every tag, so nested input is O(depth²). The cap
  // is what bounds that cost; depth is not linear. Assert the bound, not a ratio that is mostly
  // noise at these sizes: at the cap and one level under it, the fast path stays byte-identical
  // and a genuinely slow CI runner still has a wide margin.
  it('finishes benign nesting at the cap within a generous budget', () => {
    for (const depth of [MAX_EMAIL_NESTING - 1, MAX_EMAIL_NESTING]) {
      const html = `${'<div>'.repeat(depth)}x${'</div>'.repeat(depth)}`;
      const started = performance.now();
      const out = body(html);
      const elapsed = performance.now() - started;

      expect(out, `depth ${depth}`).toBe(html);
      expect(elapsed, `depth ${depth}: ${elapsed.toFixed(1)} ms`).toBeLessThan(1_000);
    }
  });

  it('stays linear in width at a realistic depth', () => {
    expectLinear((n) => `${'<div>'.repeat(40)}x${'</div>'.repeat(40)}`.repeat(n), body, 200);
  });

  it('stays linear on wide sibling-heavy input', () => {
    expectLinear((n) => '<p>x</p>'.repeat(n), body, 5_000);
  });

  // Sol's 0.14.2 review: at 10,000 repetitions these shapes reached parse5 and took about 4.6 s.
  // In HTML a slash on a non-void element does not close it, and an end tag with no matching open
  // element is ignored, so the pre-scan has to count both instead of assuming they cancel out.
  it('fails closed and stays linear on repeated self-closing non-void elements', () => {
    const out = body('<div/>'.repeat(10_000));
    expect(out).toContain('&lt;div/&gt;');
    expect(out).not.toContain('<div');
    expectLinear((n) => '<div/>'.repeat(n), body, 2_500);
  });

  it('fails closed and stays linear when end tags match nothing open', () => {
    const out = body('<div></span>'.repeat(10_000));
    expect(out).toContain('&lt;div&gt;');
    expect(out).not.toContain('<div');
    expectLinear((n) => '<div></span>'.repeat(n), body, 2_500);
  });

  it('fails closed and stays linear on repeated self-closing paragraphs', () => {
    const out = body('<p/>'.repeat(10_000));
    expect(out).toContain('&lt;p/&gt;');
    expect(out).not.toContain('<p');
    expectLinear((n) => '<p/>'.repeat(n), body, 2_500);
  });

  it('keeps a true match to an open element on the fast path', () => {
    const html = `${'<div>'.repeat(200)}x${'</div>'.repeat(200)}`;
    expect(body(html)).toBe(html);
  });

  it('keeps benign self-closing non-void nesting under the cap byte-identical', () => {
    const html = '<div/>'.repeat(100);
    expect(body(html)).toBe(html);
  });

  it('does not count raw-text content as tags', () => {
    const html = `<style>${'<div>'.repeat(1_000)}</style><p>ok</p>`;
    expect(sanitiseEmailBody(html)).toBe(html);
    expectLinear((n) => `<style>${'<div>'.repeat(n)}</style>`, sanitiseEmailBody, 2_500);
  });
});

describe('archive sanitising: the final page, not only the body (Sol re-check 3)', () => {
  // Parse the whole rendered page the way a browser would and list what is active in it.
  const page = (html: string) => {
    const parts = emailParts(html);
    return `<style>${parts.styles}</style><div class="email-body">${parts.body}</div>`;
  };

  it('removes a tracking pixel before judging, so the pieces around it cannot form a refresh', () => {
    const html = '<html><body><me<img width=1 height=1>ta http-equiv=refresh content="0;url=https://example.org/"></body></html>';
    expect(activeContent(page(html))).toEqual([]);
  });

  it('keeps extracted styles inside the page style element', () => {
    const html =
      '<html><head><style></style x><meta http-equiv=refresh content="0;url=https://example.org/"></style></head><body><p>ok</p></body></html>';
    expect(activeContent(page(html))).toEqual([]);
    expect(emailParts(html).styles).not.toMatch(/<\/style/i);
  });

  it('judges attributes too: a handler after a malformed attribute is removed', () => {
    const out = emailParts('<html><body><img src=x x" onerror=alert(1)></body></html>').body;
    expect(activeContent(out)).toEqual([]);
  });

  it('judges attributes a <body> or <html> tag in the e-mail would merge into the page', () => {
    for (const tag of ['<body onload=alert(1)>', '<html onload=alert(1)>']) {
      const out = emailParts(`<html><body><p>ok</p>${tag}</body></html>`).body;
      expect(out.toLowerCase(), tag).not.toContain('onload');
    }
  });

  it('stays linear when an early </div> or </body> is followed by many comments', () => {
    for (const close of ['</div>', '</body>']) {
      expectLinear(
        (n) => `<html><body>${close}${'<!--x-->'.repeat(n)}</body></html>`,
        (html) => emailParts(html),
        5_000,
      );
    }
  });
});

describe('archive sanitising: the real rendered page (Sol re-check 4)', () => {
  const brand = resolveBrand({ name: 'Northstar' } as unknown as Brand);

  // Walk the whole document a browser builds from the real web-version page, head included.
  const activeInPage = (page: string): string[] => {
    const found: string[] = [];
    const stack: DefaultTreeAdapterTypes.ParentNode[] = [parse(page, { scriptingEnabled: true })];
    while (stack.length > 0) {
      const parent = stack.pop()!;
      for (const node of parent.childNodes) {
        if (!('tagName' in node)) continue;
        const element = node as DefaultTreeAdapterTypes.Element;
        found.push(
          ...activeContent(
            `<${element.tagName} ${element.attrs.map((a) => `${a.name}="${a.value.replace(/"/g, '&quot;')}"`).join(' ')}></${element.tagName}>`,
          ),
        );
        stack.push(element);
        if (element.tagName === 'template') stack.push((element as DefaultTreeAdapterTypes.Template).content);
      }
    }
    return found;
  };

  const payloads = [
    '<me<img width=1 height=1>ta http-equiv=refresh content="0;url=https://example.org/">',
    '<meta http-equiv=refresh content="0;url=https://example.org/" x">',
    '<p title="<meta http-equiv=refresh content=0;url=https://example.org/>',
    '<me<script></script>ta http-equiv=refresh content="0;url=https://example.org/">',
    '<noscript><p title="</noscript><meta http-equiv=refresh content=0;url=https://example.org/>">',
    '<img src=x x" onerror=alert(1)>',
    '</div></main></body></html><meta http-equiv=refresh content=0>',
    '<frameset><frame src="javascript:alert(1)"></frameset>',
    '<head><base href="javascript:alert(1)//"></head>',
    '<svg><style><img src=x onerror=alert(1)></style></svg>',
    '<svg><a href="https://ok.example"><animate attributeName="href" values="javascript:alert(1)"/></a></svg>',
    '<svg><a href="https://ok.example"><animate attributeName="xlink:href" values="javascript:alert(1)"/></a></svg>',
    '<svg><a href="https://ok.example"><set attributeName="href" to="javascript:alert(1)"/></a></svg>',
    '<svg><a href="https://ok.example"><set attributeName="xlink:href" to="javascript:alert(1)"/></a></svg>',
    '<svg><a href="https://ok.example"><animateTransform attributeName="href" values="javascript:alert(1)"/></a></svg>',
    '<svg><a href="https://ok.example"><animateMotion path="javascript:alert(1)"/></a></svg>',
    '<svg><discard begin="0s" href="javascript:alert(1)"/></svg>',
  ];

  it.each(payloads)('leaves nothing active in the page for %s', (payload) => {
    const page = renderWebVersion(brand, 'Issue', null, `<html><body>${payload}</body></html>`);
    expect(activeInPage(page)).toEqual([]);
  });

  it.each([
    ['animate href', '<svg><a href="https://ok.example"><animate attributeName="href" values="javascript:alert(1)"/></a></svg>'],
    ['set xlink:href', '<svg><a href="https://ok.example"><set attributeName="xlink:href" to="javascript:alert(1)"/></a></svg>'],
  ])('drops a SMIL %s animation from the real page', (_label, payload) => {
    const page = renderWebVersion(brand, 'Issue', null, `<html><body>${payload}</body></html>`);

    expect(page).not.toMatch(/<(?:animate|animatetransform|animatemotion|set|discard)\b/i);
    expect(page).not.toContain('javascript:');
    expect(activeInPage(page)).toEqual([]);
  });

  it('fails closed on nesting beyond the cap and stays inert on the real page', () => {
    const email = `<html><body>${'<div>'.repeat(600)}deep${'</div>'.repeat(600)}</body></html>`;
    const page = renderWebVersion(brand, 'Issue', null, email);

    expect(page).toContain('&lt;div&gt;');
    expect(page).not.toContain('<div>deep');
    expect(activeInPage(page)).toEqual([]);
  });

  it('keeps styles that try to close the page style element inside it', () => {
    const email =
      '<html><head><style></style x><meta http-equiv=refresh content="0;url=https://example.org/"></style></head><body><p>ok</p></body></html>';
    expect(activeInPage(renderWebVersion(brand, 'Issue', null, email))).toEqual([]);
  });

  it('renders a benign issue with nothing active and its content intact', () => {
    const page = renderWebVersion(brand, 'Issue', null, '<html><body><p>Hello <a href="https://example.com">there</a></p></body></html>');
    expect(activeInPage(page)).toEqual([]);
    expect(page).toContain('<p>Hello <a href="https://example.com">there</a></p>');
  });
});
