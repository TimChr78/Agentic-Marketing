import { describe, expect, it } from 'vitest';
import { redactCredentials } from '../src/diagnostics';
import { redactCredentials as released } from './redaction-01424-reference';

// #937: the value shapes the released rules leave behind. Every case here is a shape the issue
// lists, plus the negative cases that must keep their text and the shapes a post-pass cannot take
// safely (documented by asserting the released output, and listed in the pull request).

/** Ten characters: below the 24-character bare-token rule, so only the shape under test can find it. */
const SECRET = 'S3cr3tV4l';

const idempotent = (input: string): string => {
  const once = redactCredentials(input);
  expect(redactCredentials(once), input).toBe(once);
  return once;
};

describe('a structured value under a credential key (#937)', () => {
  // The released pipeline takes the opening bracket as the value and leaves the rest glued to the
  // marker; the marker-glue pass removes that remainder. The closing brackets it does not need stay.
  it('removes an array value', () => {
    expect(idempotent(`{"token":["${SECRET}"]}`)).toBe('{"token":[redacted]]}');
    expect(idempotent(`{"token":["${SECRET}","more"]}`)).toBe('{"token":[redacted]]}');
    expect(idempotent(`token=[${SECRET}]`)).toBe('token=[redacted]]');
  });

  it('removes an object value', () => {
    expect(idempotent(`{"secret":{"v":"${SECRET}"}}`)).toBe('{"secret":[redacted]}}');
    expect(idempotent(`password={"v":"${SECRET}"}`)).toBe('password=[redacted]}');
  });

  it('does not stop at brackets inside a quoted string', () => {
    expect(idempotent(`{"token":["a]b","${SECRET}"]}`)).toBe('{"token":[redacted]]}');
    expect(idempotent(`{"token":{"note":"}","v":"${SECRET}"}}`)).toBe('{"token":[redacted]}}');
  });

  it('removes an unbalanced value', () => {
    expect(idempotent(`{"token":["${SECRET}"`)).toBe('{"token":[redacted]');
    expect(idempotent(`{"token":["${SECRET}",\n"next":1`)).toBe('{"token":[redacted],\n"next":1');
  });

  it('leaves ordinary JSON and counters alone', () => {
    for (const input of ['{"a":["b"],"c":{"d":"e"}}', '{"tokens": 1234}', '{"tokenCount": 12}', 'the list [1,2,3] was returned'])
      expect(idempotent(input), input).toBe(input);
  });
});

describe('text glued to an existing marker (#937)', () => {
  it('removes the whole glued run in one scan', () => {
    expect(idempotent(`token=[redacted]${SECRET}`)).toBe('token=[redacted]');
    expect(idempotent(`token=[redacted]${SECRET} more`)).toBe('token=[redacted] more');
    expect(idempotent("token=[redacted]'x''y''z'")).toBe('token=[redacted]');
  });

  it('reaches the fixed point with 17, 100 and 10,000 fragments in one call', () => {
    for (const count of [17, 100, 10_000]) {
      const input = `token=[redacted]${"'x'".repeat(count - 1)}'${SECRET}'`;
      expect(idempotent(input), `fragments ${count}`).toBe('token=[redacted]');
      const mixed = `token=[redacted]${'\'a\'"b"'.repeat(count)}'${SECRET}'`;
      expect(idempotent(mixed), `mixed fragments ${count}`).toBe('token=[redacted]');
    }
  });

  it('stops before a credential key it must not consume', () => {
    expect(idempotent(`token=[redacted]apiSecret="${SECRET}"`)).toBe('token=[redacted]apiSecret=[redacted]');
  });

  it('leaves a finished marker alone', () => {
    for (const input of ['token=[redacted]', 'token=[redacted]\nnext']) expect(idempotent(input), input).toBe(input);
  });
});

describe('a credential pair nested in another pair (#937)', () => {
  it('replaces the whole nested pair', () => {
    expect(idempotent(`SIGNINGKEY=AZUREOPENAIKEY='${SECRET}'`)).toBe('SIGNINGKEY=[redacted]');
    expect(idempotent(`AZUREOPENAIKEY=apiSecret='${SECRET}'`)).toBe('AZUREOPENAIKEY=[redacted]');
    expect(idempotent(`authToken=apiSecret="${SECRET}"`)).toBe('authToken=[redacted]');
  });

  it('leaves ordinary quoted values alone', () => {
    for (const input of [`entryKey='ascending'`, `sortKey="asc"`, `note='x'`]) expect(idempotent(input), input).toBe(input);
  });
});

describe('a typographic-quoted value is skipped (#937 follow-up)', () => {
  // The post-pipeline output (`token: [redacted] pw”`) has lost the opening quote, so a pass cannot
  // tell the remainder from ordinary text. These assert the released output exactly; a follow-up
  // needs the original input context (#937 review round 2).
  it('leaves the released output for every quote pair', () => {
    const pairs: [string, string][] = [
      ['\u201c', '\u201d'],
      ['\u2018', '\u2019'],
      ['\u00ab', '\u00bb'],
      ['\u201e', '\u201c'],
      ['\u2039', '\u203a'],
    ];
    for (const [open, close] of pairs) {
      const input = `token: ${open}${SECRET} with spaces${close}`;
      expect(idempotent(input), open).toBe(released(input));
    }
    expect(idempotent(`token: \u201cshort pw\nnext`)).toBe(released(`token: \u201cshort pw\nnext`));
  });

  it('does not over-redact ordinary text after a marker', () => {
    const input = 'token: [redacted] ordinary diagnostics; operator said \u201cok\u201d.';
    expect(idempotent(input)).toBe(released(input));
  });
});

describe('`=>` is skipped (#937 follow-up)', () => {
  // The released rule takes `>` as the value, leaving `key =[redacted] 'x'`; nothing in that output
  // proves the separator was `=>`, so a follow-up needs the original input. These assert the
  // released output exactly.
  it('leaves the released output for quoted, bare and nested arrow values', () => {
    for (const input of [
      `'password' => '${SECRET}'`,
      `:password => "${SECRET}"`,
      `token => '${SECRET} with spaces'`,
      `apiSecret => ${SECRET}`,
      `'password' => organizationSecondaryAuthToken="${SECRET}"`,
    ])
      expect(idempotent(input), input).toBe(released(input));
  });

  it('does not over-redact ordinary markers', () => {
    for (const input of ['token=[redacted] "status":"ok"', 'token=[redacted] "service recovered" "request completed"'])
      expect(idempotent(input), input).toBe(released(input));
  });

  it('leaves an arrow without a credential key alone', () => {
    for (const input of ['result => value', 'const f = (a) => a + 1', 'callback => response', 'entryKey => ascending'])
      expect(idempotent(input), input).toBe(released(input));
  });
});

describe('a PEM private key block (#937)', () => {
  const block = (name: string, body: string): string => `-----BEGIN ${name}-----\n${body}\n-----END ${name}-----`;

  it('replaces a line-start block, standalone or under a credential key', () => {
    expect(idempotent(block('PRIVATE KEY', SECRET))).toBe('[redacted]');
    expect(idempotent(block('RSA PRIVATE KEY', SECRET))).toBe('[redacted]');
    expect(idempotent(`see\n${block('OPENSSH PRIVATE KEY', SECRET)}`)).toBe('see\n[redacted]');
    expect(idempotent(`password=${block('EC PRIVATE KEY', SECRET)}`)).toBe('password=[redacted]');
  });

  it('replaces an unterminated line-start block to the end of the text', () => {
    expect(idempotent(`-----BEGIN PRIVATE KEY-----\n${SECRET}`)).toBe('[redacted]');
  });

  it('leaves a mid-line header, a quoted mention, public blocks and prose alone', () => {
    for (const input of [
      `see ${block('RSA PRIVATE KEY', SECRET)} here`,
      'note="-----BEGIN PRIVATE KEY-----" status="ok"\nmore ordinary diagnostics',
      block('CERTIFICATE', SECRET),
      block('PUBLIC KEY', SECRET),
      'the header -----BEGIN CERTIFICATE----- is public',
    ])
      expect(idempotent(input), input).toBe(released(input));
  });
});

describe('a short Authorization value under a credential key (#937)', () => {
  it('replaces the token after the scheme and keeps the scheme word', () => {
    expect(idempotent('authToken=Bearer abc')).toBe('authToken=Bearer [redacted]');
    expect(idempotent('password: Basic xyz')).toBe('password: Basic [redacted]');
    expect(idempotent('authorization: bearer abc')).toBe('authorization: bearer [redacted]');
  });

  it('leaves a scheme without a value, and prose, alone', () => {
    for (const input of ['sent with Bearer abc', 'the Basic plan is fine']) expect(idempotent(input), input).toBe(input);
  });
});

describe('a Pwd or Pass camel ending (#937)', () => {
  it('replaces the value of a Pwd or Pass key', () => {
    expect(idempotent(`userPwd=${SECRET}`)).toBe('userPwd=[redacted]');
    expect(idempotent(`dbPwd: ${SECRET}`)).toBe('dbPwd: [redacted]');
    expect(idempotent(`dbPass="${SECRET}"`)).toBe('dbPass=[redacted]');
    expect(idempotent(`user_pwd=${SECRET}`)).toBe('user_pwd=[redacted]');
    expect(idempotent(`db-pass=${SECRET}`)).toBe('db-pass=[redacted]');
  });

  it('leaves ordinary pass and pwd words alone', () => {
    for (const input of ['pass=2', 'bypass=on', 'compass=123', 'surpass=true', 'passwordPolicy=strict'])
      expect(idempotent(input), input).toBe(input);
  });
});

describe('escaped JSON inside a string (#937)', () => {
  it('replaces the escaped value', () => {
    expect(idempotent(`{\\"password\\":\\"${SECRET}\\"}`)).toBe('{\\"password\\":\\"[redacted]\\"}');
    expect(idempotent(`\\"token\\":\\"${SECRET}\\"`)).toBe('\\"token\\":\\"[redacted]\\"');
    expect(idempotent(`\\"apiSecret\\": \\"${SECRET}\\"`)).toBe('\\"apiSecret\\": \\"[redacted]\\"');
  });

  it('leaves ordinary escaped JSON and prose alone', () => {
    for (const input of ['{\\"note\\":\\"x\\"}', 'a \\"quoted\\" word', '\\"tokens\\":1234']) expect(idempotent(input), input).toBe(input);
  });
});

describe('URL-encoded pairs (#937)', () => {
  it('replaces the value of an encoded pair', () => {
    expect(idempotent(`password%3D${SECRET}`)).toBe('password%3D[redacted]');
    expect(idempotent(`a=1&password%3D${SECRET}&b=2`)).toBe('a=1&password%3D[redacted]&b=2');
    expect(idempotent(`token%22%3A%22${SECRET}`)).toBe('token%22%3A%22[redacted]');
    expect(idempotent(`token%22%3A%22${SECRET}%22`)).toBe('token%22%3A%22[redacted]%22');
  });

  it('decodes an encoded name only to match it', () => {
    expect(idempotent(`api%5Fkey=${SECRET}`)).toBe('api%5Fkey=[redacted]');
    expect(idempotent(`apiSecret%3D${SECRET}`)).toBe('apiSecret%3D[redacted]');
  });

  it('leaves ordinary encoded text alone', () => {
    for (const input of ['progress%3D50', '100%25done', 'the%20query%20was%20empty', 'note%3Dhello'])
      expect(idempotent(input), input).toBe(input);
  });
});
