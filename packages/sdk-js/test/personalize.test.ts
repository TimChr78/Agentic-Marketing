import { Window as HappyWindow } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { previewOf } from '../src/index';
import { type Decision, personalize, sanitize } from '../src/personalize';
import { oldRemovals, sanitizeOld } from './personalize-01132-reference';

function page(html: string) {
  const win = new HappyWindow({ url: 'https://shop.example.com/' });
  win.document.body.innerHTML = html;
  win.document.documentElement.classList.add('am-loading');
  return { win: win as unknown as Window, doc: win.document as unknown as Document };
}
const decision = (over: Partial<Decision>): Decision => ({
  placement: 'home_hero',
  experienceId: 'exp_1',
  version: 1,
  variantId: 'a',
  content: { html: '<h1>Hi</h1>' },
  trigger: { type: 'immediate' },
  ...over,
});

const serialize = (frag: DocumentFragment, doc: Document) => {
  const div = doc.createElement('div');
  div.append(frag);
  return div.innerHTML;
};

describe('sanitize', () => {
  it('keeps markup and removes scripts, handlers and script URLs', () => {
    const { doc } = page('');
    const div = doc.createElement('div');
    div.append(
      sanitize(
        '<h1 onclick="steal()">Tents</h1><script>steal()</script><a href="javascript:steal()">x</a><a href="https://shop/x">ok</a><img src="x" onerror="steal()"><iframe src="https://evil"></iframe>',
        doc,
      ),
    );
    expect(div.innerHTML).toBe('<h1>Tents</h1><a>x</a><a href="https://shop/x">ok</a><img src="x">');
  });

  // The three bypasses from #1132: SVG SMIL, a <style> block, and a srcset whose second candidate
  // is a script URL. None may survive the allowlist.
  it('removes SVG SMIL animation that rewrites href to javascript:', () => {
    const { doc } = page('');
    const out = serialize(
      sanitize(
        '<svg><a href="https://example.com"><set attributeName="href" to="javascript:alert(document.domain)" begin="0s"/><rect width="200" height="40"/></a></svg><p>kept</p>',
        doc,
      ),
      doc,
    );
    expect(out).toBe('<p>kept</p>');
    expect(out).not.toMatch(/<svg|<set|attributeName/i);
    expect(out).not.toContain('javascript:');
  });

  it('removes <style>, including @import and external url()', () => {
    const { doc } = page('');
    const out = serialize(
      sanitize(
        '<style>@import url("https://attacker.example/x.css"); .x{background:url(https://attacker.example/p.png)}</style><p>kept</p>',
        doc,
      ),
      doc,
    );
    expect(out).toBe('<p>kept</p>');
    expect(out).not.toContain('@import');
    expect(out).not.toContain('attacker.example');
  });

  it('validates every srcset candidate, not only the start of the attribute', () => {
    const { doc } = page('');
    const bypass = serialize(
      sanitize(
        '<img src="https://ok.example/a.png" srcset="https://ok.example/a.png 1x, data:image/svg+xml,<svg onload=alert(1)> 2x">',
        doc,
      ),
      doc,
    );
    expect(bypass).not.toContain('srcset');
    expect(bypass).toContain('src="https://ok.example/a.png"');
    const good = serialize(sanitize('<img srcset="https://ok.example/a.png 1x, https://ok.example/b.png 2x">', doc), doc);
    expect(good).toContain('srcset="https://ok.example/a.png 1x, https://ok.example/b.png 2x"');
  });

  it('rejects external url(), @import and CSS escapes in an inline style', () => {
    const { doc } = page('');
    for (const style of [
      'background:url(https://attacker.example/x.png)',
      '@import "https://attacker.example/x.css";',
      'background:\\75 rl(https://attacker.example/x.png)',
      'width:expression(alert(1))',
      'background:url(javascript:alert(1))',
    ]) {
      const out = serialize(sanitize(`<div style="${style}">x</div>`, doc), doc);
      expect(out).toBe('<div>x</div>');
    }
    expect(serialize(sanitize('<div style="color:red">x</div>', doc), doc)).toBe('<div style="color:red">x</div>');
  });

  it('keeps only allow-listed tags and attributes', () => {
    const { doc } = page('');
    const out = serialize(
      sanitize(
        '<p class="lead" data-track="x">Hi <strong>there</strong></p><math><mtext>x</mtext></math><marquee>old</marquee><img src="data:image/svg+xml;base64,PHN2Zz4=">',
        doc,
      ),
      doc,
    );
    expect(out).toBe('<p class="lead">Hi <strong>there</strong></p><img>');
  });

  // Differential, like the redaction baseline: the released denylist sanitizer removed a set of
  // tags and attribute values, and the allowlist may only remove more, never less.
  it('still removes everything the denylist sanitizer removed', () => {
    const corpus = [
      '<h1 onclick="steal()">Tents</h1><script>steal()</script><a href="javascript:steal()">x</a><a href="https://shop/x">ok</a><img src="x" onerror="steal()"><iframe src="https://evil"></iframe>',
      '<object data="x"></object><embed src="x"><form action="/steal"><input name="password"></form>',
      '<base href="https://evil"><meta http-equiv="refresh" content="0"><link rel="stylesheet" href="https://evil">',
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
      '<template><script>steal()</script></template>',
      '<a href="java\tscript:steal()">tab</a><a href="VBScript:steal()">vb</a><img src="data:text/html,<script>steal()</script>">',
      '<p style="width:expression(steal())">old ie</p><p style="background:url(javascript:steal())">url</p>',
      '<svg onload="steal()"><a xlink:href="javascript:steal()">x</a></svg>',
    ];
    for (const html of corpus) {
      const { doc } = page('');
      const oldHtml = serialize(sanitizeOld(html, doc), doc);
      const newHtml = serialize(sanitize(html, doc), doc);
      const removals = oldRemovals(html, doc);
      // The payloads really do exercise the baseline's removals.
      expect(removals.tags.size + removals.values.length, html).toBeGreaterThan(0);
      // Sanity: the baseline output really is missing what it recorded as removed.
      for (const tag of removals.tags) expect(oldHtml, `${tag} in ${html}`).not.toMatch(new RegExp(`<${tag}[\\s>/]`, 'i'));
      for (const value of removals.values) expect(oldHtml, `${value} in ${html}`).not.toContain(value);
      // The allowlist may only remove more: nothing the baseline removed survives here.
      for (const tag of removals.tags) expect(newHtml, `${tag} in ${html}`).not.toMatch(new RegExp(`<${tag}[\\s>/]`, 'i'));
      for (const value of removals.values) expect(newHtml, `${value} in ${html}`).not.toContain(value);
    }
  });
});

describe('personalize', () => {
  it('renders immediate decisions into placements, reports exposures and reveals the page', async () => {
    const { win, doc } = page('<div data-am-placement="home_hero">Default</div><div data-am-placement="top_banner">Banner</div>');
    const tracked: [string, Record<string, unknown>][] = [];
    let asked: string[] = [];
    await personalize(
      {
        decide: async (p) => {
          asked = p;
          return [
            decision({ content: { html: '<h1>10% off tents</h1><script>x</script>' } }),
            decision({ placement: 'top_banner', experienceId: 'exp_2', variantId: 'holdout', content: null }),
          ];
        },
        track: (e, p) => tracked.push([e, p]),
      },
      { doc, win },
    );
    expect(asked).toEqual(['home_hero', 'top_banner']);
    expect(doc.querySelector('[data-am-placement="home_hero"]')?.innerHTML).toBe('<h1>10% off tents</h1>');
    expect(doc.querySelector('[data-am-placement="top_banner"]')?.textContent).toBe('Banner');
    expect(tracked).toEqual([
      ['Experience Viewed', { experience_id: 'exp_1', variant_id: 'a', version: 1, placement: 'home_hero' }],
      ['Experience Viewed', { experience_id: 'exp_2', variant_id: 'holdout', version: 1, placement: 'top_banner' }],
    ]);
    expect(doc.documentElement.classList.contains('am-loading')).toBe(false);
  });

  it('shows preview links without reporting them as views', async () => {
    const id = `exp_${'a'.repeat(32)}`;
    expect(previewOf(`https://shop.example.com/?am_preview=${id}:b`)).toEqual({ experienceId: id, variantId: 'b' });
    expect(previewOf('https://shop.example.com/?am_preview=nope')).toBeUndefined();
    const { win, doc } = page('<div data-am-placement="home_hero">Default</div>');
    const tracked: string[] = [];
    await personalize(
      { decide: async () => [decision({ preview: true, content: { html: '<p>Draft B</p>' } })], track: (e) => tracked.push(e) },
      { doc, win },
    );
    expect(doc.querySelector('[data-am-placement="home_hero"]')?.innerHTML).toBe('<p>Draft B</p>');
    expect(tracked).toEqual([]);
  });

  it('keeps the default content when the decision API is slow', async () => {
    const { win, doc } = page('<div data-am-placement="home_hero">Default</div>');
    const out = await personalize({ decide: () => new Promise(() => {}), track: () => {} }, { doc, win, timeout: 50 });
    expect(out).toEqual([]);
    expect(doc.querySelector('[data-am-placement="home_hero"]')?.textContent).toBe('Default');
    expect(doc.documentElement.classList.contains('am-loading')).toBe(false);
  });

  it('waits for exit intent before showing an overlay', async () => {
    const { win, doc } = page('');
    const shown: Decision[] = [];
    await personalize(
      {
        decide: async () => [decision({ placement: 'overlay', content: { json: { code: 'STAY10' } }, trigger: { type: 'exit_intent' } })],
        track: () => {},
      },
      { doc, win, placements: ['overlay'], onDecision: (d) => shown.push(d) },
    );
    expect(shown).toEqual([]);
    doc.dispatchEvent(new (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent('mouseout', { clientY: -1 }));
    expect(shown.map((d) => d.content?.json)).toEqual([{ code: 'STAY10' }]);
  });
});
