import { describe, expect, it } from 'vitest';
import { artifactTypes } from '../src/types';

// Form content rules from #597 (allowed sites compare case-insensitively) and #598 (the hosted-page
// override keeps its values while it is switched off).

const form = {
  purposes: ['marketing_email'],
  doubleOptIn: false,
  consentText: 'Send me the newsletter.',
  successUrl: 'https://example.com/thanks',
};

const parse = (extra: Record<string, unknown> = {}) => artifactTypes.form.content.parse({ ...form, ...extra }) as Record<string, unknown>;

describe('form allowed origins (#597)', () => {
  it('saves the scheme and host lowercased, keeping the port', () => {
    expect(parse({ allowedOrigins: ['https://MySite.com', 'HTTP://LOCALHOST:8080'] }).allowedOrigins).toEqual([
      'https://mysite.com',
      'http://localhost:8080',
    ]);
  });

  it('leaves an already canonical origin alone', () => {
    expect(parse({ allowedOrigins: ['https://example.com', 'https://example.com:8443'] }).allowedOrigins).toEqual([
      'https://example.com',
      'https://example.com:8443',
    ]);
  });

  it('still refuses something that is not an origin', () => {
    expect(artifactTypes.form.content.safeParse({ ...form, allowedOrigins: ['MySite.com/path'] }).success).toBe(false);
    expect(artifactTypes.form.content.safeParse({ ...form, allowedOrigins: ['ftp://example.com'] }).success).toBe(false);
  });
});

describe('form hosted-page override (#598)', () => {
  const override = { colors: { accent: '#0f766e' }, copy: { confirmTitle: 'Formens egen titel' } };

  it('keeps the override values while the switch is off', () => {
    const content = parse({ hostedPages: override, hostedPagesEnabled: false });
    expect(content.hostedPages).toEqual(override);
    expect(content.hostedPagesEnabled).toBe(false);
  });

  it('treats content saved without the switch as enabled', () => {
    const content = parse({ hostedPages: override });
    expect(content.hostedPagesEnabled).toBeUndefined();
  });

  it('leaves a form without an override alone', () => {
    const content = parse();
    expect(content.hostedPages).toBeUndefined();
    expect(content.hostedPagesEnabled).toBeUndefined();
  });
});
