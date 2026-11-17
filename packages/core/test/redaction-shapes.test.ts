import { describe, expect, it } from 'vitest';
import { redactCredentials } from '../src/diagnostics';
import { redactCredentials as released } from './redaction-01424-reference';

// #937/#989: the value shapes the released rules leave behind. Every case here is a shape an issue
// lists, plus the negative cases that must keep their text. The shapes only the original text can
// prove (PEM, typographic quotes, `=>`, a field attached to a marker) are decided from the original
// spans and carried into the released output (#989).

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

describe('a typographic-quoted value (#989)', () => {
  // The released pipeline takes only up to the first space (`token: [redacted] pw”`); the shape is
  // read from the original text, so the whole value goes and only its own closing quote ends it.
  it('replaces the whole value for every quote pair', () => {
    const pairs: [string, string][] = [
      ['\u201c', '\u201d'],
      ['\u2018', '\u2019'],
      ['\u00ab', '\u00bb'],
      ['\u201e', '\u201c'],
      ['\u2039', '\u203a'],
    ];
    for (const [open, close] of pairs) {
      expect(idempotent(`token: ${open}${SECRET} with spaces${close}`), open).toBe('token: [redacted]');
    }
  });

  it('stops at the matching closer of the same pair', () => {
    expect(idempotent(`token: \u201c${SECRET}\u201d and \u201cok\u201d`)).toBe('token: [redacted] and \u201cok\u201d');
    expect(idempotent(`token: \u201c${SECRET}\u201d\nnext`)).toBe('token: [redacted]\nnext');
  });

  it('ends an unclosed value at its line, so the next line stays readable', () => {
    expect(idempotent('token: \u201cshort pw\nnext')).toBe('token: [redacted]\nnext');
  });

  it('does not over-redact ordinary text after a marker', () => {
    const input = 'token: [redacted] ordinary diagnostics; operator said \u201cok\u201d.';
    expect(idempotent(input)).toBe(input);
  });

  it('leaves a typographic quote without a credential key alone', () => {
    for (const input of [`note: \u201c${SECRET} with spaces\u201d`, `the operator said \u201c${SECRET}\u201d`])
      expect(idempotent(input), input).toBe(input);
  });
});

describe('a `=>` separator (#989)', () => {
  // The released rule reads the `>` as the value (`'password' =[redacted] 'x'`); the arrow is read
  // from the original text, so the value after it goes too.
  it('replaces quoted, bare and nested values', () => {
    expect(idempotent(`'password' => '${SECRET}'`)).toBe("'password' =[redacted]");
    expect(idempotent(`:password => "${SECRET}"`)).toBe(':password =[redacted]');
    expect(idempotent(`token => '${SECRET} with spaces'`)).toBe('token =[redacted]');
    expect(idempotent(`apiSecret => ${SECRET}`)).toBe('apiSecret =[redacted]');
    expect(idempotent(`dbPass => '${SECRET}'`)).toBe('dbPass =[redacted]');
    expect(idempotent(`token => \u201c${SECRET} with spaces\u201d`)).toBe('token =[redacted]');
    expect(idempotent(`'password' => organizationSecondaryAuthToken="${SECRET}"`)).toBe("'password' =[redacted]");
  });

  it('does not over-redact ordinary markers', () => {
    for (const input of ['token=[redacted] "status":"ok"', 'token=[redacted] "service recovered" "request completed"'])
      expect(idempotent(input), input).toBe(input);
  });

  it('leaves an arrow without a credential key alone', () => {
    for (const input of ['result => value', 'const f = (a) => a + 1', 'callback => response', 'entryKey => ascending'])
      expect(idempotent(input), input).toBe(input);
  });
});

describe('a PEM private key block (#989)', () => {
  const block = (name: string, body: string): string => `-----BEGIN ${name}-----\n${body}\n-----END ${name}-----`;

  it('replaces a standalone block whole', () => {
    for (const name of ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY'])
      expect(idempotent(block(name, SECRET)), name).toBe('[redacted]');
    expect(idempotent(`${block('PRIVATE KEY', 'MIIEowIBAAKCAQEA')}\nnext line`)).toBe('[redacted]\nnext line');
    expect(idempotent(`a diagnostic\n${block('PRIVATE KEY', SECRET)}`)).toBe('a diagnostic\n[redacted]');
  });

  it('replaces a block under a credential key', () => {
    expect(idempotent(`password=${block('EC PRIVATE KEY', SECRET)}`)).toBe('password=[redacted]');
    expect(idempotent(`token = ${block('RSA PRIVATE KEY', SECRET)}`)).toBe('token = [redacted]');
  });

  it('requires the footer label to match the header label', () => {
    // `-----END EC PRIVATE KEY-----` cannot end an RSA block: the body is still redacted, the stray
    // footer (no secret) stays.
    expect(idempotent(`-----BEGIN RSA PRIVATE KEY-----\n${SECRET}\n-----END EC PRIVATE KEY-----`)).toBe(
      '[redacted]\n-----END EC PRIVATE KEY-----',
    );
    expect(idempotent(`${block('RSA PRIVATE KEY', SECRET)}\n-----END EC PRIVATE KEY-----`)).toBe(
      '[redacted]\n-----END EC PRIVATE KEY-----',
    );
  });

  it('is not suppressed by an apostrophe in prose', () => {
    // The round-2/3 bug: a quote tracker read `can't` as an opening quote and skipped the block.
    expect(idempotent(`can't load key\n${block('PRIVATE KEY', SECRET)}`)).toBe("can't load key\n[redacted]");
    expect(idempotent(`it's the operator's key\n${block('RSA PRIVATE KEY', SECRET)}`)).toBe("it's the operator's key\n[redacted]");
  });

  it('takes an unterminated block only as far as its body', () => {
    // No footer: the header and every following base64 line go, the next prose line stays.
    expect(idempotent(`-----BEGIN PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nthen prose`)).toBe('[redacted]\nthen prose');
    expect(idempotent(`password=-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n`)).toBe('password=[redacted]\n');
    expect(idempotent('-----BEGIN PRIVATE KEY-----')).toBe('[redacted]');
  });

  it('reads a run of headers without a footer once (#989 round 1)', () => {
    // The round-3 review input: a keyed header repeated, and only an unrelated footer at the end.
    // Each header is read with its own line, so the scan stays linear and nothing is a block.
    const input = `${'password=[redacted] RSA PRIVATE KEY-----\n'.repeat(1_024)}-----END PUBLIC KEY-----`;
    expect(idempotent(input)).toBe(released(input));
  });

  it('leaves public blocks, mid-line mentions and prose alone', () => {
    for (const input of [
      block('CERTIFICATE', SECRET),
      block('PUBLIC KEY', SECRET),
      'the header -----BEGIN CERTIFICATE----- is public',
      `see -----BEGIN RSA PRIVATE KEY-----\n${SECRET}\n-----END RSA PRIVATE KEY----- here`,
      'note="-----BEGIN PRIVATE KEY-----" status="ok"\nmore ordinary diagnostics',
    ])
      expect(idempotent(input), input).toBe(input);
  });
});

describe('a field attached to a marker (#989)', () => {
  // #979 removed every run glued to a marker, because attachment alone cannot tell a credential
  // remainder from an appended field. The original span does: a marker the caller sent is not
  // evidence that a value ended there, so an appended field keeps its text.
  it('keeps an appended field after a marker the caller sent', () => {
    for (const input of ['token=[redacted]"status":"ok"', 'token=[redacted]"status":"ok","error":"x"', "token=[redacted]'kind':'x'"])
      expect(idempotent(input), input).toBe(input);
  });

  it('still removes a bare or chained remainder, which may be a credential tail', () => {
    expect(idempotent(`token=[redacted]${SECRET}`)).toBe('token=[redacted]');
    expect(idempotent("token=[redacted]'x''y''z'")).toBe('token=[redacted]');
    expect(idempotent('token=[redacted]"a","b"')).toBe('token=[redacted]');
  });

  it('keeps removing a field after a marker the pipeline produced', () => {
    // Here the released pipeline did replace a value at that position, so the attached run may be
    // its remainder: the additive rule wins over the field shape.
    expect(idempotent('token=abc"status":"ok"')).toBe('token=[redacted]');
    expect(idempotent(`{"token":{"v":"${SECRET}"}}`)).toBe('{"token":[redacted]}}');
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
