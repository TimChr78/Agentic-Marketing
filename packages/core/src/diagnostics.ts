// What a failure may say about itself (#885). An AppError message is written for a person and
// copied verbatim into the audit log and the agent ledger, so text that came from a provider, a
// driver or an exception must be reduced to a safe diagnostic before it is put there: a provider's
// own error code and message, never its body, and never a token the body or an exception echoes.

/**
 * Anything whose value is a credential: the key is kept (it says what failed), the value is not.
 * A key is a credential key when its last word — after splitting on camelCase/PascalCase
 * boundaries, `_`, `-` and `.` — is a credential word (#898). So `token`, `access_token`,
 * `authToken`, `apiSecret`, `X-Auth-Token` and `oauthToken` all match, while `monkey`, `keyboard`,
 * `author`, `authority`, `tokenizer` and `sessions_count` do not: a word that merely contains the
 * letters is not a credential word, and only the last word decides.
 *
 * `key` is the one word with a qualifier rule (see `KEY_QUALIFIERS`): a compound ending in `key` is
 * a credential when a credential word precedes it, and — as 0.14.20 did — always when the word is
 * reached through `_`, `-` or `.`. So `secretKey`, `x-api-key`, `tenant_key` and `config.key` are
 * credentials, while the camelCase validation fields `entryKey`, `sortKey`, `primaryKey` and
 * `idempotencyKey` are ordinary fields whose text must reach the caller unchanged.
 */
const CREDENTIAL_WORD = /^(?:token|secret|password|passwd|authorization|auth|credential|credentials|signature|session)$/;

/**
 * The exact compounds 0.14.20 recognised with or without a separator, in any case. Without this, an
 * environment-variable spelling such as `ACCESSTOKEN=…` (one all-caps word, so no camel boundary to
 * split on) would fall through even though 0.14.20 redacted it. Deliberately narrow: `MONKEY` and
 * `KEYBOARD` are not compounds of a credential word.
 */
const LEGACY_COMPOUND =
  /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|developer[_-]?token|client[_-]?secret|app[_-]?secret|private[_-]?key|api[_-]?key)$/i;

/**
 * The words that qualify a camelCase/PascalCase compound ending in `key`: `secretKey`, `signingKey`,
 * `apiKey`, `awsSecretAccessKey` and `clientKey` name credentials, `entryKey` and `sortKey` do not.
 * A `_`/`-`/`.`-separated `key` needs no qualifier (0.14.20 parity, see `isCredentialKey`).
 *
 * The trade-off: a camelCase compound `…Key` that no qualifier precedes counts as an ordinary field,
 * so a provider inventing a new spelling such as `tenantKey` is not caught by the key rule. Its
 * value is still subject to every other rule — a provider prefix, a JWT, a `Bearer` value, a URL
 * password, a 24+ character bare token — so a real secret of any length is still replaced. The list
 * is checked against the provider registries in `apps/server/test/redaction-providers.test.ts`, so a
 * new adapter or connector without a qualifier fails that test.
 *
 * `public`, `publishable` and `log` are deliberately out: a published key is not a secret.
 */
const KEY_QUALIFIERS = new Set([
  // Generic credential and security words.
  'api',
  'secret',
  'private',
  'signing',
  'sign',
  'access',
  'auth',
  'session',
  'encryption',
  'encrypt',
  'decryption',
  'master',
  'client',
  'license',
  'licence',
  'app',
  'application',
  'account',
  'service',
  'server',
  'webhook',
  'hmac',
  'shared',
  'consumer',
  'subscription',
  'storage',
  'sas',
  'ssh',
  'pgp',
  'gpg',
  'jwt',
  'token',
  'bearer',
  'password',
  'credential',
  'security',
  'crypto',
  'cipher',
  'data',
  'kms',
  'vault',
  'wrap',
  'wrapping',
  'root',
  'admin',
  'developer',
  'dev',
  'partner',
  'merchant',
  'restricted',
  'live',
  'test',
  // Model providers (packages/ai: `openai-compatible`, `anthropic-compatible`).
  'openai',
  'anthropic',
  // E-mail adapters (packages/email/src/adapters).
  'smtp',
  'ses',
  'postmark',
  'brevo',
  'cloudflare',
  // SMS and push adapters (packages/email/src/sms, packages/email/src/push).
  'twilio',
  'webpush',
  'vapid',
  'fcm',
  'apns',
  // Ad connectors (packages/ads).
  'meta',
  'google',
  'microsoft',
  'linkedin',
  'tiktok',
  'pinterest',
  // Integrations connectors (packages/integrations/src/connectors) and the other services the
  // platform talks to (stripe and the other prefixes the token rules know, GitHub, n8n, …).
  'shopify',
  'salesforce',
  'slack',
  'stripe',
  'sendgrid',
  'mailgun',
  'github',
  'n8n',
  'hubspot',
  'klaviyo',
  'amazon',
  'aws',
  'azure',
  's3',
  'openbao',
]);

/**
 * The redaction marker. A second pass must leave it exactly as it is (#919 round 2), so it is
 * recognised before anything else that starts with `[`, and only when the value really ends there.
 */
const MARKER = '[redacted]';

/** How much of a text is scanned at all. Longer input is cut first and marked (dropping is safe). */
export const MAX_REDACT_LENGTH = 64 * 1024;
/** Appended to a text that was cut at `MAX_REDACT_LENGTH`. */
export const TRUNCATED_MARKER = '…[truncated]';

/** The longest value structure (`[…]`, `{…}`) or PEM block walked before it is cut at the line end. */
const STRUCTURE_MAX = 4_096;
/** Nesting depth a value structure may have before it is treated as unbalanced. */
const STRUCTURE_DEPTH = 8;
/** The longest PEM block (`-----BEGIN …-----` to `-----END …-----`) consumed in one value. */
const PEM_MAX = 8_192;

/** JavaScript's `\s`, the whitespace 0.14.20's patterns matched: ASCII and the Unicode spaces. */
const WHITESPACE = new Set([
  ' ',
  '\t',
  '\n',
  '\v',
  '\f',
  '\r',
  '\u00a0',
  '\u1680',
  '\u2000',
  '\u2001',
  '\u2002',
  '\u2003',
  '\u2004',
  '\u2005',
  '\u2006',
  '\u2007',
  '\u2008',
  '\u2009',
  '\u200a',
  '\u2028',
  '\u2029',
  '\u202f',
  '\u205f',
  '\u3000',
  '\ufeff',
]);

/** The characters that end a line: the ECMAScript line terminators. */
const LINE_BREAKS = new Set(['\n', '\r', '\u2028', '\u2029']);

/**
 * Paired quotes: ASCII and the Unicode ones a word processor or a model writes. `”` and `’` alone
 * are closers, never openers, so they end a value instead of starting one.
 */
const QUOTE_PAIRS = new Map([
  ['"', '"'],
  ["'", "'"],
  ['\u201c', '\u201d'],
  ['\u2018', '\u2019'],
]);

/** Every quote character, opening or closing. */
const QUOTES = new Set(['"', "'", '\u201c', '\u201d', '\u2018', '\u2019']);

const isQuoteChar = (char: string): boolean => QUOTES.has(char);
const isSpaceChar = (char: string): boolean => WHITESPACE.has(char);

const isKeyChar = (char: string): boolean =>
  (char >= 'a' && char <= 'z') ||
  (char >= 'A' && char <= 'Z') ||
  (char >= '0' && char <= '9') ||
  char === '_' ||
  char === '.' ||
  char === '-';
const isAlpha = (char: string): boolean => (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z');
const isDigit = (char: string): boolean => char >= '0' && char <= '9';
const isWordChar = (char: string): boolean => isAlpha(char) || isDigit(char) || char === '_';
const isSchemeChar = (char: string): boolean => isAlpha(char) || isDigit(char) || char === '+' || char === '.' || char === '-';

/** Where an unquoted value ends: whitespace, an attribute separator, a JSON/HTML delimiter or a quote. */
const isValueStop = (char: string): boolean =>
  isSpaceChar(char) || char === ',' || char === ';' || char === '&' || char === '}' || char === ']' || isQuoteChar(char);
/** Where a value's atoms stop: a stop that no atom can start with. */
const isHardStop = (char: string): boolean =>
  isSpaceChar(char) || char === ',' || char === ';' || char === '&' || char === '}' || char === ']';
/** Where a URL's authority ends: the path, the query, the fragment or whitespace. */
const isAuthorityStop = (char: string): boolean => char === '/' || char === '?' || char === '#' || isSpaceChar(char);

const CAMEL_BOUNDARY = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;

interface KeyPart {
  word: string;
  /** What separated this word from the one before it: `''` at the start, `'camel'`, or the punctuation. */
  separator: string;
}

/** The words of a key with the separator that introduced each: `X-Auth-Token` → X, Auth, Token. */
function keyParts(key: string): KeyPart[] {
  const parts: KeyPart[] = [];
  let separator = '';
  for (const chunk of key.split(/([^A-Za-z0-9]+)/)) {
    if (!chunk) continue;
    if (!/^[A-Za-z0-9]/.test(chunk)) {
      separator = chunk;
      continue;
    }
    let first = true;
    for (const word of chunk.split(CAMEL_BOUNDARY)) {
      if (!word) continue;
      parts.push({ word, separator: first ? separator : 'camel' });
      first = false;
    }
    separator = '';
  }
  return parts;
}

/**
 * Whether a key names a credential. A trailing number is not a word: `apiKey2` still ends in `key`.
 * `key` on its own is always a credential and `keys` on its own never is (a message about "allowed
 * keys" lists field names); a compound ending in `key` is a credential when it is reached through
 * `_`, `-` or `.` (0.14.20 parity: `tenant_key`, `x-tenant-key`, `config.key`, `ENTRY_KEY`) or when
 * a qualifier precedes it (`apiKey`, `secretKey`, `sessionKey`, `openaiKey`). `keys` after a
 * qualifier is a credential too (`apiKeys`).
 */
function isCredentialKey(key: string): boolean {
  const parts = keyParts(key).map((part) => ({ ...part, word: part.word.replace(/[0-9]+$/, '') }));
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]!;
    if (!part.word) continue;
    const lower = part.word.toLowerCase();
    if (LEGACY_COMPOUND.test(lower)) return true;
    if (lower === 'key' || lower === 'keys') {
      const qualified = parts.slice(0, index).some((before) => KEY_QUALIFIERS.has(before.word.toLowerCase()));
      if (lower === 'key') {
        if (index === 0) return true;
        if (part.separator === 'camel') return qualified;
        // `_`, `-`, `.` or any other punctuation: a compound key reached that way, as in 0.14.20.
        return true;
      }
      return index > 0 && qualified;
    }
    return CREDENTIAL_WORD.test(lower);
  }
  return false;
}

/** The end of a key run starting at `start` (at least one character). */
function keyRunEnd(text: string, start: number): number {
  let end = start;
  while (end < text.length && isKeyChar(text[end]!)) end += 1;
  return end;
}

/** The end of an unquoted value atom, which stops at the first delimiter. */
function tokenEnd(text: string, start: number): number {
  let end = start;
  while (end < text.length && !isValueStop(text[end]!)) end += 1;
  return end;
}

/** The index of the first line terminator at or after `start`, or the text length. */
function lineEnd(text: string, start: number): number {
  for (let index = start; index < text.length; index += 1) if (LINE_BREAKS.has(text[index]!)) return index;
  return text.length;
}

/** The end of a quoted string, escapes honoured, or null when the quote is not closed by `limit`. */
function quotedEnd(text: string, start: number, limit = text.length): number | null {
  const closer = QUOTE_PAIRS.get(text[start]!);
  if (closer === undefined) return null;
  let index = start + 1;
  while (index < limit) {
    const char = text[index]!;
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === closer) return index + 1;
    index += 1;
  }
  return null;
}

/**
 * The end of the `[`/`{` structure at `start`, string- and escape-aware, or null when it is
 * unbalanced, nested deeper than `STRUCTURE_DEPTH`, or longer than `STRUCTURE_MAX`.
 */
function structureEnd(text: string, start: number): number | null {
  const expected: string[] = [];
  const limit = Math.min(text.length, start + STRUCTURE_MAX);
  let index = start;
  while (index < limit) {
    const char = text[index]!;
    if (isQuoteChar(char)) {
      const end = quotedEnd(text, index, limit);
      if (end === null) return null;
      index = end;
      continue;
    }
    if (char === '[' || char === '{') {
      if (expected.length >= STRUCTURE_DEPTH) return null;
      expected.push(char === '[' ? ']' : '}');
    } else if (char === ']' || char === '}') {
      if (expected.pop() !== char) return null;
      if (expected.length === 0) return index + 1;
    }
    index += 1;
  }
  return null;
}

/** Finds `needle` at or after `from`, within `limit` characters, without scanning the rest of the text. */
function indexOfWithin(text: string, needle: string, from: number, limit: number): number {
  const last = Math.min(text.length, from + limit) - needle.length;
  outer: for (let index = from; index <= last; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) if (text[index + offset] !== needle[offset]) continue outer;
    return index;
  }
  return -1;
}

/** The end of a PEM block (`-----BEGIN …-----` to `-----END …-----`), or null when it is not one. */
function pemEnd(text: string, start: number): number | null {
  const begin = '-----BEGIN ';
  if (!text.startsWith(begin, start)) return null;
  const beginClose = indexOfWithin(text, '-----', start + begin.length, 80);
  if (beginClose === -1) return null;
  const end = indexOfWithin(text, '-----END ', beginClose + 5, PEM_MAX);
  if (end === -1) return null;
  const endClose = indexOfWithin(text, '-----', end + 9, 80);
  return endClose === -1 ? null : endClose + 5;
}

/** A value that starts a credential pair of its own (`token: access_token=…`). */
function nestedPairAt(text: string, start: number): boolean {
  if (start >= text.length || !isKeyChar(text[start]!)) return false;
  const keyEnd = keyRunEnd(text, start);
  let index = keyEnd;
  if (isQuoteChar(text[index] ?? '')) index += 1;
  while (index < text.length && isSpaceChar(text[index]!)) index += 1;
  if (text[index] !== ':' && text[index] !== '=') return false;
  return isCredentialKey(text.slice(start, keyEnd));
}

/** The end of a `Bearer`/`Basic` word at a value start followed by whitespace, or null. */
function authSchemeAt(text: string, start: number): number | null {
  for (const word of ['bearer', 'basic']) {
    if (text.slice(start, start + word.length).toLowerCase() === word && isSpaceChar(text[start + word.length] ?? ''))
      return start + word.length;
  }
  return null;
}

/** A redaction that consumes the rest of the line, used when a value cannot be delimited. */
function toLineEnd(text: string, start: number): { end: number; text: string } {
  return { end: lineEnd(text, start), text: MARKER };
}

interface ValueRead {
  end: number;
  text: string;
}

/**
 * The redaction of one credential value: what to emit and where the value ends (#902 round 3).
 *
 * A value is a run of atoms — a marker, a quoted string, a balanced structure, a PEM block or a
 * plain token — and every atom is consumed where it is read, so the loop is bounded by the value.
 * A leading run of `Bearer`/`Basic` words is consumed iteratively (no recursion), and the last one
 * is kept in front of the marker. A nested credential pair is left for the scan to redact itself.
 */
function readValue(text: string, start: number): ValueRead | null {
  if (start >= text.length) return null;
  let index = start;
  let scheme: string | null = null;
  for (;;) {
    const wordEnd = authSchemeAt(text, index);
    if (wordEnd === null) break;
    scheme = text.slice(index, wordEnd);
    index = wordEnd;
    while (index < text.length && isSpaceChar(text[index]!)) index += 1;
  }
  if (scheme === null && nestedPairAt(text, index)) return null;
  const withScheme = (end: number) => ({ end, text: scheme === null ? MARKER : `${scheme} ${MARKER}` });
  let atoms = 0;
  let firstIsMarker = false;
  let end = index;
  while (end < text.length) {
    const char = text[end]!;
    if (isHardStop(char)) break;
    if (text.startsWith(MARKER, end)) {
      if (atoms === 0) firstIsMarker = true;
      end += MARKER.length;
      atoms += 1;
      continue;
    }
    if (isQuoteChar(char)) {
      const quoted = quotedEnd(text, end);
      if (quoted === null) return toLineEnd(text, end);
      end = quoted;
      atoms += 1;
      continue;
    }
    if (char === '[' || char === '{') {
      const structure = structureEnd(text, end);
      if (structure === null) return toLineEnd(text, end);
      end = structure;
      atoms += 1;
      continue;
    }
    if (text.startsWith('-----BEGIN ', end)) {
      const pem = pemEnd(text, end);
      if (pem === null) return toLineEnd(text, end);
      end = pem;
      atoms += 1;
      continue;
    }
    const token = tokenEnd(text, end);
    if (token === end) break;
    end = token;
    atoms += 1;
  }
  if (atoms === 0) return scheme === null ? null : withScheme(index);
  // The value is exactly the marker it already carries: keep it, so a second pass changes nothing.
  if (scheme === null && atoms === 1 && firstIsMarker) return { end, text: MARKER };
  return withScheme(end);
}

/**
 * The URL whose userinfo starts after a `://` that ends at `schemeEnd`: the index where the password
 * begins and the end of the userinfo (`@`), or null. The authority runs to the first `/`, `?`, `#` or
 * whitespace, and the **last** `@` in it delimits the userinfo (a password may contain `@`); IPv6
 * hosts (`[::1]:5432`) and an empty user (`://:pw@host`) work the same way (#920).
 */
function urlAuthorityAt(text: string, schemeEnd: number): { match: { passwordStart: number; end: number } | null; resume: number } {
  const authorityStart = schemeEnd + 3;
  let authorityEnd = authorityStart;
  while (authorityEnd < text.length && !isAuthorityStop(text[authorityEnd]!)) authorityEnd += 1;
  let at = -1;
  for (let scan = authorityStart; scan < authorityEnd; scan += 1) if (text[scan] === '@') at = scan;
  if (at >= 0) {
    let colon = -1;
    for (let scan = authorityStart; scan < at; scan += 1)
      if (text[scan] === ':') {
        colon = scan;
        break;
      }
    // No user, or an empty password: nothing to redact.
    if (colon >= 0 && colon + 1 !== at) return { match: { passwordStart: colon + 1, end: at + 1 }, resume: at + 1 };
  }
  // Nothing to redact: resume after the `://` and let the scan walk the rest as ordinary text.
  return { match: null, resume: authorityStart };
}

/**
 * The credential redaction of free text, in one pass (#885, #898, #902, #920). A key is a
 * credential key when its last word — split on camelCase/PascalCase, `_`, `-` and `.` — is a
 * credential word, with the qualifier rule for `key` described at `KEY_QUALIFIERS`.
 *
 * Grammar of the text this walks, where KEY is a credential key:
 *
 *   text        := ( url | pair | char )*
 *   url         := scheme "://" authority        — the password between the userinfo's first `:`
 *                                                  and the authority's last `@` is redacted
 *   pair        := KEY quote? space* (":" | "=" | "=>") space* value
 *   value       := scheme-word* ( marker | atom )+ | nested-pair
 *   atom        := quoted | structure | pem | token
 *   marker      := "[redacted]"                  — kept only when it is the whole value
 *   quoted      := "…" | '…' | “…” | ‘…’         (backslash escapes honoured)
 *   structure   := balanced `[…]`/`{…}`, strings escape-aware, depth ≤ 8, ≤ 4 KiB
 *   pem         := "-----BEGIN …-----" … "-----END …-----" (≤ 8 KiB)
 *   token       := any run up to whitespace, `,`, `;`, `&`, `}`, `]` or a quote
 *
 * Work is linear in the length of the text, and here is why for each lookahead the scan performs:
 *
 * - a scheme-character run is measured once and remembered for every position inside it, so a
 *   string of `a+a+a+…` is walked once rather than once per character;
 * - a key run is walked once and the scan resumes after it (or after its separator/value), never
 *   inside it, so a key run is examined once plus at most once by `nestedPairAt`;
 * - the separator lookahead (`quote? space* (:|=>)`) reads at most the characters that the pair
 *   prefix then consumes, and a pair that does not form resumes at the key run's end;
 * - markers (10 characters), quotes, structures (≤ 4 KiB), PEM blocks (≤ 8 KiB) and tokens are each
 *   consumed where they are read, so the value loop is bounded by the value's length;
 * - a failed PEM probe reads at most `PEM_MAX` characters and then redacts the rest of its line, and
 *   the input is capped at `MAX_REDACT_LENGTH`, so the total stays bounded;
 * - no path recurses: scheme words, values, atoms and structures are loops with explicit limits.
 */
function redactScan(text: string): string {
  let out = '';
  let copied = 0;
  let index = 0;
  const length = text.length;
  // The end of the scheme-character run that covers `index`, once measured. A run is measured once
  // and reused for every position inside it, so `a+a+a+…` is walked once, not once per character.
  let schemeEnd = 0;
  while (index < length) {
    // A URL can only start at a word boundary with a letter.
    if (isAlpha(text[index]!) && (index === 0 || !isWordChar(text[index - 1]!))) {
      if (index >= schemeEnd) {
        schemeEnd = index;
        while (schemeEnd < length && isSchemeChar(text[schemeEnd]!)) schemeEnd += 1;
      }
      if (text[schemeEnd] === ':' && text[schemeEnd + 1] === '/' && text[schemeEnd + 2] === '/') {
        const attempt = urlAuthorityAt(text, schemeEnd);
        if (attempt.match) {
          // The password, then the `@` that ends the userinfo (the emit runs up to it, not past it).
          out += `${text.slice(copied, attempt.match.passwordStart)}${MARKER}@`;
          copied = attempt.match.end;
          index = attempt.match.end;
        } else {
          index = attempt.resume;
        }
        continue;
      }
      // No `://` at the end of this run, so nothing inside it can start a URL: fall through to the
      // key rule, which examines this position and moves on.
    }
    if (!isKeyChar(text[index]!) || (index > 0 && isKeyChar(text[index - 1]!))) {
      index += 1;
      continue;
    }
    const keyEnd = keyRunEnd(text, index);
    let afterKey = keyEnd;
    if (isQuoteChar(text[afterKey] ?? '')) afterKey += 1;
    let separator = afterKey;
    while (separator < length && isSpaceChar(text[separator]!)) separator += 1;
    let separatorEnd = separator;
    if (text[separator] === ':' || text[separator] === '=') {
      separatorEnd = separator + 1;
      // `key => value`, the spelling JavaScript and TypeScript examples use.
      if (text[separator] === '=' && text[separatorEnd] === '>') separatorEnd += 1;
    } else {
      index = keyEnd;
      continue;
    }
    let valueStart = separatorEnd;
    while (valueStart < length && isSpaceChar(text[valueStart]!)) valueStart += 1;
    const value = isCredentialKey(text.slice(index, keyEnd)) ? readValue(text, valueStart) : null;
    if (!value) {
      index = valueStart;
      continue;
    }
    out += text.slice(copied, valueStart) + value.text;
    copied = value.end;
    index = value.end;
  }
  return out + text.slice(copied);
}

/** Our own external ids (`mnd_…`, `eml_…`): identifiers, never credentials. */
const ID_LIKE = '(?:[a-z]{2,5})_[0-9a-f]{32}';

/**
 * Token-shaped values, in the order they must be applied on top of the key rule: a provider's own
 * prefix (`shpat_…`, `sk_live_…`, a JWT), an Authorization value (`Bearer …`), then a bare long
 * token (base64, base64url or hex), which is what a gateway echoing a header leaves behind.
 */
const REDACTIONS: readonly (readonly [RegExp, string])[] = [
  // The prefixes Shopify, Stripe, Slack, GitHub, AWS, Google and JWT issuers use.
  [/\b(?:shpat_|shpss_|shpca_|sk_live_|sk_test_|rk_|xox[abposr]-|ghp_|gho_|github_pat_|ya29\.)[A-Za-z0-9._-]{4,}/gi, '[redacted]'],
  [/\bAKIA[A-Z0-9]{16}\b/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{4,}){0,2}/g, '[redacted]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [redacted]'],
  // 24+ characters with no separators: a token, not a word, an id or a number. Our own external
  // ids are one exception, so a message may still name the artifact it is about; a provider's error
  // code in capitals and underscores (`INVALID_AUTHENTICATION_CREDENTIALS`) is the other: letters
  // only, in two or more words, which no generated token looks like (#885 round 3).
  [new RegExp(`(?<![A-Za-z0-9_])(?!(?:${ID_LIKE}|[A-Z]+(?:_[A-Z]+)+)(?![A-Za-z0-9+/=_-]))[A-Za-z0-9+/_-]{24,}={0,2}`, 'g'), '[redacted]'],
];

/**
 * Removes token-shaped values from free text: an exception's message, a provider's answer, a log
 * line that is about to become an AppError.
 *
 * Two structural safeguards (#902 round 3):
 *
 * - the text is cut to `MAX_REDACT_LENGTH` before it is scanned and a cut text ends with
 *   `TRUNCATED_MARKER`. Dropping text can only lose a message's tail, never leak one, and it bounds
 *   the absolute work for any input;
 * - nothing here throws. A scan that fails for any reason returns the bare marker, so a broken
 *   redactor can never turn an error path into an exception and never echoes the input.
 */
export function redactCredentials(text: string): string {
  const input = String(text);
  const bounded = input.length > MAX_REDACT_LENGTH ? `${input.slice(0, MAX_REDACT_LENGTH)}${TRUNCATED_MARKER}` : input;
  try {
    // The token-shaped passes run first, so whatever a marker they leave behind is in the text the
    // scan then walks: a marker next to a dangling quote or bracket is absorbed in the same call
    // instead of one pass later, which is what keeps redaction idempotent (#902 round 3).
    let out = bounded;
    for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
    return redactScan(out);
  } catch {
    return MARKER;
  }
}

/**
 * Text that may span lines (a model's reason, a provider's raw answer), redacted while complete and
 * then cut to `max` characters. Cutting first could drop a closing quote or leave a token prefix the
 * redaction no longer recognises (#885).
 */
export function redactedText(text: string, max: number): string {
  return redactCredentials(String(text)).slice(0, max);
}

/**
 * One line of error text that may be stored or shown: redacted while it is complete, then cut to
 * its first line and `max` characters. The order matters: cutting first can split a quoted
 * credential from its closing quote, or leave a token prefix too short to recognise (#885).
 */
export function safeErrorText(text: string, max: number): string {
  return redactCredentials(String(text)).split('\n')[0]!.trim().slice(0, max);
}

const CODE_FIELDS = ['code', 'status', 'type'] as const;
const TEXT_FIELDS = ['message', 'error_description', 'detail', 'description'] as const;
/** The keys a provider nests its error object under. */
const NESTED_FIELDS = ['error', 'errors', 'details', 'cause'] as const;
/** Fields one diagnostic may carry: a code, a message, and a little context. */
const MAX_PARTS = 4;
const MAX_PART_CHARS = 200;

function addPart(out: string[], value: string) {
  // Redact while the value is complete: truncating first can leave a short token prefix that no
  // rule recognises any more (#885 round 2).
  const text = redactCredentials(value.trim());
  if (!text || out.length >= MAX_PARTS) return;
  if (out.some((part) => part.toLowerCase() === text.toLowerCase())) return;
  out.push(text.length > MAX_PART_CHARS ? `${text.slice(0, MAX_PART_CHARS - 1)}…` : text);
}

/** Collects a provider's error code, message and detail from its parsed answer, and nothing else. */
function errorParts(value: unknown, depth: number, out: string[]): string[] {
  if (depth > 4 || out.length >= MAX_PARTS || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) errorParts(item, depth + 1, out);
    return out;
  }
  const o = value as Record<string, unknown>;
  for (const key of CODE_FIELDS) {
    const v = o[key];
    // A code is short: a long value here is prose or a token, not a code.
    if ((typeof v === 'string' || typeof v === 'number') && String(v).length <= 64) addPart(out, String(v));
  }
  // OAuth's "error" is the code; a provider's "error" is an object, which is walked below.
  if (typeof o.error === 'string') addPart(out, o.error);
  for (const key of TEXT_FIELDS) {
    const v = o[key];
    if (typeof v === 'string') addPart(out, v);
  }
  for (const key of NESTED_FIELDS) {
    const v = o[key];
    if (v && typeof v === 'object') errorParts(v, depth + 1, out);
  }
  return out;
}

/**
 * The safe diagnostic of a provider's HTTP error body: its error code and message fields, joined
 * and length-limited, with token-shaped values redacted (#885). Never the raw body: a provider or
 * a gateway may echo the request (an `access_token`, an Authorization header, a developer token),
 * and this text ends up in an AppError that the caller reads and the audit log keeps.
 *
 * A body that is not a JSON error object yields an empty string, so the caller's message carries
 * only the status it already knows.
 */
export function providerDiagnostic(body: string, maxLength = 200): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return '';
  }
  const parts = errorParts(parsed, 0, []);
  if (!parts.length) return '';
  const text = redactCredentials(parts.join(': '));
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
