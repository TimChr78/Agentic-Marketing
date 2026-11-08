import { readFileSync } from 'node:fs';
import { renderTemplate } from '@agentic-marketing/email';
import { describe, expect, it } from 'vitest';
import { emailParts } from '../src/archive';

// CodeQL alerts 4, 3, 2 and 1 (js/bad-tag-filter, js/incomplete-multi-character-sanitization):
// the public archive renders e-mail HTML behind a strict CSP, and `emailParts` is the defence in
// depth. The scanner must be linear, quote-aware and safe on hostile entities.
const body = (html: string) => emailParts(`<style>.issue{color:#111827}</style><body>${html}</body>`).body;

const timed = <T>(run: () => T): { value: T; ms: number } => {
  const started = performance.now();
  const value = run();
  return { value, ms: performance.now() - started };
};

/** The implementation from `origin/main`, copied here for the differential test. */
function oldEmailParts(html: string): { body: string; styles: string } {
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  const extracted = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  const pixel =
    /<img\b[^>]*(?:(?:width\s*=\s*["']?1(?:px)?["']?[\s\S]*?height\s*=\s*["']?1(?:px)?["']?)|(?:height\s*=\s*["']?1(?:px)?["']?[\s\S]*?width\s*=\s*["']?1(?:px)?["']?))[^>]*>/gi;
  return {
    body: extracted
      .replace(/<script\b[\s\S]*?<\/script>/gi, '')
      .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
      .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
      .replace(pixel, ''),
    styles,
  };
}

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
  // Roughly 128 KB each. Before the scanner, every unmatched opener made DANGEROUS_PAIR rescan
  // the remaining body, so these took hundreds of milliseconds (or worse).
  it.each([
    ['unclosed iframes', '<iframe>'.repeat(16_000)],
    ['unclosed scripts', '<script>'.repeat(16_000)],
    ['unterminated quoted attributes', '<a href="'.repeat(20_000)],
    ['lone "<" characters', '<'.repeat(100_000)],
    ['repeated unterminated tags', '<a '.repeat(40_000)],
    ['one unterminated tag with many attributes', `<p ${'a="x" '.repeat(20_000)}`],
  ])('sanitises %s in under 50 ms', (_label, html) => {
    const { ms } = timed(() => body(html));

    expect(ms).toBeLessThan(50);
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
    for (const html of fixtures) expect(emailParts(html), html).toEqual(oldEmailParts(html));
  });

  it('keeps a rendered newsletter byte-identical', async () => {
    const mjml = readFileSync(new URL('../../../spikes/email-editor/templates/03-newsletter.mjml', import.meta.url), 'utf8');
    const rendered = await renderTemplate({ purpose: 'marketing_email', subject: 'Field notes', mjml }, {});
    const parts = emailParts(rendered.html);

    expect(parts).toEqual(oldEmailParts(rendered.html));
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
      expect(emailParts(html), html).toEqual(oldEmailParts(html));
    }
  });
});
