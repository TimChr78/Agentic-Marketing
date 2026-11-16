import { describe, expect, it } from 'vitest';
import { redactCredentials } from '../src/diagnostics';

// #937: the value shapes the 0.14.20-0.14.24 rules do not consume. Every case here is a shape the
// issue lists, plus the negative cases that must keep their text.

/** Ten characters: below the 24-character bare-token rule, so only the shape under test can find it. */
const SECRET = 'S3cr3tV4l';

describe('a typographic-quoted value under a credential key (#937)', () => {
  it('replaces the whole quoted value in every quote pair', () => {
    const pairs: [string, string][] = [
      ['\u201c', '\u201d'],
      ['\u2018', '\u2019'],
      ['\u00ab', '\u00bb'],
      ['\u201e', '\u201c'],
      ['\u2039', '\u203a'],
    ];
    for (const [open, close] of pairs)
      expect(redactCredentials(`token: ${open}${SECRET} with spaces${close}`), open).toBe('token: [redacted]');
  });

  it('stops at the end of the line for an unterminated quote', () => {
    expect(redactCredentials(`token: \u201c${SECRET}\nnext line`)).toBe('token: [redacted]\nnext line');
  });

  it('leaves prose containing quotes alone', () => {
    for (const input of ['the provider said \u201cnothing useful\u201d', 'a \u2018quote\u2019 in prose'])
      expect(redactCredentials(input), input).toBe(input);
  });
});

describe('a short Authorization value under a credential key (#937)', () => {
  it('replaces the token after the scheme and keeps the scheme word', () => {
    expect(redactCredentials('authToken=Bearer abc')).toBe('authToken=Bearer [redacted]');
    expect(redactCredentials('password: Basic xyz')).toBe('password: Basic [redacted]');
    expect(redactCredentials('authorization: bearer abc')).toBe('authorization: bearer [redacted]');
  });

  it('leaves a scheme without a value, and prose, alone', () => {
    for (const input of ['sent with Bearer abc', 'the Basic plan is fine']) expect(redactCredentials(input), input).toBe(input);
  });
});

describe('a structured value under a credential key (#937)', () => {
  it('replaces an array value whole', () => {
    expect(redactCredentials(`{"token":["${SECRET}"]}`)).toBe('{"token":[redacted]}');
    expect(redactCredentials(`{"token":["${SECRET}","more"]}`)).toBe('{"token":[redacted]}');
    expect(redactCredentials(`token=[${SECRET}]`)).toBe('token=[redacted]');
  });

  it('replaces an object value whole', () => {
    expect(redactCredentials(`{"secret":{"v":"${SECRET}"}}`)).toBe('{"secret":[redacted]}');
    expect(redactCredentials(`password={"v":"${SECRET}"}`)).toBe('password=[redacted]');
  });

  it('skips brackets inside a quoted string', () => {
    expect(redactCredentials(`{"token":["a]b","${SECRET}"]}`)).toBe('{"token":[redacted]}');
    expect(redactCredentials(`{"token":{"note":"}","v":"${SECRET}"}}`)).toBe('{"token":[redacted]}');
  });

  it('replaces an unbalanced value to the end of its line, never leaving the secret', () => {
    expect(redactCredentials(`{"token":["${SECRET}"`)).toBe('{"token":[redacted]');
    expect(redactCredentials(`{"token":["${SECRET}",\n"next":1`)).toBe('{"token":[redacted]\n"next":1');
  });

  it('leaves ordinary JSON and counters alone', () => {
    for (const input of ['{"a":["b"],"c":{"d":"e"}}', '{"tokens": 1234}', '{"tokenCount": 12}', 'the list [1,2,3] was returned'])
      expect(redactCredentials(input), input).toBe(input);
  });
});
