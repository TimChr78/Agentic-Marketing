// What a failure may say about itself (#885). An AppError message is written for a person and
// copied verbatim into the audit log and the agent ledger, so text that came from a provider, a
// driver or an exception must be reduced to a safe diagnostic before it is put there: a provider's
// own error code and message, never its body, and never a token the body or an exception echoes.

/**
 * Anything whose value is a credential: the key is kept (it says what failed), the value is not.
 * A key is a credential key when its last word — after splitting on camelCase/PascalCase
 * boundaries, `_`, `-` and `.` — is a credential word (#898). So `token`, `access_token`,
 * `x-api-key`, `authToken`, `apiSecret`, `secretKey`, `signingKey`, `oauthToken`, `sessionKey` and
 * `X-Auth-Token` all match, while `monkey`, `keyboard`, `author`, `authority`, `tokenizer` and
 * `sessions_count` do not: a word that merely contains the letters is not a credential word, and
 * only the last word decides.
 */
const CREDENTIAL_WORD = /^(?:tokens?|secrets?|passwords?|passwds?|keys?|authorizations?|auth|credentials?|signatures?|sessions?)$/;

/** The words of a key: `X-Auth-Token` → X, Auth, Token; `authToken` → auth, Token. */
function keyWords(key: string): string[] {
  return key
    .split(/[^A-Za-z0-9]+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/))
    .filter((word) => word !== '');
}

/** Whether a key names a credential. A trailing number is not a word: `apiKey2` still ends in `key`. */
function isCredentialKey(key: string): boolean {
  const words = keyWords(key);
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const word = words[index]!.replace(/[0-9]+$/, '');
    if (!word) continue;
    return CREDENTIAL_WORD.test(word.toLowerCase());
  }
  return false;
}

/**
 * A `key: value`, `key=value`, JSON pair or header: the key, an optional closing quote and the
 * separator. The value is matched separately and only for a credential key, so a value is never
 * rescanned and the redaction stays linear in the length of the text.
 */
const KEY_VALUE_PAIR = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)(["']?)(\s*[:=]\s*)/g;

/** The value of a pair: a quoted string (escapes included) or a run without whitespace or punctuation. */
const VALUE = /"(?:[^"\\]|\\.)*"|'[^']*'|[^\s,;&}\]"']+/y;

/**
 * URL userinfo (`scheme://user:password@host`), the shape a driver error quotes when a connection
 * string fails (#920). Any scheme: `postgres`, `http`, `redis`, `nats`, `amqp`, `mongodb+srv`. The
 * user is kept, the password is not, whatever its length and whether it is percent-escaped.
 */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)([^/?#@:\s]{0,128}):([^@/\s]{1,256})@/gi;

/**
 * A value that is itself a credential pair (`token: access_token=…`): the outer key keeps its own
 * value, which the next step of the scan redacts in place.
 */
const NESTED_PAIR = /^([A-Za-z0-9_.-]+)(["']?)\s*[:=]/;

/** `Bearer`/`Basic` at a position, read without copying the rest of the text. */
const AUTH_SCHEME = /(?:bearer|basic)\s/iy;

/**
 * Replaces the value of every credential key. A pair whose key is not a credential is left alone and
 * the scan continues inside its value, so a credential pair nested in a URL or a JSON string is
 * still found (`url=https://host?token=…`).
 */
function redactKeyValuePairs(text: string): string {
  let out = '';
  let cursor = 0;
  KEY_VALUE_PAIR.lastIndex = 0;
  let match = KEY_VALUE_PAIR.exec(text);
  while (match) {
    const [prefix, key = '', quote = '', separator = ''] = match;
    const valueStart = match.index + prefix.length;
    if (isCredentialKey(key)) {
      VALUE.lastIndex = valueStart;
      const value = VALUE.exec(text);
      AUTH_SCHEME.lastIndex = valueStart;
      const nested = value ? NESTED_PAIR.exec(value[0]) : null;
      // A `Bearer`/`Basic` value is left to the scheme rule, which keeps the scheme word; a value
      // that is already `[redacted]` is not written twice; and a nested credential pair is redacted
      // by its own key instead of swallowing the key's text (#885 round 3, #898).
      const replace =
        value !== null &&
        !value[0].startsWith('[redacted]') &&
        !AUTH_SCHEME.test(text) &&
        !(nested !== null && isCredentialKey(nested[1] ?? ''));
      if (replace) {
        out += text.slice(cursor, match.index) + `${key}${quote}${separator}[redacted]`;
        cursor = valueStart + value[0].length;
        KEY_VALUE_PAIR.lastIndex = cursor;
        match = KEY_VALUE_PAIR.exec(text);
        continue;
      }
    }
    // The key is at least one character, so this always moves the scan forward.
    KEY_VALUE_PAIR.lastIndex = valueStart;
    match = KEY_VALUE_PAIR.exec(text);
  }
  return out + text.slice(cursor);
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
  let out = text.replace(URL_USERINFO, '$1$2:[redacted]@');
  out = redactKeyValuePairs(out);
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
