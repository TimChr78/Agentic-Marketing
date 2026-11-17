import { describe, expect, it } from 'vitest';
import { expectLinear } from '../../../test-support/linear';
import { redactCredentials, redactionFallbacks, releasedRedaction } from '../src/diagnostics';
import { redactCredentials as redact01425 } from './redaction-01425-reference';

// #989 review, round 2: a grid in the reviewer's style. Every combination plants a unique marker in
// the value a reader would call the credential, and every one must come out, with a second call
// changing nothing. The four axes are the spellings a log line uses: the key, the syntax between key
// and value, how the value is written, and where the pair sits in the surrounding text. A survivor
// names its combination, so a regression says which axis broke.

/** Below the 24-character bare-token rule, so only a key or a shape pass can find it. */
const SECRET = 'S3cr3tV4l';

let markerIndex = 0;
const marker = (): string => {
  markerIndex += 1;
  return `Qa${markerIndex}Zx`;
};

const KEYS = [
  'token',
  'apiSecret',
  'password',
  'client_secret',
  'X-Auth-Token',
  'authToken',
  'dbPass',
  // A long compound key that is not itself token-shaped: a 24+ character key is replaced as a
  // token by the released rules, and its value then has no key left to claim it (#956).
  'secondaryAuthToken',
];

/** The syntax between the key and its value, including the two arrow and the JSON spellings. */
const SEPARATORS = ['=', '= ', ': ', ':', ' = ', '\t:\t', '=> ', '" => ', '":"'];

/** How the value is written. `…` is where the planted marker goes. */
const VALUES: [string, (planted: string) => string][] = [
  ['bare', (planted) => planted],
  ['double quoted', (planted) => `"${planted}"`],
  ['single quoted', (planted) => `'${planted}'`],
  ['typographic double', (planted) => `\u201c${planted} with space\u201d`],
  ['typographic single', (planted) => `\u2018${planted} with space\u2019`],
  ['guillemet', (planted) => `\u00ab${planted} with space\u00bb`],
  ['array', (planted) => `["${planted}"]`],
  ['object', (planted) => `{"v":"${planted}"}`],
  ['bearer', (planted) => `Bearer ${planted}`],
  ['basic', (planted) => `Basic ${planted}`],
  ['broken quote', (planted) => `"first\n${planted}"`],
  ['pem', (planted) => `-----BEGIN RSA PRIVATE KEY-----\nMIIEow${planted}\n-----END RSA PRIVATE KEY-----`],
];

/** Where the pair sits: at the start, after prose, after a marker, inside JSON. */
const CONTEXTS: [string, (pair: string) => string][] = [
  ['start', (pair) => pair],
  ['after prose', (pair) => `the gateway answered ${pair}`],
  ['after a line', (pair) => `diagnostics follow\n${pair}`],
  ['after a note', (pair) => `note: ${pair}`],
  ['inside JSON', (pair) => `{"k":1,${pair}`],
  ['after an arrow', (pair) => `x => ${pair}`],
  ['in a query', (pair) => `?q=1&${pair}`],
  ['after a marker', (pair) => `token=[redacted]${pair}`],
  ['after an apostrophe', (pair) => `can't reproduce: ${pair}`],
];

/** JSON needs its own escaping, and the arrow separates like `:` does, so the pair is built per case. */
function pair(key: string, separator: string, value: string): string {
  if (separator === '":"') {
    const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
    return `"${key}":"${escaped}"`;
  }
  return `${key}${separator}${value}`;
}

interface Combo {
  readonly name: string;
  readonly input: string;
  readonly secret: string;
}

function* grid(): Generator<Combo> {
  for (const key of KEYS)
    for (const separator of SEPARATORS)
      for (const [shape, render] of VALUES)
        for (const [context, place] of CONTEXTS) {
          const secret = marker();
          const text = pair(key, separator, render(`${SECRET}${secret}`));
          yield {
            name: `${key}${JSON.stringify(separator)} ${shape} ${context}`,
            input: place(text),
            secret,
          };
        }
}

const PEM_LABELS = ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY'];
const PEM_PREAMBLES = [
  ['none', ''],
  ['Proc-Type', 'Proc-Type: 4,ENCRYPTED\n'],
  ['both', 'Proc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,0123456789ABCDEF\n'],
  ['both and a blank line', 'Proc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,0123456789ABCDEF\n\n'],
];
const PEM_BODIES: [string, (planted: string) => string][] = [
  ['one line', (planted) => `MIIEow${planted}`],
  ['three lines', (planted) => `MIIEow\nIBAA${planted}\nKCQEA`],
  ['base64 alphabet', (planted) => `abc+/=${planted}`],
  ['CRLF line', (planted) => `MIIEow${planted}\r`],
  ['padded', (planted) => `MIIEow${planted}==`],
];
const PEM_FOOTERS: [string, (label: string) => string][] = [
  ['matching', (label) => `\n-----END ${label}-----`],
  ['another label', () => '\n-----END EC PRIVATE KEY-----'],
  ['none', () => ''],
  ['with prose after', (label) => `\n-----END ${label}-----\nthe key could not be parsed`],
];
const PEM_CONTEXTS: [string, (block: string) => string][] = [
  ['start', (block) => block],
  ['after a line', (block) => `diagnostics follow\n${block}`],
  ['after an apostrophe', (block) => `can't load the key\n${block}`],
  ['after JSON', (block) => `{"a":1}\n${block}`],
  ['after blank lines', (block) => `\n\n${block}`],
];

function* pemGrid(): Generator<Combo> {
  for (const label of PEM_LABELS)
    for (const [preambleName, preamble] of PEM_PREAMBLES)
      for (const [bodyName, body] of PEM_BODIES)
        for (const [footerName, footer] of PEM_FOOTERS)
          for (const [context, place] of PEM_CONTEXTS) {
            const secret = marker();
            const block = `-----BEGIN ${label}-----\n${preamble}${body(`${SECRET}${secret}`)}${footer(label)}`;
            yield {
              name: `pem ${label} ${preambleName} ${bodyName} ${footerName} ${context}`,
              input: place(block),
              secret,
            };
          }
}

/** The same block under a credential key: the separator is what the released rule could see. */
const PEM_KEYS = ['password', 'token', 'authToken'];
function* keyedPemGrid(): Generator<Combo> {
  for (const key of PEM_KEYS)
    for (const [preambleName, preamble] of PEM_PREAMBLES)
      for (const [bodyName, body] of PEM_BODIES)
        for (const [footerName, footer] of PEM_FOOTERS) {
          const secret = marker();
          yield {
            name: `keyed pem ${key} ${preambleName} ${bodyName} ${footerName}`,
            input: `${key}=-----BEGIN RSA PRIVATE KEY-----\n${preamble}${body(`${SECRET}${secret}`)}${footer('RSA PRIVATE KEY')}`,
            secret,
          };
        }
}

/**
 * An authorization value behind an arrow or a key (#989 review round 4). The token is five
 * characters, under the six the released scheme rule needs, so only the shape pass can take it --
 * which is exactly where the review's expanded grid found its 240 survivors.
 */
const SCHEME_VALUES: [string, (planted: string) => string][] = [
  ['bearer', (planted) => `Bearer ${planted}`],
  ['basic', (planted) => `Basic ${planted}`],
  ['digest', (planted) => `Digest ${planted}`],
  ['token', (planted) => `Token ${planted}`],
  ['lower bearer', (planted) => `bearer ${planted}`],
  ['upper basic', (planted) => `BASIC ${planted}`],
  ['two schemes', (planted) => `Bearer Bearer ${planted}`],
  ['quoted single', (planted) => `'Bearer ${planted}'`],
  ['quoted double', (planted) => `"Bearer ${planted}"`],
  ['no token', () => 'Bearer'],
  ['trailing space', () => 'Bearer '],
  ['with a tail', (planted) => `Bearer ${planted} tail`],
];
/** With and without spaces around the arrow, and the separators a key uses. */
const SCHEME_SEPARATORS = ['=> ', '=>', ' => ', '" => ', ': ', '=', ' = '];

function* schemeGrid(): Generator<Combo> {
  let ordinal = 0;
  for (const key of KEYS)
    for (const separator of SCHEME_SEPARATORS)
      for (const [shape, render] of SCHEME_VALUES)
        for (const [context, place] of CONTEXTS) {
          ordinal += 1;
          const hasToken = shape !== 'no token' && shape !== 'trailing space';
          // Five characters: below the released scheme rule's six, and unique per case.
          const secret = hasToken ? `s${1_000 + ordinal}` : '';
          yield {
            name: `scheme ${key}${JSON.stringify(separator)} ${shape} ${context}`,
            input: place(pair(key, separator, render(secret))),
            secret,
          };
        }
}

/**
 * A keyed authorization value with a chain of one to three scheme words (#989 round 5). The release
 * takes the second word of a mixed chain as the token, and the restricted reader used to stop one
 * word early, so `token: Digest Bearer abc` kept `abc`.
 */
const SCHEME_CHAIN_WORDS = ['Bearer', 'Basic', 'Digest', 'Token', 'Negotiate'];
const SCHEME_CHAIN_KEYS = [
  'Authorization',
  'Proxy-Authorization',
  'token',
  'authToken',
  'password',
  'apiSecret',
  'X-Auth-Token',
  'client_secret',
];
const SCHEME_CHAIN_SEPARATORS = [': ', '=', ' => '];
const SCHEME_TOKENS: [string, (planted: string) => string][] = [
  ['short', (planted) => planted],
  ['single quoted', (planted) => `'${planted}'`],
  ['double quoted', (planted) => `"${planted}"`],
];

function* schemeChainGrid(): Generator<Combo> {
  let ordinal = 0;
  for (const key of SCHEME_CHAIN_KEYS)
    for (const separator of SCHEME_CHAIN_SEPARATORS)
      for (const first of SCHEME_CHAIN_WORDS)
        for (const second of ['', ...SCHEME_CHAIN_WORDS])
          for (const third of ['', ...SCHEME_CHAIN_WORDS])
            for (const [tokenName, token] of SCHEME_TOKENS) {
              // A chain has no gaps: a third word needs a second.
              if (second === '' && third !== '') continue;
              ordinal += 1;
              // Five characters, unique per case, below the released scheme rule's six.
              const secret = `c${1_000 + ordinal}`;
              const chain = [first, second, third].filter(Boolean).join(' ');
              yield {
                name: `chain ${key}${JSON.stringify(separator)} ${chain} ${tokenName}`,
                input: pair(key, separator, `${chain} ${token(secret)}`),
                secret,
              };
            }
}

describe('the credential shapes on a grid (#989 round 2)', () => {
  it('covers 7,776 pairs, 2,000 PEM, 240 keyed PEM, 6,048 schemes and 11,160 chains', () => {
    expect([...grid()]).toHaveLength(7_776);
    expect([...pemGrid()]).toHaveLength(2_000);
    expect([...keyedPemGrid()]).toHaveLength(240);
    expect([...schemeGrid()]).toHaveLength(6_048);
    expect([...schemeChainGrid()]).toHaveLength(11_160);
  });

  it('never leaves a planted value', () => {
    const survivors: string[] = [];
    let total = 0;
    for (const { name, input, secret } of [...grid(), ...pemGrid(), ...keyedPemGrid(), ...schemeGrid(), ...schemeChainGrid()]) {
      total += 1;
      if (secret !== '' && redactCredentials(input).includes(secret)) survivors.push(`${secret} kept in ${name}`);
    }
    expect(total).toBe(27_224);
    expect(survivors.slice(0, 10)).toEqual([]);
    expect(survivors).toHaveLength(0);
    // The base pipeline never had to be distrusted for any of them (#989 review).
    expect(redactionFallbacks.count).toBe(0);
  });

  it('is idempotent on every combination', () => {
    const unstable: string[] = [];
    for (const { name, input } of [...grid(), ...pemGrid(), ...keyedPemGrid(), ...schemeGrid(), ...schemeChainGrid()]) {
      const once = redactCredentials(input);
      if (redactCredentials(once) !== once) unstable.push(name);
    }
    expect(unstable.slice(0, 10)).toEqual([]);
    expect(unstable).toHaveLength(0);
  });

  it('keeps the instrumented pipeline byte-identical to 0.14.25 on every combination', () => {
    const differences: string[] = [];
    for (const { name, input } of [...grid(), ...pemGrid(), ...keyedPemGrid(), ...schemeGrid(), ...schemeChainGrid()]) {
      const expected = redact01425(input);
      if (releasedRedaction(input) !== expected) differences.push(name);
    }
    expect(differences.slice(0, 10)).toEqual([]);
    expect(differences).toHaveLength(0);
  });

  // Growth, not a wall-clock budget: an absolute millisecond limit depends on the runner, and the
  // repo's rule is the ratio check (test-support/linear.ts, #994). 4x the units must not cost 8x the
  // time; a super-linear pass shows as a ratio near sixteen.
  const linearFailure = (name: string, unit: string, base: number): string | null => {
    try {
      expectLinear((n) => unit.repeat(n), redactCredentials, base);
      return null;
    } catch (error) {
      return `${name}: ${(error as Error).message}`;
    }
  };

  it('grows linearly on a sample of the grid', () => {
    const units: [string, string][] = [];
    for (const [index, combo] of [...grid()].entries()) if (index % 1_000 === 0) units.push([combo.name, combo.input]);
    for (const [index, combo] of [...pemGrid()].entries()) if (index % 400 === 0) units.push([combo.name, combo.input]);
    for (const [index, combo] of [...schemeGrid()].entries()) if (index % 600 === 0) units.push([combo.name, combo.input]);
    for (const [index, combo] of [...schemeChainGrid()].entries()) if (index % 1_200 === 0) units.push([combo.name, combo.input]);
    // One text carrying every sampled shape, so the ratio is measured on their mix in one run. The
    // base keeps 4x the units well under the helper's 2,000 ms backstop on a loaded runner, which is
    // a "did it finish" bound rather than a speed one.
    const unit = units.map(([, input]) => `${input}\n`).join('');
    expect(linearFailure('grid sample', unit, 50)).toBeNull();
  }, 300_000);

  it('grows linearly on the shape that once exceeded a wall-clock budget on CI', () => {
    // The exact shape from the grid case `scheme dbPass" => " upper basic after a note`: the pair
    // after a `note: ` context, which is what the whole megabyte was made of. It took 7.4 s on the
    // CI runner under a 5 s absolute budget; the budget is gone and the fixture stays pinned.
    const unit = `note: ${pair('dbPass', '" => ', 'BASIC s1234')}\n`;
    expect(linearFailure('scheme behind an arrow after a note', unit, 200)).toBeNull();
  }, 300_000);
});
