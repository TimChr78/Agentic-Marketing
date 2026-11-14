import { describe, expect, it } from 'vitest';
import { seededRandom } from '../../../test-support/index';
import { expectLinear } from '../../../test-support/linear';
import { redactCredentials } from '../src/diagnostics';

// #898/#902/#920 round 2: the credential redaction is one scan over the text, so it has properties
// a table of examples cannot show: no planted secret survives whatever form the value takes, a
// second pass changes nothing, and the work grows linearly with the input.

/** Ten characters: below the 24-character bare-token rule, so only the key or the URL rule can find it. */
const SECRET = 'S3cr3tV4l';
/** Half of it, so a truncated redaction is still caught. */
const SECRET_PART = 'S3cr3t';

/**
 * Credential keys in every spelling the rule must recognise. A compound ending in `key` is here
 * only when a qualifier precedes it (#898 round 2); `ORDINARY_KEYS` holds the fields that must keep
 * their text.
 */
const KEYS = [
  'token',
  'authToken',
  'apiSecret',
  'secretKey',
  'X-Auth-Token',
  'access_token',
  'signingKey',
  'sessionKey',
  'password',
  'oauthToken',
  'api-key',
  'credentials',
  'refreshToken',
  'x-api-key',
  'X-Auth-Key',
  'API_KEY',
  'secret_access_key',
  'clientKey',
  'consumer_key',
  'hmacKey',
  'vaultKey',
  'twilioKey',
];

/** Ordinary fields ending in `Key` (or `keyId`): their values must come out unchanged. */
const ORDINARY_KEYS = [
  'entryKey',
  'idempotencyKey',
  'sortKey',
  'primaryKey',
  'partitionKey',
  'cacheKey',
  'dedupeKey',
  'foreignKey',
  'groupKey',
  'storeKey',
  'messageKey',
  'routingKey',
  'keyId',
];

/** An ordinary, non-secret value of the kind those fields carry. */
const ORDINARY_VALUES = [
  'step "a" does not exist',
  'must be 1–200 printable characters',
  'unknown column name',
  '(none)',
  'ascending',
  'not set',
  'utf8',
];

/** Innocuous surrounding text, and the words a fragment must never be mistaken for. */
const PROSE = [
  'the gateway answered',
  'HTTP 502:',
  'while calling',
  'error code INVALID_AUTHENTICATION_CREDENTIALS',
  'at 12:30 on',
  'see https://example.com/docs',
  'a plain sentence.',
  'monkey business',
  'author of the note',
  'tokenizer failed',
];

/** How a value carrying the secret can be written, given a key. */
const FORMS: ((key: string) => string)[] = [
  (key) => `${key}=${SECRET}`,
  (key) => `${key}: ${SECRET}`,
  (key) => `${key} = ${SECRET}`,
  (key) => `${key}="${SECRET}"`,
  (key) => `${key}='${SECRET}'`,
  (key) => `{"${key}":"${SECRET}"}`,
  (key) => `{"${key}": ["${SECRET}"]}`,
  (key) => `{"${key}":{"value":"${SECRET}"}}`,
  (key) => `${key}=[{"a":"${SECRET}"}]`,
  (key) => `${key}=Bearer ${SECRET}`,
  (key) => `${key}=Basic ${SECRET}`,
  (key) => `${key}=postgres://user:${SECRET}@db:5432/am`,
  () => `postgres://user:${SECRET}@db/am`,
  () => `redis://:${SECRET}@cache:6379`,
  (key) => `hint=${key}=${SECRET}`,
  (key) => `url?${key}=${SECRET}&x=1`,
  (key) => `X-${key}: ${SECRET}`,
  (key) => `{"a":"b","${key}":{"deep":"${SECRET}"}}`,
];

function randomCase(random: () => number): string {
  const key = KEYS[Math.floor(random() * KEYS.length)]!;
  const form = FORMS[Math.floor(random() * FORMS.length)]!(key);
  const before = PROSE[Math.floor(random() * PROSE.length)]!;
  const after = PROSE[Math.floor(random() * PROSE.length)]!;
  const joiner = random() < 0.5 ? ' ' : '\n';
  return random() < 0.2
    ? `${before}${joiner}${form}`
    : random() < 0.4
      ? `${form}${joiner}${after}`
      : `${before}${joiner}${form}${joiner}${after}`;
}

describe('the credential redaction on generated cases (#898, #902, #920)', () => {
  it('never leaves a planted secret, and a second pass changes nothing', () => {
    const random = seededRandom();
    const planted = 3_000;
    const survivors: string[] = [];
    const unstable: string[] = [];
    for (let index = 0; index < planted; index += 1) {
      const input = randomCase(random);
      const once = redactCredentials(input);
      if (once.includes(SECRET_PART)) survivors.push(input);
      if (redactCredentials(once) !== once) unstable.push(input);
    }
    expect(survivors.slice(0, 5)).toEqual([]);
    expect(survivors).toHaveLength(0);
    expect(unstable.slice(0, 5)).toEqual([]);
    expect(unstable).toHaveLength(0);
  });

  it('keeps an ordinary …Key field with an ordinary value exactly as it is', () => {
    const random = seededRandom();
    const changed: string[] = [];
    for (let index = 0; index < 600; index += 1) {
      const field = ORDINARY_KEYS[Math.floor(random() * ORDINARY_KEYS.length)]!;
      const value = ORDINARY_VALUES[Math.floor(random() * ORDINARY_VALUES.length)]!;
      const before = PROSE[Math.floor(random() * PROSE.length)]!;
      const separator = random() < 0.5 ? ': ' : '=';
      const input = `${before} ${field}${separator}${value}`;
      if (redactCredentials(input) !== input) changed.push(input);
    }
    expect(changed.slice(0, 5)).toEqual([]);
    expect(changed).toHaveLength(0);
  });

  it('covers every form with at least one generated case', () => {
    for (const [index, form] of FORMS.entries()) {
      const key = KEYS[index % KEYS.length]!;
      expect(redactCredentials(form(key)), `form ${index}`).not.toContain(SECRET_PART);
    }
  });
});

describe('random input never breaks the scanner (#902 round 3)', () => {
  // An alphabet biased to the scanner's own special characters: separators, quotes (ASCII and
  // Unicode), structures, escapes, URL punctuation, schemes, markers and the whitespace that ends
  // a value (including NBSP and U+2028).
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
    '\u2028',
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

  it('never throws, stays idempotent and finishes every case quickly', () => {
    const random = seededRandom();
    const failures: string[] = [];
    for (let index = 0; index < 3_000; index += 1) {
      let input = '';
      const length = 1 + Math.floor(random() * 40);
      for (let part = 0; part < length; part += 1) input += ALPHABET[Math.floor(random() * ALPHABET.length)]!;
      const started = performance.now();
      let out: string;
      try {
        out = redactCredentials(input);
      } catch {
        failures.push(`threw on ${JSON.stringify(input)}`);
        continue;
      }
      if (performance.now() - started > 50) failures.push(`slow on ${JSON.stringify(input)}`);
      if (redactCredentials(out) !== out) failures.push(`unstable on ${JSON.stringify(input)}`);
    }
    expect(failures.slice(0, 5)).toEqual([]);
    expect(failures).toHaveLength(0);
  });
});

describe('the credential redaction scales with the text (#902 round 2)', () => {
  const shapes: [string, (n: number) => string][] = [
    ['repeated pairs ending in a secret', (n) => `${'token='.repeat(n)}shortpw`],
    ['a run of scheme characters and plus signs', (n) => 'a+'.repeat(n)],
    ['repeated Bearer words', (n) => 'Bearer '.repeat(n)],
    ['repeated scheme separators', (n) => 'a://'.repeat(n)],
    ['repeated markers', (n) => '[redacted]'.repeat(n)],
    ['a run of double quotes', (n) => '"'.repeat(n)],
    ['a run of open braces', (n) => '{'.repeat(n)],
    ['repeated key= pairs', (n) => 'key='.repeat(n)],
    ['repeated PEM beginnings', (n) => '-----BEGIN '.repeat(n)],
    ['a long colon run after a key', (n) => `token:${':'.repeat(n * 4)}`],
    ['a long equals run after a key', (n) => `token=${'='.repeat(n * 4)}`],
    ['a long quote run after a key', (n) => `token="${'"'.repeat(n * 4)}`],
    ['a long bracket run after a key', (n) => `token=apiSecret=${'['.repeat(n * 4)}`],
    ['a long brace run after a key', (n) => `secret=${'{'.repeat(n * 4)}`],
    ['a long at run in a URL authority', (n) => `http://u:pw@${'@'.repeat(n * 4)}`],
    ['a PEM under a credential key', (n) => `password=${'-----BEGIN X-----'.repeat(n)}`],
    ['prose with keys and no separators', (n) => 'token '.repeat(n)],
  ];
  for (const [name, build] of shapes) it(`is linear: ${name}`, () => expectLinear(build, redactCredentials, 2_000));
});
