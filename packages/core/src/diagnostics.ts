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
  // The #937 passes do not run before the pipeline: they read its output only, so nothing they do
  // can hide a value a released rule or pass would have removed.
  let out = applyRules(redactLongKeyValues(text));
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
 * The value shapes #937 collects, as additive passes on the OUTPUT of the complete released
 * pipeline (the 0.14.20 rules plus the 0.14.23/0.14.24 passes). Nothing here runs before them: each
 * pass only replaces more of what the pipeline left behind, so it can never hide a value a released
 * pass would have removed. Each pass reads the text once.
 */
const MAX_SHAPE_KEY_CHARS = 256;

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
 * Replaces each credential pair's value span with `replacement` (normally the marker; a marker
 * remainder is removed instead). A candidate may start only where the previous one ended, so each
 * suffix is read once, like a global regex's scan.
 */
function redactPairValues(
  text: string,
  separator: (text: string, nameEnd: number) => number,
  valueSpan: (text: string, valueStart: number) => ValueSpan | null,
  accept: (name: string) => boolean = isShapesCredentialKey,
  replacement = '[redacted]',
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
    if (name.length > MAX_SHAPE_KEY_CHARS || !accept(name)) {
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
    out += text.slice(copied, span.start) + replacement;
    copied = span.end;
    index = Math.max(span.end, nameEnd);
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/** The end of the line a value started on. */
function lineEnd(text: string, start: number): number {
  const newline = text.indexOf('\n', start);
  return newline < 0 ? text.length : newline;
}

const isWordChar = (char: string): boolean =>
  (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char === '_';

/**
 * The first position in [from, to) that another pass needs as an anchor: a credential key followed
 * by `:`/`=` or an Authorization scheme word. A remainder pass must not consume one, because the
 * key's value (or the scheme's token) would then never be redacted. The scan covers the WHOLE span
 * the caller asks about, so a long run cannot hide an anchor past a fixed lookahead.
 */
function shapeAnchor(text: string, from: number, to: number): number {
  const limit = Math.min(text.length, to);
  let index = from;
  while (index < limit) {
    const char = text.charAt(index);
    if ((char === 'b' || char === 'B') && (index === 0 || !isWordChar(text.charAt(index - 1)))) {
      const word = text.slice(index, Math.min(limit, index + 7)).toLowerCase();
      if (word.startsWith('bearer') && isSpace(text.charAt(index + 6))) return index;
      if (word.startsWith('basic') && isSpace(text.charAt(index + 5))) return index;
    }
    if (!isShapeNameStart(char)) {
      index += 1;
      continue;
    }
    let nameEnd = index + 1;
    while (nameEnd < limit && isShapeNameChar(text.charAt(nameEnd))) nameEnd += 1;
    if (separatorEnd(text, nameEnd, false) >= 0) {
      const name = text.slice(index, nameEnd);
      if (name.length <= MAX_SHAPE_KEY_CHARS && isShapesCredentialKey(name)) return index;
    }
    index = nameEnd;
  }
  return -1;
}

const MARKER = '[redacted]';

/**
 * A short Authorization value under a key: `authToken=Bearer abc`, `password: Basic xyz`. The
 * scheme rule needs six characters, so a short token is left behind; the scheme word is kept and
 * only the token after it is replaced.
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

const ESCAPED_QUOTE = '\\"';

/**
 * JSON written inside a string, where every quote is escaped: `{\"password\":\"x\"}`. The rules do
 * not recognise the key because an escaped quote sits where the separator starts, so this reads
 * `\"name\"`, the colon and the `\"value\"` pair by hand. Only the value between the escaped quotes
 * is replaced; the rest of the text keeps its escapes.
 */
function redactEscapedJsonPairs(text: string): string {
  if (!text.includes(ESCAPED_QUOTE)) return text;
  let out = '';
  let copied = 0;
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf(ESCAPED_QUOTE, index);
    if (open < 0) break;
    const nameStart = open + ESCAPED_QUOTE.length;
    let nameEnd = nameStart;
    while (nameEnd < text.length && isRunChar(text.charAt(nameEnd))) nameEnd += 1;
    const name = text.slice(nameStart, nameEnd);
    if (
      name.length === 0 ||
      name.length > MAX_SHAPE_KEY_CHARS ||
      !isShapesCredentialKey(name) ||
      !text.startsWith(ESCAPED_QUOTE, nameEnd)
    ) {
      index = nameStart;
      continue;
    }
    let cursor = nameEnd + ESCAPED_QUOTE.length;
    while (isSpace(text.charAt(cursor))) cursor += 1;
    if (text.charAt(cursor) !== ':') {
      index = nameStart;
      continue;
    }
    cursor += 1;
    while (isSpace(text.charAt(cursor))) cursor += 1;
    if (!text.startsWith(ESCAPED_QUOTE, cursor)) {
      index = nameStart;
      continue;
    }
    const valueStart = cursor + ESCAPED_QUOTE.length;
    const close = text.indexOf(ESCAPED_QUOTE, valueStart);
    if (close < 0) {
      index = valueStart;
      continue;
    }
    const value = text.slice(valueStart, close);
    if (value === '[redacted]' || PLAIN_LITERAL.test(value)) {
      index = close + ESCAPED_QUOTE.length;
      continue;
    }
    out += `${text.slice(copied, valueStart)}[redacted]`;
    copied = close;
    index = close + ESCAPED_QUOTE.length;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/** The end of a name run that may carry percent-encoded characters, stopping at an encoded separator. */
function urlNameEnd(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const char = text.charAt(index);
    if (isShapeNameChar(char)) {
      index += 1;
      continue;
    }
    if (char === '%' && index + 2 < text.length) {
      const hex = text.slice(index + 1, index + 3).toLowerCase();
      if (hex === '3d' || hex === '3a') break;
      // Only an encoded NAME character continues the run; `%22` and the other delimiters end it.
      if (/^[0-9a-f]{2}$/.test(hex) && isShapeNameChar(String.fromCharCode(Number.parseInt(hex, 16)))) {
        index += 3;
        continue;
      }
    }
    break;
  }
  return index;
}

/** The name with its `%XX` sequences decoded, so only the matching sees the readable letters. */
function decodeUrlName(name: string): string {
  let out = '';
  for (let index = 0; index < name.length; index += 1) {
    const char = name.charAt(index);
    if (char === '%' && index + 2 < name.length && /^[0-9a-f]{2}$/i.test(name.slice(index + 1, index + 3))) {
      out += String.fromCharCode(Number.parseInt(name.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    out += char;
  }
  return out;
}

/** The next `%XX` at or after `from`, compared case-insensitively (`hex` is two digits), or -1. */
function indexOfEncoded(text: string, hex: string, from: number): number {
  let index = from;
  while (index + 2 < text.length) {
    if (text.charAt(index) === '%' && text.slice(index + 1, index + 3).toLowerCase() === hex) return index;
    index += 1;
  }
  return -1;
}

/** A bare URL-encoded value ends at an encoded or plain delimiter. */
function urlValueEnd(text: string, start: number): number {
  if (text.startsWith('[redacted]', start)) return start + '[redacted]'.length;
  let index = start;
  while (index < text.length) {
    const char = text.charAt(index);
    if (isSpace(char) || '&,;}]"\''.includes(char)) break;
    if (char === '%') {
      const hex = text.slice(index + 1, index + 3).toLowerCase();
      if (hex === '26' || hex === '3b' || hex === '2c' || hex === '7d' || hex === '5d' || hex === '22' || hex === '27') break;
      if (/^[0-9a-f]{2}$/.test(hex)) {
        index += 3;
        continue;
      }
    }
    index += 1;
  }
  return index > start ? index : -1;
}

/**
 * URL-encoded pairs: `password%3Dsecret`, `token%22%3A%22abc`, and `api%5Fkey=`, whose NAME is
 * encoded but whose separator is not. The name is decoded only to decide whether it is a
 * credential; the text keeps its encoding and only the value is replaced.
 */
function redactUrlEncodedPairs(text: string): string {
  if (!text.includes('%')) return text;
  let out = '';
  let copied = 0;
  let index = 0;
  while (index < text.length) {
    if (!isShapeNameStart(text.charAt(index))) {
      index += 1;
      continue;
    }
    const nameEnd = urlNameEnd(text, index);
    const name = decodeUrlName(text.slice(index, nameEnd));
    if (name.length > MAX_SHAPE_KEY_CHARS || !isShapesCredentialKey(name)) {
      index = nameEnd;
      continue;
    }
    const quoted = text.slice(nameEnd, nameEnd + 9).toLowerCase();
    const encoded = text.slice(nameEnd, nameEnd + 3).toLowerCase();
    let valueStart: number;
    let valueEnd: number;
    if (quoted === '%22%3a%22' || quoted === '%22%3d%22') {
      valueStart = nameEnd + 9;
      const close = indexOfEncoded(text, '22', valueStart);
      valueEnd = close < 0 ? lineEnd(text, valueStart) : close;
    } else if (encoded === '%3d' || encoded === '%3a') {
      valueStart = nameEnd + 3;
      valueEnd = urlValueEnd(text, valueStart);
    } else {
      valueStart = separatorEnd(text, nameEnd, true);
      valueEnd = valueStart < 0 ? -1 : pairValueEnd(text, valueStart);
    }
    if (valueStart < 0 || valueEnd <= valueStart) {
      index = Math.max(nameEnd, valueStart);
      continue;
    }
    const value = text.slice(valueStart, valueEnd);
    if (value === '[redacted]' || PLAIN_LITERAL.test(value)) {
      index = Math.max(valueEnd, nameEnd);
      continue;
    }
    out += `${text.slice(copied, valueStart)}[redacted]`;
    copied = valueEnd;
    index = Math.max(valueEnd, nameEnd);
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/**
 * `userPwd`, `dbPwd`, `dbPass`, `user_pass`: a `Pwd`/`Pass` ending the name after a camel boundary
 * or a separator. The rules do not know the abbreviation, so this pass carries its own classifier
 * (`isPwdPassKey`) and never widens the rules' one. A bare `pass` or `bypass` is an ordinary word
 * and is not matched.
 */
function redactPwdKeys(text: string): string {
  if (!/[a-z0-9](?:Pwd|Pass)/.test(text) && !/[_.-](?:pwd|pass)(?![A-Za-z0-9])/i.test(text)) return text;
  const span = (value: string, start: number): ValueSpan | null => {
    SCHEME_START.lastIndex = start;
    if (SCHEME_START.test(value)) return null;
    const end = pairValueEnd(value, start);
    return end < 0 ? null : { start, end };
  };
  return redactPairValues(text, (value, nameEnd) => separatorEnd(value, nameEnd, true), span, isPwdPassKey);
}

/**
 * The end of the run glued to a marker: quoted fragments with their escapes and the `:`/`,` between
 * them (`"v":"x"`, `"a","b"`), or one bare token (`shortpw`). It stops at whitespace, a closing
 * bracket and at field punctuation (`&`, `;`), so `?token=[redacted]&x=1` keeps its next field. It
 * reads the whole run in one scan, so a marker with many fragments reaches its fixed point in a
 * single call.
 */
function gluedRunEnd(text: string, start: number): number {
  let index = start;
  let afterQuote = false;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === '"' || char === "'") {
      const end = pairValueEnd(text, index);
      if (end < 0) break;
      index = end;
      afterQuote = true;
      continue;
    }
    if (afterQuote) {
      if (char !== ':' && char !== ',') break;
      let next = index + 1;
      while (text.charAt(next) === ' ') next += 1;
      const nextChar = text.charAt(next);
      if (nextChar !== '"' && nextChar !== "'") break;
      index = next;
      afterQuote = false;
      continue;
    }
    if (isSpace(char) || char === ']' || char === '}' || '&;=,:'.includes(char)) break;
    index += 1;
  }
  return index;
}

/**
 * A value the released pipeline replaced only in part, with the rest glued to the marker:
 * `token=[redacted]shortpw`, `{"token":[redacted]"shortpw"]}`, `{"secret":[redacted]"v":"x"}}`,
 * `SIGNINGKEY=[redacted]'x'`. The whole attached run is removed in one scan; it stops before a
 * credential key or scheme anchor, which a later pass still needs.
 */
function gluedMarkerSpan(text: string, valueStart: number): ValueSpan | null {
  if (!text.startsWith(MARKER, valueStart)) return null;
  const start = valueStart + MARKER.length;
  const char = text.charAt(start);
  if (char === '' || isSpace(char) || char === ']' || char === '}') return null;
  let end = gluedRunEnd(text, start);
  const anchor = shapeAnchor(text, start, end);
  if (anchor >= 0) end = anchor;
  return end > start ? { start, end } : null;
}

/** Whether a marker is immediately followed by something glued (`\` starts escaped JSON, not glue). */
function hasGluedMarker(text: string): boolean {
  let index = 0;
  for (;;) {
    const marker = text.indexOf(MARKER, index);
    if (marker < 0) return false;
    const char = text.charAt(marker + MARKER.length);
    if (char !== '' && char !== '\\' && !isSpace(char) && char !== ']' && char !== '}') return true;
    index = marker + 1;
  }
}

function redactMarkerGlue(text: string): string {
  if (!hasGluedMarker(text)) return text;
  return redactPairValues(text, (value, nameEnd) => separatorEnd(value, nameEnd, true), gluedMarkerSpan, isShapesCredentialKey, '');
}

/** Characters that close a typographic quote pair. */
const TYPOGRAPHIC_CLOSERS = new Set(['\u201d', '\u2019', '\u00bb', '\u201c', '\u203a']);

/**
 * The rest of a typographic-quoted value the rules left behind: `token: “short pw”` becomes
 * `token: [redacted] pw”` (the rules take only up to the first space). The text up to the LAST
 * closing quote on the line is removed in one scan, so one call reaches the fixed point. The scan
 * stops at the first anchor: one after a closer means the removal ends there (safe), and one
 * before any closer means there is nothing safe to remove.
 */
function typographicRemainderSpan(text: string, valueStart: number): ValueSpan | null {
  if (!text.startsWith(MARKER, valueStart)) return null;
  const start = valueStart + MARKER.length;
  let lastClose = -1;
  let index = start;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === '\n') break;
    if (TYPOGRAPHIC_CLOSERS.has(char)) {
      lastClose = index + 1;
      index += 1;
      continue;
    }
    if (isShapeNameStart(char)) {
      let nameEnd = index + 1;
      while (nameEnd < text.length && isShapeNameChar(text.charAt(nameEnd))) nameEnd += 1;
      if ((char === 'b' || char === 'B') && (index === 0 || !isWordChar(text.charAt(index - 1)))) {
        const word = text.slice(index, nameEnd).toLowerCase();
        if ((word === 'bearer' || word === 'basic') && isSpace(text.charAt(nameEnd))) {
          return lastClose > start ? { start, end: lastClose } : null;
        }
      }
      const name = text.slice(index, nameEnd);
      if (name.length <= MAX_SHAPE_KEY_CHARS && separatorEnd(text, nameEnd, false) >= 0 && isShapesCredentialKey(name)) {
        return lastClose > start ? { start, end: lastClose } : null;
      }
      index = nameEnd;
      continue;
    }
    index += 1;
  }
  return lastClose > start ? { start, end: lastClose } : null;
}

function redactTypographicRemainders(text: string): string {
  if (!/[\u201d\u2019\u00bb\u201c\u203a]/.test(text) || !text.includes(MARKER)) return text;
  return redactPairValues(
    text,
    (value, nameEnd) => separatorEnd(value, nameEnd, true),
    typographicRemainderSpan,
    isShapesCredentialKey,
    '',
  );
}

/**
 * The quoted value of a `=>` pair, which the first rule damages to `key =[redacted] 'x'` (it takes
 * the `>` as the value). Every quoted fragment after the marker on the same line is removed in one
 * scan. A bare value after `=>` is indistinguishable from prose after a redacted value, so it is
 * left as the released pipeline leaves it (documented in the tests and the pull request).
 */
function arrowRemainderSpan(text: string, valueStart: number): ValueSpan | null {
  if (!text.startsWith(MARKER, valueStart)) return null;
  const start = valueStart + MARKER.length;
  let index = start;
  let end = -1;
  for (;;) {
    let cursor = index;
    while (text.charAt(cursor) === ' ' || text.charAt(cursor) === '\t') cursor += 1;
    if (cursor === index) return end < 0 ? null : { start, end };
    const quote = text.charAt(cursor);
    if (quote !== '"' && quote !== "'") return end < 0 ? null : { start, end };
    const fragmentEnd = pairValueEnd(text, cursor);
    if (fragmentEnd < 0 || text.slice(cursor, fragmentEnd).includes('\n')) return end < 0 ? null : { start, end };
    end = fragmentEnd;
    index = fragmentEnd;
  }
}

function redactArrowRemainders(text: string): string {
  if (!/\[redacted\][ \t]+["']/.test(text)) return text;
  return redactPairValues(text, (value, nameEnd) => separatorEnd(value, nameEnd, true), arrowRemainderSpan, isShapesCredentialKey, '');
}

const PEM_BEGIN = '-----BEGIN ';
const PEM_END = '-----END ';
const PEM_DASHES = '-----';
const PEM_HEADER_LIMIT = 64;

/**
 * The end of a `[A-Z ]*PRIVATE KEY-----` header that starts just after `-----BEGIN `/`-----END `,
 * or -1. The name is bounded (64 characters) and only capitals and spaces are read, so a long run
 * of dashes or text cannot make the scan grow.
 */
function pemKeyHeaderEnd(text: string, afterPrefix: number): number {
  let index = afterPrefix;
  const limit = Math.min(text.length, afterPrefix + PEM_HEADER_LIMIT);
  while (index < limit) {
    const char = text.charAt(index);
    if ((char >= 'A' && char <= 'Z') || char === ' ') index += 1;
    else break;
  }
  if (!text.slice(afterPrefix, index).endsWith('PRIVATE KEY')) return -1;
  if (!text.startsWith(PEM_DASHES, index)) return -1;
  return index + PEM_DASHES.length;
}

/** The matching `-----END …-----` for a header that ended at `from`, or -1. */
function pemFooterEnd(text: string, from: number): number {
  let cursor = from;
  for (;;) {
    const close = text.indexOf(PEM_END, cursor);
    if (close < 0) return -1;
    const closeEnd = pemKeyHeaderEnd(text, close + PEM_END.length);
    if (closeEnd >= 0) return closeEnd;
    cursor = close + 1;
  }
}

/**
 * A PEM private key block the pipeline left: standalone, `-----BEGIN … PRIVATE KEY-----` through
 * its matching `-----END …-----` (an unterminated block runs to the end of the text); under a
 * credential key the first rule turned `-----BEGIN` into the marker, leaving
 * `password=[redacted] RSA PRIVATE KEY-----\n…`, which is removed from the marker when a footer is
 * found (without one it is left alone, because there is no end to bound it).
 */
function redactPemBlocks(text: string): string {
  if (!text.includes('PRIVATE KEY')) return text;
  let out = '';
  let copied = 0;
  let search = 0;
  while (search < text.length) {
    const begin = text.indexOf(PEM_BEGIN, search);
    const marker = text.indexOf(MARKER, search);
    const intact = begin >= 0 && (marker < 0 || begin < marker);
    if (!intact && marker < 0) break;
    if (intact) {
      const headerEnd = pemKeyHeaderEnd(text, begin + PEM_BEGIN.length);
      if (headerEnd < 0) {
        search = begin + 1;
        continue;
      }
      const footer = pemFooterEnd(text, headerEnd);
      const end = footer < 0 ? text.length : footer;
      out += `${text.slice(copied, begin)}[redacted]`;
      copied = end;
      search = end;
      continue;
    }
    const afterMarker = marker + MARKER.length;
    let cursor = afterMarker;
    while (text.charAt(cursor) === ' ') cursor += 1;
    const headerEnd = cursor === afterMarker ? -1 : pemKeyHeaderEnd(text, cursor);
    if (headerEnd < 0) {
      search = afterMarker;
      continue;
    }
    const footer = pemFooterEnd(text, headerEnd);
    // No footer after this one means none after any later marker either: stop, so a long run of
    // marker-headed headers is not rescanned for every marker.
    if (footer < 0) break;
    out += `${text.slice(copied, marker)}${MARKER}`;
    copied = footer;
    search = footer;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/**
 * Every #937 pass, on the released pipeline's output. Each reads the text once and only replaces
 * more of it.
 */
function redactSettledValueShapes(text: string): string {
  let out = redactShortSchemeValues(text);
  out = redactEscapedJsonPairs(out);
  out = redactUrlEncodedPairs(out);
  out = redactPwdKeys(out);
  out = redactPemBlocks(out);
  out = redactTypographicRemainders(out);
  out = redactArrowRemainders(out);
  out = redactMarkerGlue(out);
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
