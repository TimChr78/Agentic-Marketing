import { describe, expect, it } from 'vitest';
import { redactCredentials } from '../src/diagnostics';

// #937: the value shapes the 0.14.20-0.14.24 rules do not consume. Every case here is a shape the
// issue lists, plus the negative cases that must keep their text.

/** Ten characters: below the 24-character bare-token rule, so only the shape under test can find it. */
const SECRET = 'S3cr3tV4l';

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
