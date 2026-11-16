import { describe, expect, it } from 'vitest';
import { redactCredentials } from '../src/diagnostics';

// #937: the value shapes the 0.14.20-0.14.24 rules do not consume. Every case here is a shape the
// issue lists, plus the negative cases that must keep their text.

/** Ten characters: below the 24-character bare-token rule, so only the shape under test can find it. */
const SECRET = 'S3cr3tV4l';

describe('a credential pair nested in another pair (#937)', () => {
  it('replaces the whole nested pair', () => {
    expect(redactCredentials(`SIGNINGKEY=AZUREOPENAIKEY='${SECRET}'`)).toBe('SIGNINGKEY=[redacted]');
    expect(redactCredentials(`AZUREOPENAIKEY=apiSecret='${SECRET}'`)).toBe('AZUREOPENAIKEY=[redacted]');
    expect(redactCredentials(`authToken=apiSecret="${SECRET}"`)).toBe('authToken=[redacted]');
  });

  it('leaves ordinary quoted values alone', () => {
    for (const input of [`entryKey='ascending'`, `sortKey="asc"`, `note='x'`]) expect(redactCredentials(input), input).toBe(input);
  });
});

describe('text glued to an existing marker (#937)', () => {
  it('removes the text after the marker', () => {
    expect(redactCredentials(`token=[redacted]${SECRET}`)).toBe('token=[redacted]');
    expect(redactCredentials(`token=[redacted]${SECRET} more`)).toBe('token=[redacted] more');
  });

  it('leaves a finished marker alone', () => {
    for (const input of ['token=[redacted]', 'token=[redacted], next', 'token=[redacted]\nnext'])
      expect(redactCredentials(input), input).toBe(input);
  });
});

describe('a Pwd or Pass camel ending (#937)', () => {
  it('replaces the value of a Pwd or Pass key', () => {
    expect(redactCredentials(`userPwd=${SECRET}`)).toBe('userPwd=[redacted]');
    expect(redactCredentials(`dbPwd: ${SECRET}`)).toBe('dbPwd: [redacted]');
    expect(redactCredentials(`dbPass="${SECRET}"`)).toBe('dbPass=[redacted]');
    expect(redactCredentials(`user_pwd=${SECRET}`)).toBe('user_pwd=[redacted]');
    expect(redactCredentials(`db-pass=${SECRET}`)).toBe('db-pass=[redacted]');
  });

  it('leaves ordinary pass and pwd words alone', () => {
    for (const input of ['pass=2', 'bypass=on', 'compass=123', 'surpass=true', 'passwordPolicy=strict'])
      expect(redactCredentials(input), input).toBe(input);
  });
});

describe('escaped JSON inside a string (#937)', () => {
  it('replaces the escaped value', () => {
    expect(redactCredentials(`{\\"password\\":\\"${SECRET}\\"}`)).toBe('{\\"password\\":\\"[redacted]\\"}');
    expect(redactCredentials(`\\"token\\":\\"${SECRET}\\"`)).toBe('\\"token\\":\\"[redacted]\\"');
    expect(redactCredentials(`\\"apiSecret\\": \\"${SECRET}\\"`)).toBe('\\"apiSecret\\": \\"[redacted]\\"');
  });

  it('leaves ordinary escaped JSON and prose alone', () => {
    for (const input of ['{\\"note\\":\\"x\\"}', 'a \\"quoted\\" word', '\\"tokens\\":1234'])
      expect(redactCredentials(input), input).toBe(input);
  });
});

describe('URL-encoded pairs (#937)', () => {
  it('replaces the value of an encoded pair', () => {
    expect(redactCredentials(`password%3D${SECRET}`)).toBe('password%3D[redacted]');
    expect(redactCredentials(`a=1&password%3D${SECRET}&b=2`)).toBe('a=1&password%3D[redacted]&b=2');
    expect(redactCredentials(`token%22%3A%22${SECRET}`)).toBe('token%22%3A%22[redacted]');
    expect(redactCredentials(`token%22%3A%22${SECRET}%22`)).toBe('token%22%3A%22[redacted]%22');
  });

  it('decodes an encoded name only to match it', () => {
    expect(redactCredentials(`api%5Fkey=${SECRET}`)).toBe('api%5Fkey=[redacted]');
    expect(redactCredentials(`apiSecret%3D${SECRET}`)).toBe('apiSecret%3D[redacted]');
  });

  it('leaves ordinary encoded text alone', () => {
    for (const input of ['progress%3D50', '100%25done', 'the%20query%20was%20empty', 'note%3Dhello'])
      expect(redactCredentials(input), input).toBe(input);
  });
});

describe('a PEM private key block (#937)', () => {
  const block = (name: string, body: string): string => `-----BEGIN ${name}-----\n${body}\n-----END ${name}-----`;

  it('replaces the whole block, with or without a credential key', () => {
    expect(redactCredentials(block('PRIVATE KEY', SECRET))).toBe('[redacted]');
    expect(redactCredentials(block('RSA PRIVATE KEY', SECRET))).toBe('[redacted]');
    expect(redactCredentials(`password=${block('EC PRIVATE KEY', SECRET)}`)).toBe('password=[redacted]');
    expect(redactCredentials(`see ${block('OPENSSH PRIVATE KEY', SECRET)} here`)).toBe('see [redacted] here');
  });

  it('replaces an unterminated block to the end of the text', () => {
    expect(redactCredentials(`-----BEGIN PRIVATE KEY-----\n${SECRET}`)).toBe('[redacted]');
  });

  it('leaves public blocks and prose alone', () => {
    for (const input of [block('CERTIFICATE', SECRET), block('PUBLIC KEY', SECRET), 'the header -----BEGIN CERTIFICATE----- is public'])
      expect(redactCredentials(input), input).toBe(input);
  });
});

describe('`=>` as the separator (#937)', () => {
  it('replaces the value after the arrow', () => {
    expect(redactCredentials(`'password' => '${SECRET}'`)).toBe("'password' [redacted]");
    expect(redactCredentials(`:password => "${SECRET}"`)).toBe(':password [redacted]');
    expect(redactCredentials(`token => '${SECRET} with spaces'`)).toBe('token [redacted]');
    expect(redactCredentials(`apiSecret => ${SECRET}`)).toBe('apiSecret [redacted]');
  });

  it('replaces a nested pair after the arrow whole', () => {
    const out = redactCredentials(`'password' => organizationSecondaryAuthToken="${SECRET}"`);
    expect(out).not.toContain(SECRET);
  });

  it('leaves an arrow without a credential key alone', () => {
    for (const input of ['result => value', 'const f = (a) => a + 1', 'callback => response', 'entryKey => ascending'])
      expect(redactCredentials(input), input).toBe(input);
  });
});

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
