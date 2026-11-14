// What a failure may say about itself (#885). An AppError message is written for a person and
// copied verbatim into the audit log and the agent ledger, so text that came from a provider, a
// driver or an exception must be reduced to a safe diagnostic before it is put there: a provider's
// own error code and message, never its body, and never a token the body or an exception echoes.

/**
 * Anything whose value is a credential: the key is kept (it says what failed), the value is not.
 * The key may be a word on its own (`token`, `key`, `session`) or end in one after a separator
 * (`access_token`, `x-api-key`, `client-secret`); an alphanumeric neighbour (`monkey`) is not a key.
 */
const COMPOUND_CREDENTIAL_KEY =
  'access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|developer[_-]?token|' +
  'client[_-]?secret|app[_-]?secret|private[_-]?key|api[_-]?key';
const CREDENTIAL_KEY =
  `(?<![A-Za-z0-9])(?:${COMPOUND_CREDENTIAL_KEY}|` +
  'token|secret|password|passwd|key|authorization|auth|credential|signature|session)(?![A-Za-z0-9])';

/** Our own external ids (`mnd_…`, `eml_…`): identifiers, never credentials. */
const ID_LIKE = '(?:[a-z]{2,5})_[0-9a-f]{32}';

/**
 * Token-shaped values, in the order they must be applied: a named credential (`access_token=…`,
 * `"developer-token": "…"`), a provider's own prefix (`shpat_…`, `sk_live_…`, a JWT), an
 * Authorization value (`Bearer …`), then a bare long token (base64, base64url or hex), which is
 * what a gateway echoing a header leaves behind.
 */
const REDACTIONS: readonly (readonly [RegExp, string])[] = [
  [
    // A quoted or bare value, unless it is an Authorization value (`Bearer <token>`, which the scheme
    // rule below redacts while keeping the scheme word). Only a scheme word followed by whitespace
    // counts: `Bearer-probe-secret` is a credential value, not a scheme (#885 round 3).
    new RegExp(
      `(${CREDENTIAL_KEY})(["']?)(\\s*[:=]\\s*)(?!(?:Bearer|Basic)\\s|\\[redacted\\]|(?:${COMPOUND_CREDENTIAL_KEY})\\s*[:=])("(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s,;&}\\]"']+)`,
      'gi',
    ),
    '$1$2$3[redacted]',
  ],
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
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  // The two additions (#898, #920) run on what the rules above produced and only ever replace
  // more of it, so nothing those rules removed can come back, whatever the input looks like.
  // They are repeated until neither changes anything, so the result is the same on a second
  // call: one rule's marker can complete a match for the other (`a://key://x;u:p@h`). Each round
  // that changes the text turns ordinary characters into the marker, so it ends; the bound is a
  // backstop.
  const markerKeys = hasLongCompoundKey(text);
  for (let round = 0; round < 8; round += 1) {
    const next = redactCompoundKeys(redactUrlPasswords(out), markerKeys);
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * The words that make a compound key a credential key when they are its LAST word (#898):
 * `authToken`, `apiSecret`, `oauthToken`, `userPassword`. The rules above already cover the word on
 * its own and after a separator (`auth_token`, `X-Auth-Token`); this covers camelCase and
 * PascalCase, where no separator marks the word.
 */
const CREDENTIAL_LAST_WORDS = new Set([
  'token',
  'secret',
  'password',
  'passwd',
  'authorization',
  'auth',
  'credential',
  'credentials',
  'signature',
  'session',
]);

/**
 * `key` is different: `entryKey`, `sortKey`, `idempotencyKey` and `primaryKey` are ordinary fields,
 * and validation messages that name them must stay readable. A camelCase compound that ends in
 * `Key` is a credential key only when one of its earlier words is a qualifier from this list
 * (`secretKey`, `signingKey`, `sessionKey`, `shopifyKey`, `metaAdsKey`).
 *
 * The trade-off: a provider inventing a new spelling such as `tenantKey` is not caught by this rule.
 * Its value is still subject to every other rule (a provider prefix, a JWT, a `Bearer` value, a URL
 * password, a 24+ character bare token), and `tenant_key` / `x-tenant-key` are credential keys as
 * they always were. The list is checked against the provider registries in
 * `apps/server/test/redaction-providers.test.ts`, so a new adapter or connector without a
 * qualifier fails that test. `public`, `publishable` and `log` are deliberately out: a published
 * key is not a secret.
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

const CAMEL_BOUNDARY = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;

/** The unambiguous credential words an all-capitals name can end in (`AUTHTOKEN`, `DBPASSWORD`). */
const UPPER_SUFFIXES = ['token', 'secret', 'password', 'passwd', 'credential', 'credentials', 'signature'];

/**
 * An all-capitals name has no word boundaries, so only its ending can be read: an unambiguous
 * credential word, or a qualifier directly before `KEY` (`SECRETKEY`, `ACCESSKEY`). `MONKEY` and
 * `KEYBOARD` are neither.
 */
function isUpperCredentialKey(name: string): boolean {
  const lower = name.toLowerCase();
  if (UPPER_SUFFIXES.some((word) => lower.length > word.length && lower.endsWith(word))) return true;
  if (!lower.endsWith('key')) return false;
  const stem = lower.slice(0, -3);
  for (const qualifier of KEY_QUALIFIERS) if (stem.endsWith(qualifier)) return true;
  return false;
}

/**
 * Whether a name is a credential key the rules above do not already recognise: a camelCase or
 * PascalCase compound (`authToken`, `AWSSecretKey`, `apiKey2`), also inside a longer name
 * (`meta_adsKey`, `X-meta-adsKey`), an all-capitals name, or the plural `credentials`.
 */
function isCompoundCredentialKey(full: string): boolean {
  let known = KEY_VERDICTS.get(full);
  if (known === undefined) {
    known = classifyCompoundKey(full);
    // Bounded: a text of a million distinct names must not grow this without limit.
    if (KEY_VERDICTS.size >= 2_000) KEY_VERDICTS.clear();
    KEY_VERDICTS.set(full, known);
  }
  return known;
}

const KEY_VERDICTS = new Map<string, boolean>();

function classifyCompoundKey(full: string): boolean {
  // Cheap first: every name this rule adds has a capital letter or is the plural `credentials`.
  if (!/[A-Z]|credentials[0-9]*$/.test(full)) return false;
  const name = full.replace(/[0-9]+$/, '');
  const parts = name.split(/[_.-]+/).filter(Boolean);
  const lastPart = parts[parts.length - 1];
  if (!lastPart) return false;
  if (!/[a-z]/.test(lastPart)) return isUpperCredentialKey(lastPart);
  const words = parts.flatMap((part) => part.split(CAMEL_BOUNDARY)).map((word) => word.toLowerCase());
  const last = words[words.length - 1]!;
  if (last === 'credentials') return true;
  // A single word, or a word after a separator, is the first rule's business (`token`, `auth_token`).
  if (lastPart.split(CAMEL_BOUNDARY).length < 2) return false;
  if (CREDENTIAL_LAST_WORDS.has(last)) return true;
  return (last === 'key' || last === 'keys') && words.slice(0, -1).some((word) => KEY_QUALIFIERS.has(word));
}

/**
 * A name, with its `_`, `-` and `.` separators, that is directly followed by `:` or `=` (an
 * optional closing quote in between). It can only start where a name starts, so a long run is
 * read once.
 */
const COMPOUND_KEY = /(?<![A-Za-z0-9_.-])[A-Za-z][A-Za-z0-9_.-]*(?=["']?\s*[:=])/g;

/**
 * The same, or the marker in a key's place: what the bare-token rule leaves of a long key. That
 * rule takes a trailing `=` with the key, so the marker can also stand directly before the value.
 */
const KEY_OR_MARKER = /\[redacted\](?=["']?\s*[:=]|[^\s,;&}\]"'[])|(?<![A-Za-z0-9_.-])[A-Za-z][A-Za-z0-9_.-]*(?=["']?\s*[:=])/g;

/** A name long enough for the bare-token rule to replace it before its value is looked at. */
const TOKEN_SHAPED = /[A-Za-z0-9+/_-]{24,}/;

/**
 * Whether the text has a compound credential key that is itself token-shaped
 * (`organizationSecondaryAuthToken=…`). The rules above replace such a key with the marker, so
 * afterwards only the marker in front of a separator shows where its value is.
 */
function hasLongCompoundKey(text: string): boolean {
  COMPOUND_KEY.lastIndex = 0;
  for (let key = COMPOUND_KEY.exec(text); key; key = COMPOUND_KEY.exec(text))
    if (key[0].length >= 24 && TOKEN_SHAPED.test(key[0]) && isCompoundCredentialKey(key[0])) return true;
  return false;
}

/** What separates a key from its value, with an optional closing quote of the key before it. */
const PAIR_SEPARATOR = /["']?\s*[:=]\s*/y;

/**
 * A value: a run of quoted strings, markers and bare characters up to whitespace or a delimiter.
 * It is the first rule's grammar (quoted, or bare) made greedy: text glued to a quoted string or
 * to a marker (`"a"b`, `x.[redacted]`) is part of the value, so what one pass leaves is not a
 * value the next pass would still replace.
 */
const PAIR_VALUE = /(?:"(?:[^"\\]|\\[\s\S])*"|'[^']*'|\[redacted\]|[^\s,;&}\]"'])+/y;

/** A flag, not a secret: `requiresAuth: true`, `hasPassword: false`, `session: null`. */
const PLAIN_LITERAL = /^(?:true|false|null|undefined)$/;

/** An Authorization value (`Bearer <token>`): the scheme rule above owns it and keeps the word. */
const SCHEME_START = /(?:bearer|basic)\s/iy;

/**
 * Replaces the value of every camelCase credential key in text the rules above have already been
 * through. With `markerKeys`, the marker in a key's place counts as a key too. Each character is
 * read a bounded number of times.
 */
function redactCompoundKeys(text: string, markerKeys: boolean): string {
  let out = '';
  let copied = 0;
  KEY_OR_MARKER.lastIndex = 0;
  for (let key = KEY_OR_MARKER.exec(text); key; key = KEY_OR_MARKER.exec(text)) {
    const keyEnd = key.index + key[0].length;
    if (key[0] === '[redacted]' ? !markerKeys : !isCompoundCredentialKey(key[0])) continue;
    PAIR_SEPARATOR.lastIndex = keyEnd;
    const separator = PAIR_SEPARATOR.exec(text);
    if (!separator && key[0] !== '[redacted]') continue;
    const start = keyEnd + (separator?.[0].length ?? 0);
    SCHEME_START.lastIndex = start;
    if (SCHEME_START.test(text)) continue;
    PAIR_VALUE.lastIndex = start;
    const value = PAIR_VALUE.exec(text);
    if (!value) continue;
    KEY_OR_MARKER.lastIndex = start + value[0].length;
    if (value[0] === '[redacted]' || PLAIN_LITERAL.test(value[0])) continue;
    out += `${text.slice(copied, start)}[redacted]`;
    copied = start + value[0].length;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/**
 * The password in `scheme://user:password@host` (#920), for any scheme: a connection string a
 * driver or a client echoes. The authority ends at the first `/`, `?`, `#` or whitespace, and its
 * LAST `@` ends the userinfo, so a password that contains `@` is replaced whole. A URL without a
 * password (`https://user@host`, `mailto:a@b.c`, `https://host/path?x=a:b@c`) is left alone.
 */
const URL_PASSWORD = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/?#@:]*):[^\s/?#]*@/g;

function redactUrlPasswords(text: string): string {
  return text.replace(URL_PASSWORD, '$1:[redacted]@');
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
