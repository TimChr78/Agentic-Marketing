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

/** Credential keys in every spelling the rule must recognise. */
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
  (key) => `{"a":"b","${key}"={"deep":"${SECRET}"}}`.replace('"${key}"=', `"${key}":`),
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

  it('covers every form with at least one generated case', () => {
    for (const [index, form] of FORMS.entries()) {
      const key = KEYS[index % KEYS.length]!;
      expect(redactCredentials(form(key)), `form ${index}`).not.toContain(SECRET_PART);
    }
  });
});

describe('the credential redaction scales with the text (#902 round 2)', () => {
  const shapes: [string, (n: number) => string][] = [
    ['repeated pairs ending in a secret', (n) => 'token='.repeat(n) + 'shortpw'],
    ['a long colon run after a key', (n) => `token:${':'.repeat(n * 4)}`],
    ['a long equals run after a key', (n) => `token=${'='.repeat(n * 4)}`],
    ['a long quote run after a key', (n) => `token="${'"'.repeat(n * 4)}`],
    ['a long bracket run after a key', (n) => `token=apiSecret=${'['.repeat(n * 4)}`],
    ['a long brace run after a key', (n) => `secret=${'{'.repeat(n * 4)}`],
    ['a long at run in a URL authority', (n) => `http://u:pw@${'@'.repeat(n * 4)}`],
    ['repeated scheme separators', (n) => 'a://'.repeat(n)],
    ['repeated PEM beginnings', (n) => `password=${'-----BEGIN X-----'.repeat(n)}`],
    ['prose with keys and no separators', (n) => 'token '.repeat(n)],
  ];
  for (const [name, build] of shapes) it(`is linear: ${name}`, () => expectLinear(build, redactCredentials, 2_000));
});
