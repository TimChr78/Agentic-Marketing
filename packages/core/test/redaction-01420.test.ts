import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { redactCredentials } from '../src/diagnostics';

// A differential guard against the release the 0.14.21 work started from (#898): every input the
// 0.14.20 redactor changed must still lose its credential, whatever spelling, shape or key length
// it used. The fixture is generated once from `origin/main` (see the `note` it carries) and
// committed: this test never imports the old implementation.
//
// Token-shaped values are assembled from pieces here, so neither this file nor the fixture carries
// a literal a secret scanner would (rightly) refuse to see pushed.

interface Fixture {
  note: string;
  tokens: Record<string, { length: number; sha256: string }>;
  inputs: string[];
}

const HEX = '0123456789abcdef';
const TOKENS: Record<string, string> = {
  '{{SHOPIFY}}': ['shpat_', HEX.repeat(2)].join(''),
  '{{GITHUB}}': ['ghp_', HEX.repeat(2)].join(''),
  '{{STRIPE}}': ['sk_live_', '0123456789abcdef'].join(''),
  '{{AWS}}': ['AKIA', 'IOSFODNN7EXAMPLE'].join(''),
  '{{JWT}}': ['eyJ' + 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'signature'].join('.'),
};

const fixture = JSON.parse(readFileSync(new URL('./fixtures/redaction-0.14.20.json', import.meta.url), 'utf8')) as Fixture;

const expand = (text: string): string =>
  text.replace(/\{\{[A-Z]+\}\}/g, (placeholder) => {
    const value = TOKENS[placeholder];
    if (value === undefined) throw new Error(`unknown placeholder ${placeholder} in the fixture`);
    return value;
  });

const inputs = fixture.inputs.map(expand);
/** The values planted in the fixture by the generator. */
const PLANTED = ['Sh0rtPw', 'shortpw', 'probe-secret', 'abcdef1234567890', 'YWxhZGRpbjpvcGVuc2VzYW1l', ...Object.values(TOKENS)];

describe('redaction still covers everything 0.14.20 redacted (#898)', () => {
  it('has a fixture worth checking', () => {
    expect(inputs.length).toBeGreaterThan(400);
    expect(fixture.note).toContain('0.14.20');
    expect(inputs.length).toBe(fixture.inputs.length);
  });

  it('assembles every placeholder exactly as the original value was', () => {
    expect(Object.keys(fixture.tokens).sort()).toEqual(Object.keys(TOKENS).sort());
    for (const [placeholder, value] of Object.entries(TOKENS)) {
      const recorded = fixture.tokens[placeholder]!;
      expect(value.length, placeholder).toBe(recorded.length);
      expect(createHash('sha256').update(value).digest('hex'), placeholder).toBe(recorded.sha256);
    }
    // The JWT is a real three-part token, not four segments joined by mistake.
    expect(TOKENS['{{JWT}}']!.split('.')).toHaveLength(3);
    expect(TOKENS['{{JWT}}']!.startsWith('eyJ')).toBe(true);
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

  it('is idempotent on every one of them', () => {
    const unstable: string[] = [];
    for (const input of inputs) {
      const once = redactCredentials(input);
      if (redactCredentials(once) !== once) unstable.push(input);
    }
    expect(unstable.slice(0, 10)).toEqual([]);
    expect(unstable).toHaveLength(0);
  });
});
