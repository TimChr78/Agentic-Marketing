import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileMjml, renderTemplate, validateTemplate } from '../src/render';

const welcome = {
  purpose: 'marketing_email',
  subject: 'Welcome, {{ profile.firstName | default: "friend" }}',
  preheader: 'Your first {{ event.properties.discount }}% off',
  mjml: `<mjml><mj-body><mj-section><mj-column>
    <mj-text>Hej {{ profile.firstName }}!</mj-text>
    {% if profile.loyaltyTier == "gold" %}<mj-text>Gold perks inside.</mj-text>{% endif %}
    <mj-button href="https://shop.example.com/?c={{ profile.id | url_encode }}">Shop</mj-button>
    <mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text>
  </mj-column></mj-section></mj-body></mjml>`,
};

describe('template rendering', () => {
  it('renders Liquid then MJML, with a preheader and a text part', async () => {
    const r = await renderTemplate(welcome, {
      profile: { firstName: 'Ada', loyaltyTier: 'gold', id: 'prf_1' },
      event: { properties: { discount: 10 } },
      unsubscribe_url: 'https://m.example.com/u/abc',
    });
    expect(r.subject).toBe('Welcome, Ada');
    expect(r.preheader).toBe('Your first 10% off');
    expect(r.html).toContain('Hej Ada!');
    expect(r.html).toContain('Gold perks inside.');
    expect(r.html).toContain('https://m.example.com/u/abc');
    expect(r.html).toContain('Your first 10% off');
    expect(r.text).toContain('Hej Ada!');
    expect(r.warnings).toEqual([]);
  });

  it('escapes personal data so it cannot inject markup', async () => {
    const r = await renderTemplate(welcome, { profile: { firstName: '<script>alert(1)</script>' } });
    expect(r.html).not.toContain('<script>alert(1)');
    expect(r.html).toContain('&lt;script&gt;');
    expect(r.subject).toBe('Welcome, &lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('uses the PNG rendition for an SVG asset image, so e-mail clients can show it', async () => {
    const assetId = `ast_${'a'.repeat(32)}`;
    const svg = `https://links.example.com/a/${assetId}/logo.svg`;
    const r = await renderTemplate(
      {
        ...welcome,
        mjml: `<mjml><mj-body><mj-section><mj-column><mj-image src="${svg}" alt="Logo" /><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>`,
      },
      { unsubscribe_url: 'https://m.example.com/u/abc' },
    );
    expect(r.html).toContain(`https://links.example.com/a/${assetId}/logo.png`);
    expect(r.html).not.toContain(`${assetId}/logo.svg`);
    // A URL that is not one of our assets is left alone.
    const other = await renderTemplate(
      {
        ...welcome,
        mjml: `<mjml><mj-body><mj-section><mj-column><mj-image src="https://example.com/logo.svg" /><mj-text><a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>`,
      },
      { unsubscribe_url: 'https://m.example.com/u/abc' },
    );
    expect(other.html).toContain('https://example.com/logo.svg');
  });

  it('refuses includes and reports broken templates when saving', async () => {
    await expect(renderTemplate({ ...welcome, mjml: '{% include "/etc/passwd" %}' }, {})).rejects.toThrow();
    expect(validateTemplate({ ...welcome, subject: 'Hi {{ profile.name ' })[0]).toMatch(/^subject: Liquid error/);
    expect(validateTemplate({ ...welcome, mjml: '<mjml><mj-body><mj-column><mj-text>x</mj-text></mj-column></mj-body></mjml>' })).toEqual([
      expect.stringMatching(/mjml line \d+: .*mj-column/),
      expect.stringContaining('unsubscribe link'),
    ]);
    expect(validateTemplate(welcome)).toEqual([]);
    expect(validateTemplate({ ...welcome, purpose: 'onboarding', mjml: welcome.mjml.replace('unsubscribe_url', 'x') })).toEqual([]);
  });
});

// #177: mjml 4 ships the mj-include traversal (GHSA-45h5-66jx-r2wf) and html-minifier's ReDoS
// (GHSA-pfq8-rq6v-vf5m) without a patched 4.x. Both are unreachable while we compile with
// `ignoreIncludes: true` and `minify: false`; these tests fail if that changes.
describe('mjml advisories stay unreachable', () => {
  const secret = fileURLToPath(new URL('./fixtures/include-secret.mjml', import.meta.url));

  it('does not follow mj-include, by absolute or relative path', () => {
    for (const path of [secret, '../test/fixtures/include-secret.mjml']) {
      const { html } = compileMjml(`<mjml><mj-body><mj-include path="${path}" /></mj-body></mjml>`);
      expect(html).not.toContain('INCLUDED-SECRET');
    }
    const problems = validateTemplate({ ...welcome, mjml: welcome.mjml.replace('<mj-body>', `<mj-body><mj-include path="${secret}" />`) });
    expect(problems.join('\n')).not.toContain('INCLUDED-SECRET');
  });

  it('compiles a large input with many attributes quickly (no minifier pass)', () => {
    const attrs = Array.from({ length: 200 }, (_, i) => `data-a${i}="${'x'.repeat(50)}"`).join(' ');
    const rows = Array.from({ length: 200 }, () => `<mj-text><p ${attrs}>hej</p></mj-text>`).join('');
    const started = Date.now();
    compileMjml(`<mjml><mj-body><mj-section><mj-column>${rows}</mj-column></mj-section></mj-body></mjml>`);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
