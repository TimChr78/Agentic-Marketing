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
 * a credential only when a credential word precedes it, so `secretKey` and `x-api-key` are
 * credentials while `entryKey` and `sortKey` are ordinary fields whose text must survive.
 */
const CREDENTIAL_WORD = /^(?:token|secret|password|passwd|authorization|auth|credential|credentials|signature|session)$/;

/**
 * The redaction marker. A second pass must leave it exactly as it is (#919 round 2), so it is
 * recognised before anything else that starts with `[`.
 */
const MARKER = '[redacted]';

/** The longest value structure (`[…]`, `{…}`) or PEM block walked before it is cut at the line end. */
const STRUCTURE_MAX = 4_096;
/** Nesting depth a value structure may have before it is treated as unbalanced. */
const STRUCTURE_DEPTH = 8;
/** The longest PEM block (`-----BEGIN …-----` to `-----END …-----`) consumed in one value. */
const PEM_MAX = 8_192;
/** The most a nested credential pair is followed down; `nestedPairAt` only looks one level ahead. */
const NESTED_MAX = 1;

/** The words of a key: `X-Auth-Token` → X, Auth, Token; `authToken` → auth, Token. */
function keyWords(key: string): string[] {
  return key
    .split(/[^A-Za-z0-9]+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/))
    .filter((word) => word !== '');
}

/**
 * The words that qualify a compound ending in `key` (#898 round 2). `secretKey`, `signingKey`,
 * `api-key`, `aws_secret_access_key` and `clientKey` name credentials; `entryKey`, `sortKey`,
 * `primaryKey` and `idempotencyKey` name ordinary fields, and a validation or conflict message that
 * quotes one must keep its text — people and agents rely on it.
 *
 * The trade-off: a compound `…Key` that no qualifier precedes counts as an ordinary field, so a
 * provider inventing a new spelling such as `tenantKey` is not caught by the key rule. Its value is
 * still subject to every other rule — a provider prefix, a JWT, a `Bearer` value, a URL password, a
 * 24+ character bare token — so a real secret of any length is still replaced.
 *
 * Some qualifiers are credential words of their own (`secret`, `token`, `password`, `auth`,
 * `session`); listing them again keeps the rule readable. `public` and `publishable` keys are
 * published on purpose and are deliberately not qualifiers.
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
  // Providers this codebase integrates with, so `shopifyKey`, `twilioKey` and the like are
  // credentials even though their prefix is not a generic security word.
  'stripe',
  'twilio',
  'sendgrid',
  'mailgun',
  'postmark',
  'shopify',
  'salesforce',
  'google',
  'meta',
  'linkedin',
  'microsoft',
  'pinterest',
  'tiktok',
  'slack',
  'github',
  'n8n',
  'hubspot',
  'klaviyo',
  'brevo',
  'cloudflare',
  'ses',
  'smtp',
  'amazon',
  'aws',
  'azure',
  's3',
  'fcm',
  'apns',
  'vapid',
  'webpush',
  'openbao',
]);

/**
 * Whether a key names a credential. A trailing number is not a word: `apiKey2` still ends in `key`.
 * `key` on its own is always a credential; `keys` on its own is not (a message about "allowed
 * keys" lists field names). A compound ending in `key`/`keys` is a credential only when one of the
 * words before it is a qualifier from `KEY_QUALIFIERS`.
 */
function isCredentialKey(key: string): boolean {
  const words = keyWords(key).map((word) => word.replace(/[0-9]+$/, ''));
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const word = words[index]!;
    if (!word) continue;
    const lower = word.toLowerCase();
    const qualified = words.slice(0, index).some((before) => KEY_QUALIFIERS.has(before.toLowerCase()));
    if (lower === 'key') return index === 0 || qualified;
    if (lower === 'keys') return index > 0 && qualified;
    return CREDENTIAL_WORD.test(lower);
  }
  return false;
}

const isKeyChar = (char: string): boolean =>
  (char >= 'a' && char <= 'z') ||
  (char >= 'A' && char <= 'Z') ||
  (char >= '0' && char <= '9') ||
  char === '_' ||
  char === '.' ||
  char === '-';
const isAlpha = (char: string): boolean => (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z');
const isDigit = (char: string): boolean => char >= '0' && char <= '9';
const isSpaceChar = (char: string): boolean =>
  char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v';
const isWordChar = (char: string): boolean => isAlpha(char) || isDigit(char) || char === '_';
/** Where an unquoted value ends: whitespace, an attribute separator, or a JSON/HTML delimiter. */
const isValueStop = (char: string): boolean =>
  isSpaceChar(char) || char === ',' || char === ';' || char === '&' || char === '}' || char === ']' || char === '"' || char === "'";
/** Where a URL's authority ends: the path, the query, the fragment or whitespace. */
const isAuthorityStop = (char: string): boolean => char === '/' || char === '?' || char === '#' || isSpaceChar(char);

/** The end of a key run starting at `start` (at least one character). */
function keyRunEnd(text: string, start: number): number {
  let end = start;
  while (end < text.length && isKeyChar(text[end]!)) end += 1;
  return end;
}

/** The end of an unquoted value, which stops at the first delimiter. */
function tokenEnd(text: string, start: number): number {
  let end = start;
  while (end < text.length && !isValueStop(text[end]!)) end += 1;
  return end;
}

/** The end of a quoted string, escapes honoured, or null when the quote is not closed by `limit`. */
function quotedEnd(text: string, start: number, limit = text.length): number | null {
  const quote = text[start]!;
  let index = start + 1;
  while (index < limit) {
    const char = text[index]!;
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
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
    if (char === '"' || char === "'") {
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
  if (!isKeyChar(text[start] ?? '')) return false;
  const keyEnd = keyRunEnd(text, start);
  let index = keyEnd;
  if (text[index] === '"' || text[index] === "'") index += 1;
  while (index < text.length && isSpaceChar(text[index]!)) index += 1;
  if (text[index] !== ':' && text[index] !== '=') return false;
  return isCredentialKey(text.slice(start, keyEnd));
}

/** The `Bearer`/`Basic` word at a value start, or null. */
function authSchemeAt(text: string, start: number): number | null {
  for (const word of ['bearer', 'basic']) {
    if (text.slice(start, start + word.length).toLowerCase() === word && isSpaceChar(text[start + word.length] ?? ''))
      return start + word.length;
  }
  return null;
}

/** A redaction that consumes the rest of the line, used when a value cannot be delimited. */
function toLineEnd(text: string, start: number): { end: number; text: string } {
  const newline = text.indexOf('\n', start);
  return { end: newline === -1 ? text.length : newline, text: MARKER };
}

/**
 * The redaction of one credential value: what to emit and where the value ends, or null when the
 * value must be left for the scan to reach by itself (a nested credential pair).
 */
function redactValue(text: string, start: number): { end: number; text: string } | null {
  if (start >= text.length) return null;
  // The marker first: a second pass over redacted text must produce the same text.
  if (text.startsWith(MARKER, start)) return { end: start + MARKER.length, text: MARKER };
  const scheme = authSchemeAt(text, start);
  if (scheme !== null) {
    let inner = scheme;
    while (inner < text.length && isSpaceChar(text[inner]!)) inner += 1;
    const value = inner < text.length ? redactValue(text, inner) : null;
    // `Bearer …`/`Basic …` of any length keeps its scheme word (#902 round 2) and loses the value.
    if (value) return { end: value.end, text: `${text.slice(start, scheme)} ${MARKER}` };
    return { end: tokenEnd(text, start), text: MARKER };
  }
  let depth = 0;
  const nestedFrom = start;
  while (depth++ < NESTED_MAX && nestedPairAt(text, nestedFrom)) {
    // Leave the outer value in place; the scan redacts the pair inside it on its own.
    return null;
  }
  const char = text[start]!;
  if (char === '[' || char === '{') {
    const end = structureEnd(text, start);
    return end === null ? toLineEnd(text, start) : { end, text: MARKER };
  }
  if (char === '"' || char === "'") {
    const end = quotedEnd(text, start);
    return end === null ? toLineEnd(text, start) : { end, text: MARKER };
  }
  if (text.startsWith('-----BEGIN ', start)) {
    const end = pemEnd(text, start);
    return end === null ? toLineEnd(text, start) : { end, text: MARKER };
  }
  const end = tokenEnd(text, start);
  return end === start ? null : { end, text: MARKER };
}

/**
 * The URL whose userinfo starts at `start`: the index where the password begins and where the
 * userinfo ends (`@`), or null. The authority runs to the first `/`, `?`, `#` or whitespace, and the
 * **last** `@` in it delimits the userinfo (a password may contain `@`); IPv6 hosts (`[::1]:5432`)
 * and an empty user (`://:pw@host`) are handled the same way (#920 round 2).
 */
function urlUserinfoAt(text: string, start: number): { passwordStart: number; end: number } | null {
  if (start > 0 && isWordChar(text[start - 1]!)) return null;
  if (!isAlpha(text[start]!)) return null;
  let index = start + 1;
  while (index < text.length) {
    const char = text[index]!;
    if (isAlpha(char) || isDigit(char) || char === '+' || char === '.' || char === '-') index += 1;
    else break;
  }
  if (text[index] !== ':' || text[index + 1] !== '/' || text[index + 2] !== '/') return null;
  const authorityStart = index + 3;
  let authorityEnd = authorityStart;
  while (authorityEnd < text.length && !isAuthorityStop(text[authorityEnd]!)) authorityEnd += 1;
  let at = -1;
  for (let scan = authorityStart; scan < authorityEnd; scan += 1) if (text[scan] === '@') at = scan;
  if (at < 0) return null;
  let colon = -1;
  for (let scan = authorityStart; scan < at; scan += 1)
    if (text[scan] === ':') {
      colon = scan;
      break;
    }
  // No userinfo, or an empty password: nothing to redact.
  if (colon < 0 || colon + 1 === at) return null;
  return { passwordStart: colon + 1, end: at + 1 };
}

/**
 * The credential redaction of free text, in one pass (#885, #898, #902 round 2, #920). A key is a
 * credential key when its last word — split on camelCase/PascalCase, `_`, `-` and `.` — is a
 * credential word, so `authToken`, `apiSecret`, `X-Auth-Token`, `access_token` and `sessionKey`
 * match while `monkey`, `keyboard`, `author`, `authority` and `sessions_count` do not. The words are
 * exactly the singular spellings (plus `credentials`, whose plural is the noun), so an ordinary
 * message such as `Allowed keys: (none)` or `expected tokens: 3` keeps its list. `key` additionally
 * needs a qualifier in front of it (`KEY_QUALIFIERS`): `secretKey` and `x-api-key` are credentials,
 * `entryKey`, `sortKey` and `idempotencyKey` are ordinary fields whose values stay readable.
 *
 * Grammar of the text this walks, where KEY is a credential key:
 *
 *   text        := ( url | pair | char )*
 *   url         := scheme "://" authority        — the password between the userinfo's first `:`
 *                                                  and the authority's last `@` is redacted
 *   pair        := KEY quote? space* (":" | "=") space* value
 *   value       := marker | auth-scheme | nested-pair | structure | quoted | pem | token
 *   marker      := "[redacted]"                  — kept as is, so a second pass changes nothing
 *   auth-scheme := ("Bearer"|"Basic") space+ value
 *   nested-pair := KEY quote? space* (":"|"=")   — left to the scan, which redacts its own value
 *   structure   := balanced `[…]`/`{…}`, strings escape-aware, depth ≤ 8, ≤ 4 KiB
 *   quoted      := "…" (with \\ escapes) | '…'
 *   pem         := "-----BEGIN …-----" … "-----END …-----" (≤ 8 KiB)
 *   token       := any run up to whitespace, `,`, `;`, `&`, `}`, `]` or a quote
 *
 * Every branching path consumes the characters it examined: a key run, a structure, a quoted string,
 * a PEM block and a token are each walked once and skipped, and the two-pointer backtracking that
 * the old patterns needed is gone, so the cost is linear in the length of the text. A value that
 * cannot be delimited (an unbalanced structure or an unclosed quote) is redacted to the end of its
 * line rather than left readable.
 */
function redactScan(text: string): string {
  let out = '';
  let copied = 0;
  let index = 0;
  const length = text.length;
  while (index < length) {
    const url = urlUserinfoAt(text, index);
    if (url) {
      // The password, then the `@` that ends the userinfo (the emit runs up to it, not past it).
      out += `${text.slice(copied, url.passwordStart)}${MARKER}@`;
      copied = url.end;
      index = url.end;
      continue;
    }
    if (!isKeyChar(text[index]!) || (index > 0 && isKeyChar(text[index - 1]!))) {
      index += 1;
      continue;
    }
    const keyEnd = keyRunEnd(text, index);
    let afterKey = keyEnd;
    if (text[afterKey] === '"' || text[afterKey] === "'") afterKey += 1;
    let separator = afterKey;
    while (separator < length && isSpaceChar(text[separator]!)) separator += 1;
    if (text[separator] !== ':' && text[separator] !== '=') {
      index = keyEnd;
      continue;
    }
    let valueStart = separator + 1;
    while (valueStart < length && isSpaceChar(text[valueStart]!)) valueStart += 1;
    const value = isCredentialKey(text.slice(index, keyEnd)) ? redactValue(text, valueStart) : null;
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
 */
export function redactCredentials(text: string): string {
  let out = redactScan(text);
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
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
