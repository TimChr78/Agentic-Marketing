import { describe, expect, it } from 'vitest';
import { redactCredentials, releasedRedactionWithOrigins } from '../src/diagnostics';
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

describe('an authorization value behind a key or an arrow (#989 round 4)', () => {
  // `pairValueEnd` stops at the space after a scheme word, so an arrow's value was only the scheme
  // and the token behind it stayed -- and `token=>Bearer abc` even loses the word to the released
  // rule. The region now covers the scheme word(s) and the token.
  it('replaces the token after an arrow, with and without spaces around it', () => {
    expect(idempotent('token => Bearer abc')).toBe('token =[redacted]');
    expect(idempotent('token=>Bearer abcdef')).toBe('token=[redacted]');
    expect(idempotent('token=>Basic S3cr3tV4l')).toBe('token=[redacted]');
    expect(idempotent('apiSecret=>Token abc')).toBe('apiSecret=[redacted]');
    expect(idempotent('apiSecret => Digest abcdef')).toBe('apiSecret =[redacted]');
  });

  it('is case-insensitive and takes repeated scheme words', () => {
    expect(idempotent('token => bearer abc')).toBe('token =[redacted]');
    expect(idempotent('token=>BASIC abc')).toBe('token=[redacted]');
    expect(idempotent('token => Bearer Bearer abc')).toBe('token =[redacted]');
  });

  it('takes a quoted and a tokenless value as before', () => {
    expect(idempotent(`token => 'Bearer ${SECRET}'`)).toBe('token =[redacted]');
    expect(idempotent(`token => "Bearer ${SECRET}"`)).toBe('token =[redacted]');
    expect(idempotent('token => Bearer')).toBe('token =[redacted]');
    expect(idempotent('token => Bearer ')).toBe('token =[redacted] ');
  });

  it('replaces a scheme value the released pass below six characters leaves behind', () => {
    // `bearer`/`basic` keep their released shape after a key; the other schemes have no pass there.
    expect(idempotent('token: Digest abc')).toBe('token: [redacted]');
    expect(idempotent('password: Token abc')).toBe('password: [redacted]');
    expect(idempotent('authToken=Bearer abc')).toBe('authToken=Bearer [redacted]');
    expect(idempotent('token: Bearer abc')).toBe('token: Bearer [redacted]');
  });

  it('takes a mixed scheme chain as one value', () => {
    // The restricted reader accepted `Digest` and read `Bearer` as its token, so the chain stopped
    // one word early (#989 round 5).
    expect(idempotent('token: Digest Bearer abc')).toBe('token: [redacted]');
    expect(idempotent('token: Digest Basic abc')).toBe('token: [redacted]');
    expect(idempotent('Proxy-Authorization: Digest Bearer abc')).toBe('Proxy-Authorization: [redacted]');
    expect(idempotent('token: Bearer Digest abc')).toBe('token: [redacted]');
    expect(idempotent('token: Digest Bearer Bearer abc')).toBe('token: [redacted]');
    expect(idempotent('token => Digest Bearer abc')).toBe('token =[redacted]');
  });

  it('reads a scheme word in prose as a scheme, as agreed', () => {
    // Accepted ambiguity (#989 round 5): after a credential key, a scheme word and the word behind
    // it are a credential far more often than a sentence. 0.14.25 kept `expired`; it now goes with
    // the value, and this expectation is the record of that choice.
    expect(idempotent('token: Token expired at noon')).toBe('token: [redacted] at noon');
    // The same reading at a line end: a scheme word followed by a token-like word on the next line
    // is taken with it (#1019 round 5). Nothing is exposed; the following line is lost with the value.
    expect(idempotent('token: Bearer Token\nstatus=ok')).toBe('token: [redacted]');
    // A two-word value at the very end keeps the released shape.
    expect(idempotent('token: Bearer Token')).toBe('token: Bearer [redacted]');
  });

  it('leaves prose and an ordinary key alone', () => {
    for (const input of ['note: Digest abc', 'the Basic plan is fine', 'sent with Bearer abc'])
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

  it('takes the RFC 1421 preamble of an encrypted block', () => {
    // A traditional encrypted key carries `Proc-Type` and `DEK-Info` lines and a blank line before
    // its base64 body; the key material after them must go too (#989 review).
    const encrypted = (preamble: string, body = 'MIIEowIBAAKCAQEA'): string =>
      `-----BEGIN RSA PRIVATE KEY-----\n${preamble}${body}\n-----END RSA PRIVATE KEY-----`;
    expect(idempotent(encrypted(''))).toBe('[redacted]');
    expect(idempotent(encrypted('Proc-Type: 4,ENCRYPTED\n'))).toBe('[redacted]');
    expect(idempotent(encrypted('Proc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,0123456789ABCDEF\n\n'))).toBe('[redacted]');
    expect(idempotent(encrypted('proc-type: 4,ENCRYPTED\ndek-info: DES-EDE3-CBC,0123456789ABCDEF\n\n'))).toBe('[redacted]');
    // No footer, so the block runs to the end of its body: the preamble and body go, prose stays.
    expect(
      idempotent('-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,0123\n\nMIIEowIBAAKCAQEA\nthen prose'),
    ).toBe('[redacted]\nthen prose');
  });

  it('leaves a preamble-like prose line outside a block alone', () => {
    for (const input of ['Proc-Type: 4,ENCRYPTED is what openssl used', 'DEK-Info: AES-256-CBC,0123456789ABCDEF'])
      expect(idempotent(input), input).toBe(input);
  });

  it('keeps a preamble-like line that runs past the bound', () => {
    // The round-3 review input: a diagnostic line that starts like a preamble but is longer than any
    // real one. It must stay; only the header line goes.
    const diagnostic = `-----BEGIN PRIVATE KEY-----\nProc-Type:${' '.repeat(118)}; ordinary diagnostic\nnext prose`;
    expect(idempotent(diagnostic)).toBe(`[redacted]\nProc-Type:${' '.repeat(118)}; ordinary diagnostic\nnext prose`);
    // One character past the bound and using only preamble characters: also outside the block.
    const long = `Proc-Type:${'A, '.repeat(40)}`;
    const over = `-----BEGIN PRIVATE KEY-----\n${long}\nnext prose`;
    expect(idempotent(over)).toBe(`[redacted]\n${long}\nnext prose`);
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

describe('a field attached to a marker (#989 round 2)', () => {
  // #989 round 1 tried to keep an appended field after a marker the caller sent. That is not safe:
  // the original span says who wrote the marker, never that what follows is harmless
  // (`password=[redacted]"hunter2":"x"`), so the released glue runs unchanged and removes the run.
  it('removes the whole attached run, as the release does', () => {
    expect(idempotent('password=[redacted]"hunter2":"x"')).toBe('password=[redacted]');
    expect(idempotent('token=[redacted]"v":"probeSecret42"')).toBe('token=[redacted]');
    expect(idempotent('token=[redacted]"status":"ok"')).toBe('token=[redacted]');
    expect(idempotent("token=[redacted]'kind':'x'")).toBe('token=[redacted]');
    expect(idempotent(`token=[redacted]${SECRET}`)).toBe('token=[redacted]');
  });

  it('still stops at a credential key it must not consume', () => {
    expect(idempotent(`token=[redacted]apiSecret="${SECRET}"`)).toBe('token=[redacted]apiSecret=[redacted]');
  });
});

describe('the original spans a shape is applied through (#989 round 2)', () => {
  // A kept rule head is copied with each character's own origin, and an inserted marker takes the
  // origin of the position it was inserted at. Before that, a fabricated origin shifted the span of
  // the next value and left `pw` behind.
  it('maps a value after a long key without shifting the next one', () => {
    expect(idempotent('organizationSecondaryAuthToken="x" token: \u201ca pw\u201d token=x')).toBe(
      '[redacted]"[redacted]" token: [redacted] token=[redacted]',
    );
  });

  it('reaches the fixed point in one call when a marker precedes a block', () => {
    const input = `${'token=x apiSecret=x '.repeat(7)}\n-----BEGIN PRIVATE KEY-----\npw\n-----END PRIVATE KEY-----`;
    expect(idempotent(input)).toBe(`${'token=[redacted] apiSecret=[redacted] '.repeat(7)}\n[redacted]`);
  });

  it('keeps every origin monotone and inside the input', () => {
    const inputs = [
      `token=${SECRET}`,
      'organizationSecondaryAuthToken="x" token: \u201ca pw\u201d token=x',
      `password => token:\u201cfirst ${SECRET}\u201d`,
      '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n\nMIIE\n-----END RSA PRIVATE KEY-----',
      `a b c d e f ${SECRET} g h i j`,
      '',
    ];
    for (const input of inputs) {
      const spans = releasedRedactionWithOrigins(input);
      expect(spans.sound, input).toBe(true);
      for (let index = 0; index < spans.origins.length; index += 1) {
        expect(spans.origins[index], input).toBeLessThan(input.length + 1);
        if (index > 0) expect(spans.origins[index]!, input).toBeGreaterThanOrEqual(spans.origins[index - 1]!);
      }
    }
  });

  it('merges two shapes that claim one value', () => {
    // An arrow whose value starts a typographic pair: the union is removed, so no tail survives.
    expect(idempotent(`password => token:\u201cfirst ${SECRET}\u201d`)).toBe('password =[redacted]');
    // The pair is a separate value after the arrow's bare one, so each gets its own marker.
    expect(idempotent(`token => token: \u201ca ${SECRET} b\u201d`)).toBe('token =[redacted] [redacted]');
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
