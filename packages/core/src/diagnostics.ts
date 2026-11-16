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
  // A long camelCase credential key is replaced as a token by the rules below, after which its
  // value can no longer be told from any other text. So the plain value of such a key is replaced
  // first (#898); see redactLongKeyValues for why that cannot change what the rules below remove.
  // The #937 value shapes have the same problem: a rule consumes the delimiter the shape needs
  // (`[`, a Unicode opening quote, `>`, `-----BEGIN`), so those passes run first too.
  let out = applyRules(redactLongKeyValues(redactIntactValueShapes(text)));
  // Main's 0.14.23 passes converge first, on exactly the release's rules and qualifiers. Only then
  // do the #946/#956 additions run, so they can add redaction but can never consume a key main's
  // next round would have needed. If an addition exposes a new main match, main settles again.
  const settleMain = (input: string): string => {
    let current = input;
    for (let round = 0; round < 16; round += 1) {
      const next = applyRules(redactCompoundKeys(redactUrlPasswords(current)));
      if (next === current) break;
      current = next;
    }
    return current;
  };
  const settleAdded = (input: string): string => {
    let current = input;
    for (let round = 0; round < 16; round += 1) {
      const next = applyRules(redactJoinedCompoundKeys(redactPrefixedCompoundKeys(current)));
      if (next === current) break;
      current = next;
    }
    return current;
  };
  out = settleMain(out);
  for (let round = 0; round < 16; round += 1) {
    // The #937 passes that survive the rules run on the output of everything above, then main
    // settles again so an addition that exposes a main match is still handled.
    const shaped = redactSettledValueShapes(settleAdded(out));
    if (shaped === out) break;
    out = settleMain(shaped);
  }
  return out;
}

function applyRules(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
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
  // Model providers (packages/ai: `openai-compatible`, `anthropic-compatible`). The known provider
  // names in packages/ai `modelProviderNames` are the same population, and the completeness test
  // fails for one without a qualifier here (#956, #968 review).
  'openai',
  'anthropic',
  'azureopenai',
  'mistral',
  'ollama',
  'vllm',
  'litellm',
  'openrouter',
  'lmstudio',
  'groq',
  'together',
  'deepseek',
  'gemini',
  'cohere',
  'perplexity',
  'fireworks',
  'huggingface',
  'hf',
  'replicate',
  'xai',
  'bedrock',
  'vertex',
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
 * Provider qualifiers this batch added (#956). They are handled after main's 0.14.23 settle loop,
 * so main's own classifier stays exactly the release's list and the additions are purely additive.
 */
const ADDED_PROVIDER_QUALIFIERS = new Set([
  'mistral',
  'ollama',
  'vllm',
  'litellm',
  'openrouter',
  'lmstudio',
  'groq',
  'together',
  'deepseek',
  'gemini',
  'cohere',
  'perplexity',
  'fireworks',
  'huggingface',
  'hf',
  'replicate',
  'xai',
  'bedrock',
  'vertex',
  'azureopenai',
]);
const MAIN_KEY_QUALIFIERS = new Set([...KEY_QUALIFIERS].filter((qualifier) => !ADDED_PROVIDER_QUALIFIERS.has(qualifier)));

/**
 * The redaction marker. A second pass must leave it exactly as it is (#919 round 2), so it is
 * recognised before anything else that starts with `[`, and only when the value really ends there.
 */

const CAMEL_BOUNDARY = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;

/** `apiKey2` → `apiKey`. A loop, not a pattern: an end-anchored `+` is quadratic on a long run. */
function withoutTrailingDigits(name: string): string {
  let end = name.length;
  while (end > 0 && name.charCodeAt(end - 1) >= 48 && name.charCodeAt(end - 1) <= 57) end -= 1;
  return end === name.length ? name : name.slice(0, end);
}

const isSpace = (char: string): boolean => char !== '' && /\s/.test(char);

/**
 * Where a separator that starts at `pos` ends, or -1: an optional closing quote of the key,
 * whitespace, `:` or `=`, and (with `trailing`) the whitespace after it. Read by hand so the work
 * is plainly one pass over the characters it consumes.
 */
function separatorEnd(text: string, pos: number, trailing: boolean): number {
  let index = pos;
  const quote = text.charAt(index);
  if (quote === '"' || quote === "'") index += 1;
  while (isSpace(text.charAt(index))) index += 1;
  const mark = text.charAt(index);
  if (mark !== ':' && mark !== '=') return -1;
  index += 1;
  if (trailing) while (isSpace(text.charAt(index))) index += 1;
  return index;
}

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
  for (const qualifier of MAIN_KEY_QUALIFIERS) if (stem.endsWith(qualifier)) return true;
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
  if (!/[A-Z]/.test(full) && !withoutTrailingDigits(full).endsWith('credentials')) return false;
  const name = withoutTrailingDigits(full);
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
  return (last === 'key' || last === 'keys') && words.slice(0, -1).some((word) => MAIN_KEY_QUALIFIERS.has(word));
}

/**
 * A name, with its `_`, `-` and `.` separators, that is directly followed by `:` or `=` (an
 * optional closing quote in between). It can only start where a name starts, so a long run is
 * read once.
 */
const COMPOUND_KEY = /(?<![A-Za-z0-9_.-])[A-Za-z][A-Za-z0-9_.-]*(?=["']?\s*[:=])/g;

/** A name long enough for the bare-token rule to replace it before its value is looked at. */
const TOKEN_SHAPED = /[A-Za-z0-9+/_-]{24,}/;

/** A plain value: one token, or a quoted string, with nothing a rule could read as a pair. */
const PLAIN_CHAR = /[A-Za-z0-9._~+/@%!$*#^-]/;
const PLAIN_QUOTED = /"[^"'\\:=\r\n]+"|'[^"'\\:=\r\n]+'/y;

/** The end of a plain bare token at `pos` (followed by the end, whitespace or a delimiter), or -1. */
function plainBareEnd(text: string, pos: number): number {
  let index = pos;
  while (index < text.length && PLAIN_CHAR.test(text.charAt(index))) index += 1;
  if (index === pos) return -1;
  const next = text.charAt(index);
  return next === '' || isSpace(next) || ',;&}]'.includes(next) ? index : -1;
}

const SCHEME_WORD = /\b(?:bearer|basic)\b/i;

/**
 * Replaces the value of a credential key that is itself token-shaped
 * (`organizationSecondaryAuthToken=shortpw`), before the rules run.
 *
 * Only a plain value is taken: one token, or the content of a quoted string (its quotes stay),
 * that contains no `:` or `=`, no quote of either kind, no Authorization scheme word, and is not
 * followed by a separator. Such a value cannot be
 * a key, a scheme or part of a pair for any rule, so replacing it with the marker changes nothing
 * about what the rules remove elsewhere. Any other value is left as it is.
 */
function redactLongKeyValues(text: string): string {
  let out = '';
  let copied = 0;
  COMPOUND_KEY.lastIndex = 0;
  for (let key = COMPOUND_KEY.exec(text); key; key = COMPOUND_KEY.exec(text)) {
    if (key[0].length < 24 || !TOKEN_SHAPED.test(key[0]) || !isCompoundCredentialKey(key[0])) continue;
    const keyEnd = key.index + key[0].length;
    const start = separatorEnd(text, keyEnd, true);
    if (start < 0) continue;
    PLAIN_QUOTED.lastIndex = start;
    const quoted = PLAIN_QUOTED.exec(text)?.[0];
    const bareEnd = quoted ? -1 : plainBareEnd(text, start);
    const value = quoted ?? (bareEnd < 0 ? undefined : text.slice(start, bareEnd));
    if (!value || SCHEME_WORD.test(value) || PLAIN_LITERAL.test(value)) continue;
    // A separator after the value: the value is then a key itself and is left to the rules.
    if (separatorEnd(text, start + value.length, false) >= 0) continue;
    // A quoted value keeps its quotes: either may also delimit a string around this pair
    // (`token="… longAuthToken="x"`), and the rules must still see it.
    const inset = quoted ? 1 : 0;
    out += `${text.slice(copied, start + inset)}[redacted]`;
    copied = start + value.length - inset;
    COMPOUND_KEY.lastIndex = copied;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/**
 * A value, in the grammar of the first rule above: a quoted string, or a bare value up to
 * whitespace, a delimiter or a quote. A marker inside a bare value is part of it
 * (`x.[redacted]`), so a value the rules replaced in part is replaced whole.
 */
const PAIR_VALUE = /"(?:[^"\\]|\\[\s\S])*"|'[^']*'|(?:\[redacted\]|[^\s,;&}\]"'])+/y;

/** A flag, not a secret: `requiresAuth: true`, `hasPassword: false`, `session: null`. */
const PLAIN_LITERAL = /^(?:true|false|null|undefined)$/;

/** An Authorization value (`Bearer <token>`): the scheme rule above owns it and keeps the word. */
const SCHEME_START = /(?:bearer|basic)\s/iy;

/**
 * Replaces the value of every camelCase credential key in text the rules above have already been
 * through. Each character is read a bounded number of times.
 */
function redactCompoundKeys(text: string): string {
  let out = '';
  let copied = 0;
  COMPOUND_KEY.lastIndex = 0;
  for (let key = COMPOUND_KEY.exec(text); key; key = COMPOUND_KEY.exec(text)) {
    const keyEnd = key.index + key[0].length;
    if (!isCompoundCredentialKey(key[0])) continue;
    const start = separatorEnd(text, keyEnd, true);
    if (start < 0) continue;
    SCHEME_START.lastIndex = start;
    if (SCHEME_START.test(text)) continue;
    PAIR_VALUE.lastIndex = start;
    const value = PAIR_VALUE.exec(text);
    if (!value) continue;
    COMPOUND_KEY.lastIndex = start + value[0].length;
    if (value[0] === '[redacted]' || PLAIN_LITERAL.test(value[0])) continue;
    out += `${text.slice(copied, start)}[redacted]`;
    copied = start + value[0].length;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/**
 * Main's compound pass takes a bare value up to whitespace or a quote. When that value is itself
 * the key of an inner pair (`mistralKey=apiSecret :''x`, `mistralKey=apiSecret="…"`), it replaces
 * the inner key and leaves the inner value behind. This pre-pass runs before that pass on the same
 * round and redacts the whole nested pair instead, so nothing main would have removed can be lost.
 * It only acts on a value that is a pair prefix, and only ever replaces more text.
 */
/**
 * Two additive passes that run on the text main's `redactCompoundKeys` produced, inside the settle
 * loop. Neither can take less than main: they only replace values the main pass left alone.
 *
 * 1. `redactPrefixedCompoundKeys` handles #946: `_secretKey`, `__authToken`, `$$SIGNINGKEY`. Main's
 *    `COMPOUND_KEY` deliberately does not start after `_`, `.` or `-`. A candidate may begin only
 *    at the start of a name run and must begin with one or more separators.
 * 2. `redactJoinedCompoundKeys` handles names such as `lmStudioKey`, whose provider word is only
 *    visible when camelCase words are joined (`lm` + `studio`). It runs after main so an inner pair
 *    (`lmStudioKey=apiSecret="…"`) is already redacted by the time the outer key is considered.
 *
 * Both scan each run once, so `'_a_'.repeat(1 MiB)` and `'secretKey='.repeat(n)` stay linear
 * (#968 review). Replacements are left-to-right and non-overlapping like a global regex: no
 * re-scan of suffixes and no span merging.
 */
const isRunChar = (char: string): boolean =>
  (char >= 'a' && char <= 'z') ||
  (char >= 'A' && char <= 'Z') ||
  (char >= '0' && char <= '9') ||
  char === '_' ||
  char === '.' ||
  char === '-' ||
  char === '$';
const isRunSeparator = (char: string): boolean => char === '_' || char === '.' || char === '-' || char === '$';
const isRunLetter = (char: string): boolean => (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z');
const isRunNameChar = (char: string): boolean =>
  isRunLetter(char) || (char >= '0' && char <= '9') || char === '_' || char === '.' || char === '-';

/** A name whose qualifier this batch added, so main sees the 0.14.23 qualifier list. */
function isAddedProviderKey(name: string): boolean {
  if (!/[A-Z]/.test(name)) return false;
  const parts = withoutTrailingDigits(name)
    .split(/[_.-]+/)
    .filter(Boolean);
  const lastPart = parts[parts.length - 1];
  if (!lastPart) return false;
  if (!/[a-z]/.test(lastPart)) {
    const lower = lastPart.toLowerCase();
    if (!lower.endsWith('key')) return false;
    const stem = lower.slice(0, -3);
    for (const qualifier of ADDED_PROVIDER_QUALIFIERS) if (stem.endsWith(qualifier)) return true;
    return false;
  }
  const words = parts.flatMap((part) => part.split(CAMEL_BOUNDARY)).map((word) => word.toLowerCase());
  const last = words[words.length - 1];
  if (last !== 'key' && last !== 'keys') return false;
  const stem = words.slice(0, -1);
  if (stem.some((word) => ADDED_PROVIDER_QUALIFIERS.has(word))) return true;
  const tail = stem.slice(-3);
  for (let start = 0; start < tail.length; start += 1) if (ADDED_PROVIDER_QUALIFIERS.has(tail.slice(start).join(''))) return true;
  return false;
}

type CandidateStart = (text: string, runStart: number) => number;

/** A run beginning with separators; the name starts at its first letter (#946). */
const prefixedStart: CandidateStart = (text, runStart) => {
  if (!isRunSeparator(text.charAt(runStart))) return -1;
  let nameStart = runStart;
  while (nameStart < text.length && isRunSeparator(text.charAt(nameStart))) nameStart += 1;
  return isRunLetter(text.charAt(nameStart)) ? nameStart : -1;
};

/** A run beginning with a letter, for a joined provider name such as `lmStudioKey`. */
const joinedStart: CandidateStart = (text, runStart) => (isRunLetter(text.charAt(runStart)) ? runStart : -1);

/** Characters that end a bare value in `PAIR_VALUE`'s third alternative. */
const BARE_VALUE_STOP = new Set([',', ';', '&', '}', ']', '"', "'"]);

/**
 * The end of the value `PAIR_VALUE` would match at `start`, or -1 when it matches nothing: a
 * double-quoted string with backslash escapes, a single-quoted string, or a bare run (which may
 * contain `[redacted]`). A hand-written scan of the same grammar, so the additive passes do not
 * hand a sticky regex to text CodeQL treats as uncontrolled (#946 review); main's pass keeps the
 * regex unchanged.
 */
function pairValueEnd(text: string, start: number): number {
  const first = text.charAt(start);
  if (first === '"') {
    for (let index = start + 1; index < text.length; index += 1) {
      const char = text.charAt(index);
      if (char === '\\') {
        if (index + 1 >= text.length) return -1;
        index += 1;
      } else if (char === '"') return index + 1;
    }
    return -1;
  }
  if (first === "'") {
    const close = text.indexOf("'", start + 1);
    return close < 0 ? -1 : close + 1;
  }
  let index = start;
  while (index < text.length) {
    if (text.startsWith('[redacted]', index)) {
      index += '[redacted]'.length;
      continue;
    }
    const char = text.charAt(index);
    if (isSpace(char) || BARE_VALUE_STOP.has(char)) break;
    index += 1;
  }
  return index > start ? index : -1;
}

/** Scans each name run once and replaces values with the same grammar `redactCompoundKeys` uses. */
function redactCompoundRuns(text: string, candidateStart: CandidateStart, accept: (name: string) => boolean): string {
  let out = '';
  let copied = 0;
  let index = 0;
  while (index < text.length) {
    if (!isRunChar(text.charAt(index))) {
      index += 1;
      continue;
    }
    const runStart = index;
    while (index < text.length && isRunChar(text.charAt(index))) index += 1;
    const runEnd = index;
    const nameStart = candidateStart(text, runStart);
    if (nameStart < 0 || nameStart >= runEnd) continue;
    let nameEnd = nameStart + 1;
    while (nameEnd < runEnd && isRunNameChar(text.charAt(nameEnd))) nameEnd += 1;
    const name = text.slice(nameStart, nameEnd);
    const start = separatorEnd(text, nameEnd, true);
    if (start < 0 || !accept(name)) continue;
    SCHEME_START.lastIndex = start;
    if (SCHEME_START.test(text)) continue;
    const valueEnd = pairValueEnd(text, start);
    if (valueEnd < 0) continue;
    const value = text.slice(start, valueEnd);
    if (value === '[redacted]' || PLAIN_LITERAL.test(value)) continue;
    out += `${text.slice(copied, start)}[redacted]`;
    copied = valueEnd;
    index = valueEnd;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

function redactPrefixedCompoundKeys(text: string): string {
  if (!/[_.$-][A-Za-z]/.test(text)) return text;
  return redactCompoundRuns(text, prefixedStart, (name) => isCompoundCredentialKey(name) || isAddedProviderKey(name));
}

function redactJoinedCompoundKeys(text: string): string {
  if (!/[A-Z]/.test(text)) return text;
  return redactCompoundRuns(text, joinedStart, isAddedProviderKey);
}

/**
 * The value shapes #937 collects: a structured value under a credential key, a short Authorization
 * value, a Unicode-quoted value, `=>` as the separator, a PEM block, escaped JSON, URL-encoded
 * pairs, a `Pwd`/`Pass` name and a nested all-capitals pair.
 *
 * Every pass below reads the text once and replaces a value with the marker. They run before the
 * rules as well as on their output, for the same reason `redactLongKeyValues` runs before them: the
 * rules destroy the delimiters these shapes need (a Unicode quote's opening half, the `>` of `=>`,
 * the `-----BEGIN` of a PEM header, the `[` of an array). A shape is therefore replaced while it is
 * still intact; the second run is the additive pass over everything the rules produced, and only
 * ever replaces more.
 */
const MAX_SHAPE_KEY_CHARS = 256;
const MAX_SHAPE_DEPTH = 32;

const isShapeNameChar = (char: string): boolean =>
  (char >= 'a' && char <= 'z') ||
  (char >= 'A' && char <= 'Z') ||
  (char >= '0' && char <= '9') ||
  char === '_' ||
  char === '.' ||
  char === '-';

const isShapeNameStart = (char: string): boolean => (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z');

/**
 * A credential name as the rules and the compound classifier read it, plus this batch's own
 * additions: a name that ENDS in a credential word (`token`, `api_key`, `X-Auth-Token`), a
 * camelCase/PascalCase or all-capitals compound, a provider qualifier from #956, or a `Pwd`/`Pass`
 * ending. Ending matters: `token_count` and `tokens_count` are ordinary counters.
 */
const PLAIN_CREDENTIAL_SUFFIX = new RegExp(`(?:${CREDENTIAL_KEY})$`, 'i');

function isPwdPassKey(name: string): boolean {
  const trimmed = withoutTrailingDigits(name);
  if (trimmed.length > 4 && trimmed.endsWith('Pwd') && /[a-z0-9]/.test(trimmed.charAt(trimmed.length - 4))) return true;
  if (trimmed.length > 5 && trimmed.endsWith('Pass') && /[a-z0-9]/.test(trimmed.charAt(trimmed.length - 5))) return true;
  const parts = trimmed.split(/[_.-]+/).filter(Boolean);
  if (parts.length < 2) return false;
  const last = parts[parts.length - 1]!.toLowerCase();
  return last === 'pwd' || last === 'pass';
}

function isShapesCredentialKey(name: string): boolean {
  return isCompoundCredentialKey(name) || isAddedProviderKey(name) || isPwdPassKey(name) || PLAIN_CREDENTIAL_SUFFIX.test(name);
}

interface ValueSpan {
  start: number;
  end: number;
}

/**
 * Replaces the value of every credential pair a shape pass recognises. A candidate may start only
 * where the previous one ended, so each suffix is read once, like a global regex's scan.
 */
function redactPairValues(
  text: string,
  separator: (text: string, nameEnd: number) => number,
  valueSpan: (text: string, valueStart: number) => ValueSpan | null,
): string {
  let out = '';
  let copied = 0;
  let index = 0;
  while (index < text.length) {
    if (!isShapeNameStart(text.charAt(index))) {
      index += 1;
      continue;
    }
    let nameEnd = index + 1;
    while (nameEnd < text.length && isShapeNameChar(text.charAt(nameEnd))) nameEnd += 1;
    // The separator is the cheap test and almost no word has one; classify only then, so a long
    // text of ordinary words does not run the name classifier for each of them.
    const valueStart = separator(text, nameEnd);
    if (valueStart < 0) {
      index = nameEnd;
      continue;
    }
    const name = text.slice(index, nameEnd);
    if (name.length > MAX_SHAPE_KEY_CHARS || !isShapesCredentialKey(name)) {
      index = nameEnd;
      continue;
    }
    const span = valueSpan(text, valueStart);
    if (!span || span.end <= span.start) {
      index = nameEnd;
      continue;
    }
    const value = text.slice(span.start, span.end);
    if (value === '[redacted]' || PLAIN_LITERAL.test(value)) {
      index = nameEnd;
      continue;
    }
    out += `${text.slice(copied, span.start)}[redacted]`;
    copied = span.end;
    index = Math.max(span.end, nameEnd);
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/** The end of the line a value started on, so an unbalanced shape never leaves the secret. */
function lineEnd(text: string, start: number): number {
  const newline = text.indexOf('\n', start);
  return newline < 0 ? text.length : newline;
}

/**
 * A JSON array or object value under a credential key: `{"token":["shortpw"]}`,
 * `{"secret":{"v":"x"}}`. Brackets are scanned to a bounded depth and strings are skipped, so a
 * bracket inside a quoted string does not close the value. An unbalanced value is replaced up to
 * the end of its line (chosen over "the next `,`/`}` at depth 0" because a multi-line secret is
 * the case that matters, and stopping at the line never leaves any of it).
 */
function structuredValueEnd(text: string, start: number): number {
  const open = text.charAt(start);
  if (open !== '[' && open !== '{') return -1;
  let depth = 0;
  let quote = '';
  let index = start;
  while (index < text.length) {
    const char = text.charAt(index);
    if (quote !== '') {
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === quote) quote = '';
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      index += 1;
      continue;
    }
    if (char === '[' || char === '{') {
      depth += 1;
      if (depth > MAX_SHAPE_DEPTH) return lineEnd(text, start);
    } else if (char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return lineEnd(text, start);
}

function redactStructuredValues(text: string): string {
  if (!/[[{]/.test(text)) return text;
  const span = (value: string, start: number): ValueSpan | null => {
    const end = structuredValueEnd(value, start);
    return end < 0 ? null : { start, end };
  };
  return redactPairValues(text, (value, nameEnd) => separatorEnd(value, nameEnd, true), span);
}

/**
 * A short Authorization value under a key: `authToken=Bearer abc`, `password: Basic xyz`. The
 * scheme rule above needs six characters, so a short token is left behind; the scheme word is kept
 * (it says what was sent) and only the token after it is replaced. It runs after the rules, not
 * before them: a pre-pass value can end at a nested key (`Authorization: Basic
 * organizationSecondaryAuthToken="x"`), and replacing that key would hide the value from
 * `redactLongKeyValues`.
 */
function schemeValueSpan(text: string, start: number): ValueSpan | null {
  let index = start;
  let schemes = 0;
  for (;;) {
    SCHEME_START.lastIndex = index;
    const scheme = SCHEME_START.exec(text);
    if (!scheme) break;
    index += scheme[0].length;
    schemes += 1;
    while (isSpace(text.charAt(index))) index += 1;
  }
  if (schemes === 0) return null;
  const end = pairValueEnd(text, index);
  return end < 0 ? null : { start: index, end };
}

function redactShortSchemeValues(text: string): string {
  if (!/bearer|basic/i.test(text)) return text;
  return redactPairValues(text, (value, nameEnd) => separatorEnd(value, nameEnd, true), schemeValueSpan);
}

/** Opening typographic quotes and the character that closes each. */
const UNICODE_QUOTE_CLOSERS = new Map<string, string>([
  ['\u201c', '\u201d'],
  ['\u2018', '\u2019'],
  ['\u00ab', '\u00bb'],
  ['\u201e', '\u201c'],
  ['\u2039', '\u203a'],
]);

/**
 * A value in typographic quotes: `token: “short pw”`, `‘…’`, `«…»`. The rules see only up to the
 * first space (`“short`), which leaves the rest of the value; this consumes the whole pair. An
 * unterminated quote runs to the end of its line, so a value broken across lines never survives
 * and the next line stays readable.
 */
function unicodeValueSpan(text: string, start: number): ValueSpan | null {
  const close = UNICODE_QUOTE_CLOSERS.get(text.charAt(start));
  if (close === undefined) return null;
  let index = start + 1;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === '\n') return { start, end: index };
    if (char === close) return { start, end: index + 1 };
    index += 1;
  }
  return { start, end: text.length };
}

function redactUnicodeQuotedValues(text: string): string {
  if (!/[\u201c\u2018\u00ab\u201e\u2039]/.test(text)) return text;
  return redactPairValues(text, (value, nameEnd) => separatorEnd(value, nameEnd, true), unicodeValueSpan);
}

/** The value after `=>`, the arrow PHP and Ruby arrays use (`'password' => 'x'`). */
function arrowSeparatorEnd(text: string, nameEnd: number): number {
  let index = nameEnd;
  const quote = text.charAt(index);
  if (quote === '"' || quote === "'") index += 1;
  while (isSpace(text.charAt(index))) index += 1;
  if (text.charAt(index) !== '=' || text.charAt(index + 1) !== '>') return -1;
  index += 2;
  while (isSpace(text.charAt(index))) index += 1;
  return index;
}

/**
 * The span a pair after `=>` replaces. It starts at the arrow, not at the value: the rules read
 * `'password' => 'x'` as `password` = `>`, so leaving `=> [redacted]` would let the first rule
 * keep replacing that `>` and grow the text on every round. Removing the arrow costs a little
 * formatting and keeps the pass idempotent.
 */
function arrowValueSpan(text: string, valueStart: number): ValueSpan | null {
  let start = valueStart;
  let index = start - 1;
  let budget = MAX_SHAPE_KEY_CHARS;
  while (index >= 0 && isSpace(text.charAt(index)) && budget > 0) {
    index -= 1;
    budget -= 1;
  }
  if (text.charAt(index) === '>') index -= 1;
  if (text.charAt(index) === '=') start = index;
  const unicode = unicodeValueSpan(text, valueStart);
  if (unicode) return { start, end: unicode.end };
  let end = pairValueEnd(text, valueStart);
  if (end < 0) return null;
  // A bare value that ends at a quote (`inner="x"`) is a nested pair's key; extend through its
  // value so this pre-pass cannot leave that value behind.
  if ((text.charAt(end) === '"' || text.charAt(end) === "'") && /[:=]$/.test(text.slice(valueStart, end))) {
    const inner = pairValueEnd(text, end);
    if (inner > end) end = inner;
  }
  return { start, end };
}

function redactArrowPairs(text: string): string {
  if (!text.includes('=>')) return text;
  return redactPairValues(text, arrowSeparatorEnd, arrowValueSpan);
}

/**
 * The passes that must see a shape before the rules do, because they consume a delimiter the rules
 * would otherwise take (`[`, a Unicode opening quote, `>`, `-----BEGIN`, an inner `=`). Each one
 * replaces a whole delimited span, so it cannot leave a nested pair's value behind.
 */
function redactIntactValueShapes(text: string): string {
  let out = redactStructuredValues(text);
  out = redactUnicodeQuotedValues(out);
  out = redactArrowPairs(out);
  return out;
}

/**
 * The passes that run on the rules' output: their shapes survive the rules intact, so they must not
 * run before them (a pre-pass value can end at a nested key and hide its value). Each reads the
 * text once.
 */
function redactSettledValueShapes(text: string): string {
  const out = redactShortSchemeValues(text);
  return out;
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
