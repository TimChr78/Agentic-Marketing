import { describe, expect, it } from 'vitest';
import { renderTemplate, validateTemplate } from '../src/render';

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
