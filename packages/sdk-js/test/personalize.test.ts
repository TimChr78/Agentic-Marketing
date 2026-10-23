import { Window as HappyWindow } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { previewOf } from '../src/index';
import { type Decision, personalize, sanitize } from '../src/personalize';

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
