import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { redactCredentials } from '../src/diagnostics';

// A differential guard against the release the 0.14.21 work started from (#898): every input the
// 0.14.20 redactor changed must still lose its credential, whatever spelling or shape it used.
// The fixture is generated once from `origin/main` at 7b4b6cd2 (see the `note` it carries) and
// committed: this test never imports the old implementation.

interface Fixture {
  note: string;
  inputs: string[];
}

// Token-shaped values are assembled from pieces here, so neither this file nor the committed
// fixture carries a literal that a secret scanner would (rightly) refuse.
const HEX = '0123456789abcdef';
const TOKENS: Record<string, string> = {
  '{{SHOPIFY}}': ['shpat_', HEX.repeat(2)].join(''),
  '{{GITHUB}}': ['ghp_', HEX.repeat(2)].join(''),
  '{{STRIPE}}': ['sk_live_', '0123456789abcdef'].join(''),
  '{{AWS}}': ['AKIA', 'IOSFODNN7EXAMPLE'].join(''),
  '{{JWT}}': ['eyJ', 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'signature'].join('.'), // a three-part token
};

const expand = (text: string): string => text.replace(/\{\{[A-Z]+\}\}/g, (placeholder) => TOKENS[placeholder] ?? placeholder);

const fixture = JSON.parse(readFileSync(new URL('./fixtures/redaction-0.14.20.json', import.meta.url), 'utf8')) as Fixture;
const inputs = fixture.inputs.map(expand);

/** The values planted in the fixture by the generator. */
const PLANTED = [
  'Sh0rtPw',
  'shortpw',
  'probe-secret',
  'abcdef1234567890',
  'YWxhZGRpbjpvcGVuc2VzYW1l',
  TOKENS['{{SHOPIFY}}']!,
  TOKENS['{{GITHUB}}']!,
  TOKENS['{{STRIPE}}']!,
  TOKENS['{{AWS}}']!,
  TOKENS['{{JWT}}']!,
];

describe('redaction still covers everything 0.14.20 redacted (#898)', () => {
  it('has a fixture worth checking', () => {
    expect(inputs.length).toBeGreaterThan(300);
    expect(fixture.note).toContain('0.14.20');
  });

  it('changes every input the old redactor changed', () => {
    const kept: string[] = [];
    for (const input of inputs) if (redactCredentials(input) === input) kept.push(input);
    expect(kept.slice(0, 10)).toEqual([]);
    expect(kept).toHaveLength(0);
  });

  it('removes every planted value', () => {
    const survived: string[] = [];
    for (const input of inputs) {
      const out = redactCredentials(input);
      for (const secret of PLANTED) if (input.includes(secret) && out.includes(secret)) survived.push(`${secret} in ${input}`);
    }
    expect(survived.slice(0, 10)).toEqual([]);
    expect(survived).toHaveLength(0);
  });
});
