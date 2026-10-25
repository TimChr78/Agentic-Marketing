import { describe, expect, it } from 'vitest';
import { HOSTED_PAGE_HEADERS, hostedPageHeaders } from '../src/hostedPages';
import { artifactTypes } from '../src/types';

const formAction = (h: { 'content-security-policy': string }) => h['content-security-policy'].match(/form-action ([^;]+);/)?.[1];

describe('hosted page headers (#115)', () => {
  it('allow posting to the links host only, unless the POST redirects elsewhere', () => {
    expect(formAction(HOSTED_PAGE_HEADERS)).toBe("'self'");
    expect(formAction(hostedPageHeaders(['https://martechsignal.com']))).toBe("'self' https://martechsignal.com");
    expect(formAction(hostedPageHeaders([null, undefined]))).toBe("'self'");
  });

  it('keep the rest of the policy and add nothing but origins', () => {
    const csp = hostedPageHeaders([
      'https://a.example',
      'https://a.example',
      'https://b.example; script-src *',
      '/welcome',
      'javascript:alert(1)',
    ])['content-security-policy'];
    expect(csp).toBe(
      "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; form-action 'self' https://a.example; frame-ancestors 'none'; base-uri 'none'",
    );
  });
});

describe('form confirmedUrl', () => {
  const form = {
    purposes: ['marketing_email'],
    doubleOptIn: true,
    confirmationTemplate: `eml_${'0'.repeat(32)}`,
    consentText: 'Send me the newsletter.',
    successUrl: '/thanks',
  };
  it('is optional; without it the branded confirmed page is shown', () => {
    expect(artifactTypes.form.content.safeParse(form).success).toBe(true);
    expect(artifactTypes.form.content.safeParse({ ...form, confirmedUrl: 'https://example.com/welcome' }).success).toBe(true);
    expect(artifactTypes.form.content.safeParse({ ...form, confirmedUrl: 'welcome' }).success).toBe(false);
  });
});
