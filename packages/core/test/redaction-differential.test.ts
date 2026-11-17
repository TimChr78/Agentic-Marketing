import { describe, expect, it, vi } from 'vitest';
import { seededRandom } from '../../../test-support/index';
import { redactCredentials, redactionFallbacks, releasedRedaction } from '../src/diagnostics';
import { redactCredentials as releasedGuardRedaction } from '../src/redaction-01425';
import { redactCredentials as redact01420 } from './redaction-01420-reference';
import { redactCredentials as redact01423 } from './redaction-01423-reference';
import { redactCredentials as redact01424 } from './redaction-01424-reference';
import { redactCredentials as redact01425 } from './redaction-01425-reference';

// #902 round 5: a standing differential check against the vendored 0.14.20 redactor, not only a
// fixed fixture. Its rule is mechanical: a maximal run of non-space characters that 0.14.20 removed
// from the input (present in the input, absent from its output) is a credential, so it must be
// absent from the new output too. A scheme value must also keep its trailing explanation, which is
// what the old implementation did and what A4 broke.
//
// The same differential runs against the 0.14.23 redactor (the release this batch started from, #946
// and #956): whatever it removed must stay removed, and a second pass must change nothing. New code
// may only remove more, never less. The 0.14.25 reference (#979) is the release the #989 spans build
// on, and it is also the byte-for-byte baseline of the instrumented pipeline.
//
// Every generated input ends with a unique sentinel word, so an assertion failure names its case.

/**
 * Multiplies the free-form generators. The structured ones are exhaustive and need no scaling; a
 * large run for the release gate sets `REDACTION_DIFFERENTIAL_SCALE=160` (about 1.3 million cases).
 */
// Each comparison runs every generated case through several full redactor implementations. On a
// loaded CI runner one of them took longer than the global 20 s test timeout (release 0.14.25 CI),
// so this file raises the per-test ceiling; growth is guarded by the scaling tests elsewhere. The
// #989 pipeline records the original-text span of every character it keeps, and every shaped case
// also runs the frozen release as a guard, so the ceiling leaves room for the release-gate run at
// scale 160.
vi.setConfig({ testTimeout: 900_000 });

const SCALE = Math.max(1, Math.floor(Number(process.env.REDACTION_DIFFERENTIAL_SCALE) || 1));

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
  // #946/#956 shapes: the 0.14.23 code leaves them, so the differential only requires that the new
  // code does not undo anything it did remove around them.
  '_secretKey',
  '__authToken',
  '$$SIGNINGKEY',
  'mistralKey',
  'lmStudioKey',
  'openrouterKey',
  'vllmKey',
  'ollamaKey',
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
  /** Values planted in this input, each unique so a failure cannot match text from another part. */
  secrets: string[];
}

let sentinelIndex = 0;
const sentinel = (): string => {
  sentinelIndex += 1;
  return `tail${sentinelIndex}`;
};

/**
 * A unique, short token appended to (or inside) every planted value. Without it, a short value such
 * as `x` occurs elsewhere in the input (`x-api-key`), and "did the reference remove it" cannot be
 * answered for that occurrence. The token is not a credential by itself, so only the reference's
 * own decision on the surrounding value is measured.
 */
let markerIndex = 0;
const marker = (): string => {
  markerIndex += 1;
  return `Qa${markerIndex}Zx`;
};

/** Put the marker inside a quoted value, or append it to a bare one. */
function plantValue(value: string, token: string): string {
  const first = value.charAt(0);
  const last = value.charAt(value.length - 1);
  if (value.length >= 2 && ((first === '"' && last === '"') || (first === "'" && last === "'")))
    return `${first}${value.slice(1, -1)}${token}${last}`;
  return `${value}${token}`;
}

/** Keys × separators × value shapes × multi-line values × trailing prose × scheme words. */
function* structured(): Generator<Generated> {
  for (const key of KEYS) {
    for (const separator of SEPARATORS) {
      for (const secret of SECRETS) {
        for (const value of VALUES) {
          for (const tail of TAILS) {
            const token = marker();
            const planted = `${secret}${token}`;
            const sentinelWord = sentinel();
            const input = `${key}${separator}${value(planted)}${tail === '' ? '' : tail} ${sentinelWord}`;
            yield { input, name: `${key}${separator}${value(planted).slice(0, 20)}${tail}`, secrets: [token] };
          }
        }
      }
    }
  }
}

/** Free-form text from the scanner's own alphabet, as the fuzz test uses it. */
function* random(): Generator<Generated> {
  const random = seededRandom();
  for (let count = 0; count < 1_500 * SCALE; count += 1) {
    let input = '';
    const length = 1 + Math.floor(random() * 30);
    for (let part = 0; part < length; part += 1) input += ALPHABET[Math.floor(random() * ALPHABET.length)]!;
    const token = marker();
    yield {
      input: `${input} password=${token} ${sentinel()}`,
      name: `random ${JSON.stringify(input)}`,
      secrets: [token],
    };
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
  // #946/#956 shapes in a nested position too.
  '_secretKey',
  '__authToken',
  '$$SIGNINGKEY',
  '.sessionKey',
  '-oauthToken',
  'lmStudioKey',
  'X-lmStudioKey',
  'mistralKey',
  'vertexKey',
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
              const token = marker();
              const planted = `TOPSECRET${token}`;
              const input = `${outer}${outerSeparator}${inner}${innerSeparator}${value(planted)}${close} ${sentinel()}`;
              yield { input, name: `nested ${JSON.stringify(input)}`, secrets: [token] };
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
  '_a_b_c',
  '$$authToken',
  'lmStudioKey',
  'vertexKey',
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
  '"x"',
  "'x'",
  '="x"',
  '=x',
  'user:Sh0rtPw@host',
  'https://',
  '?',
  '/',
];

/** Pieces that carry a credential value, so the marker can be planted inside the payload. */
const VALUE_PIECES = new Set(['TOPSECRET', 'Sh0rtPw', '"x"', "'x'", '="x"', '=x', 'user:Sh0rtPw@host']);
/** Names that start with a separator, injected inside the random payload (#946, #968 review). */
const PREFIXED_KEYS = ['_secretKey', '__authToken', '$$SIGNINGKEY', '.sessionKey', '-oauthToken', 'mistralKey'];

/** A unique marker inside a piece, so the payload's own value is tracked, not only an appended one. */
function markPiece(piece: string, token: string): string {
  // The marker must sit in the part main removes. In a URL userinfo that is the password, not the
  // host (`https://user:Sh0rtPwQa@host`), otherwise main leaves it and the check skips the case
  // (#968 round 3).
  if (piece.startsWith('user:Sh0rtPw@')) return piece.replace('Sh0rtPw@', `Sh0rtPw${token}@`);
  return plantValue(piece, token);
}

function* randomPairs(): Generator<Generated> {
  const random = seededRandom();
  for (let count = 0; count < 6_000 * SCALE; count += 1) {
    const parts: string[] = [];
    const length = 2 + Math.floor(random() * 9);
    for (let part = 0; part < length; part += 1) parts.push(PIECES[Math.floor(random() * PIECES.length)]!);
    const secrets: string[] = [];
    // Mark one value piece inside the payload itself.
    const valueIndexes = parts.map((piece, index) => (VALUE_PIECES.has(piece) ? index : -1)).filter((index) => index >= 0);
    if (valueIndexes.length) {
      const at = valueIndexes[Math.floor(random() * valueIndexes.length)]!;
      const token = marker();
      parts[at] = markPiece(parts[at]!, token);
      secrets.push(token);
    }
    // And plant a credential pair whose name starts with a separator.
    const token = marker();
    const key = PREFIXED_KEYS[Math.floor(random() * PREFIXED_KEYS.length)]!;
    const separator = ['=', ': ', ' = '][Math.floor(random() * 3)]!;
    parts.splice(Math.floor(random() * (parts.length + 1)), 0, `${key}${separator}${token}`);
    secrets.push(token);
    const input = parts.join('');
    yield { input: `${input} ${sentinel()}`, name: `pairs ${JSON.stringify(input)}`, secrets };
  }
}

/** The regression inputs from the round-2 review, with the leading-separator variants (#968). */
function* findings(): Generator<Generated> {
  for (const prefix of ['_', '__', '.', '-', '$', '$$']) {
    for (const key of ['secretKey', 'userPassword', 'authToken']) {
      const token = marker();
      const input = `${prefix}${key}=apiSecret :''TOPSECRET${token}`;
      yield { input: `${input} ${sentinel()}`, name: `finding ${JSON.stringify(input)}`, secrets: [token] };
      const paired = marker();
      yield {
        input: `${prefix}${key}=apiSecret :''TOPSECRET${token} password=${paired} ${sentinel()}`,
        name: `finding paired ${prefix}${key}`,
        secrets: [token, paired],
      };
    }
  }
}

/**
 * The pre-pass for long keys is the only code that runs before the old rules, so it gets its own
 * cases: a long key with a plain value inside every context an old rule reads (an outer quoted
 * value, a scheme, a nested pair, a URL, a token run).
 */
const LONG_KEYS = ['organizationSecondaryAuthToken', 'aaaaaaaaaaaaaaaaaaaaaaaaaaAuthToken', 'organizationSecondarySigningKey'];
const BEFORE = [
  '',
  'token="TOPSECRET ',
  "token='TOPSECRET ",
  'password: ',
  'Bearer ',
  'Authorization: Basic ',
  'x-api-key=',
  'https://u:TOPSECRET',
  'secret=TOPSECRET&',
  'api_key: "',
];
const PLAIN_VALUES = ['x', '"x"', "'x'", 'x.y', 'TOPSECRET', '"TOP SECRET"', 'Bearer', 'true', 'x@host', 'abcdefghijklmnopqrstuvwxyz0123'];
const AFTER = ['', '"', "'", ' tail', '=y', ': z', '@host/p', ' = TOPSECRET', ',"b":"TOPSECRET"}', '&token=TOPSECRET'];

function* longKeys(): Generator<Generated> {
  for (const before of BEFORE)
    for (const key of LONG_KEYS)
      for (const separator of ['=', ': ', '":"', ' = '])
        for (const value of PLAIN_VALUES)
          for (const after of AFTER) {
            const token = marker();
            const input = `${before}${key}${separator}${plantValue(value, token)}${after} ${sentinel()}`;
            yield { input, name: `long ${JSON.stringify(input)}`, secrets: [token] };
          }
}

/**
 * The #937 value shapes, with a marker planted inside every value. They are kept out of
 * `generated()` because 0.14.20 eats the `>` of `=>` as formatting, which the run-level comparison
 * reads as a credential; the #937 check compares planted values one by one instead.
 */
const SHAPE_KEYS = ['token', 'secret', 'password', 'authToken', 'apiSecret', 'signingKey', 'userPwd'];
const SHAPES: [string, (key: string, value: string) => string][] = [
  ['array', (key, value) => `{"${key}":["${value}"]}`],
  ['object', (key, value) => `{"${key}":{"v":"${value}"}}`],
  ['bare array', (key, value) => `${key}=[${value}]`],
  ['bare object', (key, value) => `${key}: {"v":"${value}"}`],
  ['unicode double', (key, value) => `${key}: \u201c${value}\u201d`],
  ['unicode single', (key, value) => `${key}: \u2018${value}\u2019`],
  ['unicode guillemet', (key, value) => `${key}: \u00ab${value}\u00bb`],
  ['unicode unclosed', (key, value) => `${key}: \u201c${value}`],
  ['arrow quoted', (key, value) => `'${key}' => '${value}'`],
  ['arrow double', (key, value) => `:${key} => "${value}"`],
  ['arrow bare', (key, value) => `${key} => ${value}`],
  ['escaped json', (key, value) => `{\\"${key}\\":\\"${value}\\"}`],
  ['url encoded', (_key, value) => `password%3D${value}`],
  ['url encoded quoted', (_key, value) => `token%22%3A%22${value}`],
  ['url encoded name', (key, value) => `${key.replaceAll('_', '%5F')}=${value}`],
  ['plain', (key, value) => `${key}=${value}`],
  ['pwd pass', (_key, value) => `dbPass=${value}`],
  ['pwd separator', (_key, value) => `user_pass: ${value}`],
  ['nested pair', (key, value) => `SIGNINGKEY=${key}='${value}'`],
  ['nested pair upper', (key, value) => `AZUREOPENAIKEY=${key}="${value}"`],
  ['glued marker', (key, value) => `${key}=[redacted]${value}`],
];
/** Shapes whose point is a value too short for the rules to see, so only the marker goes in. */
const SHORT_SHAPES: [string, (key: string, value: string) => string][] = [
  ['scheme', (key, value) => `${key}=Bearer ${value}`],
  ['scheme basic', (key, value) => `${key}: Basic ${value}`],
];

function* shapes(): Generator<Generated> {
  for (const key of SHAPE_KEYS)
    for (const [shape, build] of SHAPES) {
      const token = marker();
      const text = build(key, `S3cr3tV4l${token}`);
      yield { input: `${text} ${sentinel()}`, name: `shape ${shape} ${key} ${JSON.stringify(text)}`, secrets: [token] };
    }
  for (const key of SHAPE_KEYS)
    for (const [shape, build] of SHORT_SHAPES) {
      const token = marker();
      const text = build(key, token);
      yield { input: `${text} ${sentinel()}`, name: `shape ${shape} ${key} ${JSON.stringify(text)}`, secrets: [token] };
    }
}

/**
 * The three shapes a review of the first version found, plus variants on either side of the 256
 * character search boundary that version had. The released pipeline removes the planted value in
 * every one; the new passes must not hide it, and the glue case must reach its fixed point.
 */
function* review(): Generator<Generated> {
  for (const gaps of [0, 255, 256, 257]) {
    const token = marker();
    yield {
      input: `token: \u201cx ${' '.repeat(gaps)}password\n=secret${token} ${sentinel()}`,
      name: `review typographic password ${gaps}`,
      secrets: [token],
    };
    const scheme = marker();
    yield {
      input: `token: \u201cx ${' '.repeat(gaps)}Bearer\nabcdef${scheme} ${sentinel()}`,
      name: `review typographic bearer ${gaps}`,
      secrets: [scheme],
    };
  }
  for (const spaces of [254, 255, 256, 257, 300]) {
    const token = marker();
    yield {
      input: `token=[${' '.repeat(spaces)}password\n=secret${token} ${sentinel()}`,
      name: `review structured ${spaces}`,
      secrets: [token],
    };
  }
  for (const count of [16, 17, 100]) {
    const token = marker();
    yield {
      input: `token=[redacted]${"'x'".repeat(count)}'secret${token}' ${sentinel()}`,
      name: `review glue ${count}`,
      secrets: [token],
    };
  }
  // Round 2: a mixed arrow/glue chain and the over-redaction inputs.
  {
    const token = marker();
    yield {
      input: `token => ${'\'a\'"b" '.repeat(16)}'secret${token}' ${sentinel()}`,
      name: 'review mixed chain',
      secrets: [token],
    };
  }
  for (const spaces of [0, 64, 256])
    yield {
      input: `token=[redacted]${' '.repeat(spaces)}"status":"ok" ${sentinel()}`,
      name: `review marker prose ${spaces}`,
      secrets: [],
    };
  // Round 3: blocks the released pipeline already removed (so every mapped region is empty), and a
  // preamble-like diagnostic line that is longer than any real preamble (#989 review).
  {
    const blocks = '\n-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n';
    yield {
      input: `${'ordinary '.repeat(20)}password="${blocks.repeat(20)}" ${sentinel()}`,
      name: 'review blocks inside a replaced value',
      secrets: [],
    };
    yield {
      input: `-----BEGIN PRIVATE KEY-----\nProc-Type:${' '.repeat(118)}; ordinary diagnostic\nnext prose ${sentinel()}`,
      name: 'review oversized preamble line',
      secrets: [],
    };
  }
}

/**
 * The shapes #989 adds, each with a unique marker planted inside the value: a typographic-quoted
 * value, a value after `=>`, and a PEM private-key block (standalone and under a credential key).
 * The released pipeline leaves input text from every one of them, so a case here says which value a
 * reader would call the credential.
 */
const TYPOGRAPHIC_PAIRS: readonly (readonly [string, string])[] = [
  ['\u201c', '\u201d'],
  ['\u2018', '\u2019'],
  ['\u00ab', '\u00bb'],
  ['\u201e', '\u201c'],
  ['\u2039', '\u203a'],
];
const PEM_LABELS = ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY'];

function* originalShapes(): Generator<Generated> {
  for (const key of SHAPE_KEYS) {
    for (const [open, close] of TYPOGRAPHIC_PAIRS) {
      const token = marker();
      yield {
        input: `${key}: ${open}S3cr3tV4l${token} with spaces${close} ${sentinel()}`,
        name: `shape typographic ${key} ${open}`,
        secrets: [token],
      };
    }
    const arrow = marker();
    yield {
      input: `'${key}' => 'S3cr3tV4l ${arrow} with spaces' ${sentinel()}`,
      name: `shape arrow quoted ${key}`,
      secrets: [arrow],
    };
    const bare = marker();
    yield { input: `${key} => S3cr3tV4l${bare} ${sentinel()}`, name: `shape arrow bare ${key}`, secrets: [bare] };
    const nested = marker();
    yield {
      input: `'${key}' => ${key}Key="S3cr3tV4l${nested}" ${sentinel()}`,
      name: `shape arrow nested ${key}`,
      secrets: [nested],
    };
  }
  for (const label of PEM_LABELS) {
    const standalone = marker();
    yield {
      input: `-----BEGIN ${label}-----\nMIIEowIBAAKCAQEA${standalone}\n-----END ${label}----- ${sentinel()}`,
      name: `shape pem ${label}`,
      secrets: [standalone],
    };
    const keyed = marker();
    yield {
      input: `password=-----BEGIN ${label}-----\nMIIEowIBAAKCAQEA${keyed}\n-----END ${label}----- ${sentinel()}`,
      name: `shape pem keyed ${label}`,
      secrets: [keyed],
    };
    // A traditional encrypted block carries an RFC 1421 preamble before its base64 body.
    const encrypted = marker();
    yield {
      input: `-----BEGIN ${label}-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,0123456789ABCDEF\n\nMIIEowIBAAKCAQEA${encrypted}\n-----END ${label}----- ${sentinel()}`,
      name: `shape pem encrypted ${label}`,
      secrets: [encrypted],
    };
    const arrowed = marker();
    yield {
      input: `${label === 'PRIVATE KEY' ? 'token' : 'apiSecret'} => -----BEGIN ${label}-----\nMIIEowIBAAKCAQEA${arrowed}\n-----END ${label}----- ${sentinel()}`,
      name: `shape pem after an arrow ${label}`,
      secrets: [arrowed],
    };
  }
  // The review's round-4 inputs: an authorization value behind an arrow or a key, whose token is
  // shorter than the six characters the released scheme rule needs (#989 review).
  for (const [name, build] of [
    ['arrow bearer short', (secret: string) => `token => Bearer ${secret}`],
    ['arrow bearer no space', (secret: string) => `token=>Bearer ${secret}`],
    ['arrow basic', (secret: string) => `token=>Basic ${secret}`],
    ['arrow digest', (secret: string) => `apiSecret => Digest ${secret}`],
    ['keyed digest', (secret: string) => `token: Digest ${secret}`],
    ['keyed scheme chain', (secret: string) => `token: Bearer Bearer ${secret}`],
  ] as const) {
    markerIndex += 1;
    // Two characters: far below the released scheme rule, and unique inside this case.
    const secret = `p${markerIndex}`;
    yield { input: `${build(secret)} ${sentinel()}`, name: `shape ${name}`, secrets: [secret] };
  }

  // The review's round-2 inputs: an arrow whose value starts a typographic pair, a shape after a
  // long-key pair, and a marker right before a block (#989 review).
  {
    const overlap = marker();
    yield {
      input: `password => token:\u201cfirst probe${overlap}\u201d ${sentinel()}`,
      name: 'review overlap arrow and typographic',
      secrets: [overlap],
    };
    const shifted = marker();
    yield {
      input: `organizationSecondaryAuthToken="x" token: \u201ca probe${shifted}\u201d token=x ${sentinel()}`,
      name: 'review shape after a long-key pair',
      secrets: [shifted],
    };
    const afterMarker = marker();
    yield {
      input: `${'token=x apiSecret=x '.repeat(7)}\n-----BEGIN PRIVATE KEY-----\nprobe${afterMarker}\n-----END PRIVATE KEY----- ${sentinel()}`,
      name: 'review block after markers',
      secrets: [afterMarker],
    };
    const field = marker();
    yield {
      input: `password=[redacted]"hunter2${field}":"x" ${sentinel()}`,
      name: 'review field glued to a caller marker',
      secrets: [field],
    };
  }
}

function* allShapes(): Generator<Generated> {
  yield* shapes();
  yield* originalShapes();
}

function* generated(): Generator<Generated> {
  yield* structured();
  yield* nested();
  yield* longKeys();
  yield* findings();
  yield* review();
  yield* randomPairs();
  yield* random();
}

/** Every generated case: the general corpus plus the value shapes. */
function* everyCase(): Generator<Generated> {
  yield* generated();
  yield* allShapes();
}

describe('the new redactor never keeps what 0.14.23 removed (#946, #956)', () => {
  it('removes every planted credential the 0.14.23 implementation removed', () => {
    // A run-level comparison is too strict here: 0.14.23's compound-key rule can replace part of a
    // non-space run, which leaves the rest in its output and makes the whole run look "removed".
    // Every generated case carries the values it planted, so this checks each of them: a value the
    // reference removed (including a short one, or one with a space) must be absent from the new
    // output too.
    const leaks: string[] = [];
    for (const { input, name, secrets } of generated()) {
      const before = redact01423(input);
      const after = redactCredentials(input);
      for (const secret of secrets)
        if (input.includes(secret) && !before.includes(secret) && after.includes(secret)) leaks.push(`${secret} kept in ${name}`);
    }
    expect(leaks.slice(0, 10)).toEqual([]);
    expect(leaks).toHaveLength(0);
  });

  it('stays idempotent on every generated input', () => {
    const unstable: string[] = [];
    for (const { input, name } of generated()) {
      const once = redactCredentials(input);
      if (redactCredentials(once) !== once) unstable.push(name);
    }
    expect(unstable.slice(0, 10)).toEqual([]);
    expect(unstable).toHaveLength(0);
  });
});

describe('the new redactor never keeps what 0.14.24 removed (#937)', () => {
  it('removes every planted credential the 0.14.24 implementation removed', () => {
    // 0.14.24 is the release this batch builds on; its provider qualifiers remove values 0.14.23
    // leaves, and a shape pass must not hide one of those (the scheme pass once did).
    const leaks: string[] = [];
    for (const { input, name, secrets } of generated()) {
      const before = redact01424(input);
      const after = redactCredentials(input);
      for (const secret of secrets)
        if (input.includes(secret) && !before.includes(secret) && after.includes(secret)) leaks.push(`${secret} kept in ${name}`);
    }
    expect(leaks.slice(0, 10)).toEqual([]);
    expect(leaks).toHaveLength(0);
  });
});

// #937: the shapes this batch adds, compared against every release it builds on. A reference may
// only remove part of a shape (0.14.20 turns `{"token":["x"]}` into `{"token":[redacted]"x"]}`); a
// planted value it removed whole must be gone from the new output as well.
describe('the new redactor never keeps what an earlier release removed (#937)', () => {
  const references: [string, (text: string) => string][] = [
    ['0.14.20', redact01420],
    ['0.14.23', redact01423],
    ['0.14.24', redact01424],
    ['0.14.25', redact01425],
  ];

  it('removes every planted value a reference removed', () => {
    const leaks: string[] = [];
    for (const { input, name, secrets } of allShapes()) {
      const after = redactCredentials(input);
      for (const [release, redact] of references) {
        const before = redact(input);
        for (const secret of secrets)
          if (input.includes(secret) && !before.includes(secret) && after.includes(secret))
            leaks.push(`${secret} kept from ${release} in ${name}`);
      }
    }
    expect(leaks.slice(0, 10)).toEqual([]);
    expect(leaks).toHaveLength(0);
  });

  it('stays idempotent on every generated shape', () => {
    const unstable: string[] = [];
    for (const { input, name } of allShapes()) {
      const once = redactCredentials(input);
      if (redactCredentials(once) !== once) unstable.push(name);
    }
    expect(unstable.slice(0, 10)).toEqual([]);
    expect(unstable).toHaveLength(0);
  });

  // Round 2: text the released pipeline leaves alone. The new passes must not remove anything here.
  it('leaves text the released pipeline leaves unchanged', () => {
    const unchanged = [
      'token: [redacted] ordinary diagnostics; operator said \u201cok\u201d.',
      'token=[redacted] "status":"ok"',
      'token=[redacted] "service recovered" "request completed"',
      'note="-----BEGIN PRIVATE KEY-----" status="ok"\nmore ordinary diagnostics',
      'see -----BEGIN RSA PRIVATE KEY-----\nS3cr3tV4l\n-----END RSA PRIVATE KEY----- here',
      'the header -----BEGIN CERTIFICATE----- is public',
      '-----BEGIN CERTIFICATE-----\nS3cr3tV4l\n-----END CERTIFICATE-----',
    ];
    for (const input of unchanged) expect(redactCredentials(input), input).toBe(redact01425(input));
  });
});

// #989: the shapes whose evidence only the original text keeps. Each one is decided from the
// original spans and applied to the released output, so the instrumented pipeline must stay
// byte-identical to the vendored 0.14.25 release, and every planted value the issue names must go.
describe('the shapes decided from the original spans (#989)', () => {
  it('runs the released pipeline byte-identically to 0.14.25', () => {
    // Unconditional (#989 review): no shape, no field and no bookkeeping fix may make the base
    // remove less than the release did, on any case.
    const differences: string[] = [];
    let compared = 0;
    for (const { input, name } of everyCase()) {
      compared += 1;
      const expected = redact01425(input);
      const actual = releasedRedaction(input);
      if (actual !== expected)
        differences.push(`${name}: ${JSON.stringify(actual.slice(0, 80))} != ${JSON.stringify(expected.slice(0, 80))}`);
    }
    expect(differences.slice(0, 10)).toEqual([]);
    expect(differences).toHaveLength(0);
    expect(compared).toBeGreaterThan(1_000);
  });

  it('keeps the frozen copy the runtime guard uses equal to the vendored release', () => {
    // `redactCredentials` compares its pipeline with the frozen function in `src/redaction-01425.ts`
    // and falls back to it on any difference. That copy and the test's reference must stay the same
    // function, or the guard would prove nothing.
    const differences: string[] = [];
    for (const { input, name } of generated()) {
      if (releasedGuardRedaction(input) !== redact01425(input)) differences.push(name);
    }
    expect(differences.slice(0, 10)).toEqual([]);
    expect(differences).toHaveLength(0);
  });

  it('removes every planted value in the shapes it adds', () => {
    const leaks: string[] = [];
    for (const { input, name, secrets } of originalShapes()) {
      const after = redactCredentials(input);
      for (const secret of secrets) if (after.includes(secret)) leaks.push(`${secret} kept in ${name}`);
    }
    expect(leaks.slice(0, 10)).toEqual([]);
    expect(leaks).toHaveLength(0);
  });

  it('never needed the released fallback', () => {
    // The counter only moves when the instrumented pipeline and the frozen release disagree, which
    // is exactly what no case may cause (#989 review).
    expect(redactionFallbacks.count).toBe(0);
  });

  it('stays idempotent on every generated input and shape', () => {
    const unstable: string[] = [];
    for (const { input, name } of everyCase()) {
      const once = redactCredentials(input);
      if (redactCredentials(once) !== once) unstable.push(name);
    }
    expect(unstable.slice(0, 10)).toEqual([]);
    expect(unstable).toHaveLength(0);
  });
});

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
