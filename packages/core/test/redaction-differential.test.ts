import { describe, expect, it } from 'vitest';
import { seededRandom } from '../../../test-support/index';
import { redactCredentials } from '../src/diagnostics';
import { redactCredentials as redact01420 } from './redaction-01420-reference';

// #902 round 5: a standing differential check against the vendor ed 0.14.20 redactor, not only a
// fixed fixture. Its rule is mechanical: a maximal run of non-space characters that 0.14.20 removed
// from the input (present in the input, absent from its output) is a credential, so it must be
// absent from the new output too. A scheme value must also keep its trailing explanation, which is
// what the old implementation did and what A4 broke.
//
// Every generated input ends with a unique sentinel word, so an assertion failure names its case.

const KEYS = [
  'token',
  'access_token',
  'api_key',
  'api-key',
  'secret',
  'password',
  'private_key',
  'client_secret',
  'authToken',
  'apiSecret',
  'secretKey',
  'refresh_token',
  'X-Auth-Token',
  'X-Api-Key',
  'Authorization',
  'auth',
  'credential',
  'session',
  'signature',
  'developer-token',
  'entryKey',
  'monkey',
];
// `=>` is covered by the explicit tests; with a scheme value the old redactor ate the arrow as
// part of the value, which is a formatting difference rather than a leak.
const SEPARATORS = ['=', ': ', ' = ', ':', '= '];
const SECRETS = ['shortpw', 'Sh0rtPw', 'pw-with-dash', 'a b', 'x'];
const VALUES = [
  (secret: string) => secret,
  (secret: string) => `"${secret}"`,
  (secret: string) => `'${secret}'`,
  (secret: string) => `\u201c${secret}\u201d`,
  (secret: string) => `"first\n${secret}"`,
  (secret: string) => `{"apiSecret":"${secret}"}`,
  (secret: string) => `["${secret}","more"]`,
  (secret: string) => `Bearer ${secret}`,
  (secret: string) => `Bearer Bearer ${secret}`,
  (secret: string) => `Basic ${secret}`,
  (secret: string) => `bearer ${secret}`,
  (secret: string) => `-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----`,
];
const TAILS = ['', ' was rejected by the upstream (HTTP 401)', ' failed: 403 Forbidden', '; retry later', '\nnext line', ' and more text'];
const ALPHABET = [
  'a',
  '+',
  ':',
  '/',
  '@',
  '=',
  '>',
  '"',
  "'",
  '\u201c',
  '\u201d',
  '[',
  ']',
  '{',
  '}',
  '\\',
  '-',
  '_',
  '.',
  ' ',
  '\u00a0',
  '\n',
  '\r',
  'Bearer',
  'Basic',
  '-----BEGIN',
  '[redacted]',
  '://',
  'token',
  'key',
  'apiSecret',
];

/** Maximal runs of non-space characters, in order. */
const runs = (text: string): string[] => text.split(/\s+/u).filter((run) => run.length > 0);

interface Generated {
  input: string;
  name: string;
}

let sentinelIndex = 0;
const sentinel = (): string => {
  sentinelIndex += 1;
  return `tail${sentinelIndex}`;
};

/** Keys × separators × value shapes × multi-line values × trailing prose × scheme words. */
function* structured(): Generator<Generated> {
  for (const key of KEYS) {
    for (const separator of SEPARATORS) {
      for (const secret of SECRETS) {
        for (const value of VALUES) {
          for (const tail of TAILS) {
            const marker = sentinel();
            const input = `${key}${separator}${value(secret)}${tail === '' ? '' : tail} ${marker}`;
            yield { input, name: `${key}${separator}${value(secret).slice(0, 20)}${tail}` };
          }
        }
      }
    }
  }
}

/** Free-form text from the scanner's own alphabet, as the fuzz test uses it. */
function* random(): Generator<Generated> {
  const random = seededRandom();
  for (let count = 0; count < 1_500; count += 1) {
    let input = '';
    const length = 1 + Math.floor(random() * 30);
    for (let part = 0; part < length; part += 1) input += ALPHABET[Math.floor(random() * ALPHABET.length)]!;
    yield { input: `${input} ${sentinel()}`, name: `random ${JSON.stringify(input)}` };
  }
}

/**
 * One pair inside another: the new compound-key rule runs before the old rules, so it must never
 * take less than they would have (round 6: `authToken=token="first TOPSECRET last"`,
 * `apiSecret://Basic TOPSECRET`, a backslash before a line break inside an outer quote).
 */
const OUTER_KEYS = [
  'aaaaaaaaaaaaaaaaaaaaaaaaaaAuthToken',
  'organizationSecondarySigningKey',
  'authToken',
  'apiSecret',
  'secretKey',
  'sessionKey',
  'oauthToken',
  'AUTHTOKEN',
  'credentials',
  'meta_adsKey',
];
const INNER_KEYS = ['token', 'password', 'api_key', 'apiSecret', 'authToken', 'secret', 'x-api-key', 'Authorization'];
const NEST_SEPARATORS = ['=', ': ', '://', ' = ', '":"', "='", '="'];
const INNER_VALUES: ((secret: string) => string)[] = [
  (secret) => `"first ${secret} last"`,
  (secret) => `"first\n${secret} last"`,
  (secret) => `'first ${secret} last'`,
  (secret) => `Basic ${secret}`,
  (secret) => `Bearer ${secret}`,
  (secret) => `\\\n${secret}`,
  (secret) => `${secret}`,
  (secret) => `"${secret}`,
];

function* nested(): Generator<Generated> {
  for (const outer of OUTER_KEYS)
    for (const outerSeparator of NEST_SEPARATORS)
      for (const inner of INNER_KEYS)
        for (const innerSeparator of ['=', ': ', '://'])
          for (const value of INNER_VALUES)
            for (const close of ['', '"', "'"]) {
              const input = `${outer}${outerSeparator}${inner}${innerSeparator}${value('TOPSECRET')}${close} ${sentinel()}`;
              yield { input, name: `nested ${JSON.stringify(input)}` };
            }
}

/**
 * Random compositions of keys (old and new), separators, quotes, schemes, markers and secrets:
 * the interactions nobody thought to write down.
 */
const PIECES = [
  ...OUTER_KEYS,
  ...INNER_KEYS,
  'entryKey',
  'note',
  '=',
  ':',
  ': ',
  ' = ',
  '://',
  '"',
  "'",
  ' ',
  '\n',
  '\\',
  ',',
  ';',
  '&',
  '{',
  '}',
  '[',
  ']',
  'Bearer ',
  'Basic ',
  'bearer ',
  '[redacted]',
  'TOPSECRET',
  'Sh0rtPw',
  'user:Sh0rtPw@host',
  'https://',
  '?',
  '/',
];

function* randomPairs(): Generator<Generated> {
  const random = seededRandom();
  for (let count = 0; count < 6_000; count += 1) {
    let input = '';
    const length = 2 + Math.floor(random() * 9);
    for (let part = 0; part < length; part += 1) input += PIECES[Math.floor(random() * PIECES.length)]!;
    yield { input: `${input} ${sentinel()}`, name: `pairs ${JSON.stringify(input)}` };
  }
}

function* generated(): Generator<Generated> {
  yield* structured();
  yield* nested();
  yield* randomPairs();
  yield* random();
}

describe('the new redactor never keeps what 0.14.20 removed (#902 round 5)', () => {
  it('removes every run the old implementation removed', () => {
    const leaks: string[] = [];
    for (const { input, name } of generated()) {
      const before = redact01420(input);
      // Markers are taken out before the comparison: `key:[redacted]` must not count as the run `:[`.
      const after = redactCredentials(input).replaceAll('[redacted]', '\u0000');
      for (const run of runs(input)) {
        if (run.startsWith('tail') && /^tail\d+$/u.test(run)) continue;
        if (before.includes(run)) continue;
        if (after.includes(run)) leaks.push(`${run} kept in ${name}`);
      }
    }
    expect(leaks.slice(0, 10)).toEqual([]);
    expect(leaks).toHaveLength(0);
  });

  it('keeps the explanation after a scheme value, as the old implementation did', () => {
    const lost: string[] = [];
    for (const { input, name } of structured()) {
      if (!/\b(?:Bearer|Basic)\b/iu.test(input)) continue;
      const before = redact01420(input);
      const after = redactCredentials(input);
      // The sentinel is never a credential: if the old output kept it, ours must too.
      const sentinel = /\btail\d+\b/u.exec(input)?.[0];
      if (!sentinel) continue;
      if (before.includes(sentinel) && !after.includes(sentinel)) lost.push(`${sentinel} lost in ${name}`);
    }
    expect(lost.slice(0, 10)).toEqual([]);
    expect(lost).toHaveLength(0);
  });

  it('is idempotent on every generated input', () => {
    const unstable: string[] = [];
    for (const { input, name } of generated()) {
      const once = redactCredentials(input);
      if (redactCredentials(once) !== once) unstable.push(name);
    }
    expect(unstable.slice(0, 10)).toEqual([]);
    expect(unstable).toHaveLength(0);
  });
});
