import { describe, expect, it } from 'vitest';
import { emailParts } from '../src/archive';

// CodeQL alerts 4, 3, 2 and 1 (js/bad-tag-filter, js/incomplete-multi-character-sanitization):
// the public archive renders e-mail HTML behind a strict CSP, and `emailParts` is the defence in
// depth. These are the forms the old regex pair missed.
const body = (html: string) => emailParts(`<style>.issue{color:#111827}</style><body>${html}</body>`).body;

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
    const out = body('<scr<script>ipt>alert(1)</scr<script>ipt><p>ok</p>');

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
