// What a failure may say about itself (#885). An AppError message is written for a person and
// copied verbatim into the audit log and the agent ledger, so text that came from a provider, a
// driver or an exception must be reduced to a safe diagnostic before it is put there: a provider's
// own error code and message, never its body, and never a token the body or an exception echoes.
import { redactCredentials as releasedRedaction01425 } from './redaction-01425';

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
 * One replacement rule: the pattern, and the text its replacement keeps around the marker. Rule 1
 * keeps the key and the separator (`$1$2$3[redacted]`), the scheme rule writes `$1` and one space,
 * and the URL rule keeps its `@`; everything between is replaced by the marker. The kept text is
 * written by the rule itself, so every kept character keeps its own origin (#989 review).
 */
interface Rule {
  readonly pattern: RegExp;
  /**
   * Writes what the replacement keeps before the marker and returns how many match characters it
   * stands for: the marker's origin is then the value's first character.
   */
  readonly head?: (source: SpannedText, match: RegExpExecArray, start: number, builder: SpannedBuilder) => number;
  /** Writes what the replacement keeps after the marker and returns how many match characters it stands for. */
  readonly tail?: (source: SpannedText, match: RegExpExecArray, end: number, builder: SpannedBuilder) => number;
}

/**
 * Token-shaped values, in the order they must be applied: a named credential (`access_token=…`,
 * `"developer-token": "…"`), a provider's own prefix (`shpat_…`, `sk_live_…`, a JWT), an
 * Authorization value (`Bearer …`), then a bare long token (base64, base64url or hex), which is
 * what a gateway echoing a header leaves behind.
 */
const REDACTIONS: readonly Rule[] = [
  {
    // A quoted or bare value, unless it is an Authorization value (`Bearer <token>`, which the scheme
    // rule below redacts while keeping the scheme word). Only a scheme word followed by whitespace
    // counts: `Bearer-probe-secret` is a credential value, not a scheme (#885 round 3).
    pattern: new RegExp(
      `(${CREDENTIAL_KEY})(["']?)(\\s*[:=]\\s*)(?!(?:Bearer|Basic)\\s|\\[redacted\\]|(?:${COMPOUND_CREDENTIAL_KEY})\\s*[:=])("(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s,;&}\\]"']+)`,
      'gi',
    ),
    head: (_source, match, start, builder) => {
      const length = match[1]!.length + match[2]!.length + match[3]!.length;
      builder.copy(start, start + length);
      return length;
    },
  },
  // The prefixes Shopify, Stripe, Slack, GitHub, AWS, Google and JWT issuers use.
  { pattern: /\b(?:shpat_|shpss_|shpca_|sk_live_|sk_test_|rk_|xox[abposr]-|ghp_|gho_|github_pat_|ya29\.)[A-Za-z0-9._-]{4,}/gi },
  { pattern: /\bAKIA[A-Z0-9]{16}\b/g },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{4,}){0,2}/g },
  // The scheme word and one space: the whitespace after it (`\s+`, a newline included) is part of
  // what the rule replaces, exactly as the released `$1 [redacted]` does.
  {
    pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi,
    head: (_source, match, start, builder) => {
      const length = match[1]!.length;
      builder.copy(start, start + length);
      builder.insert(' ', start + length);
      return length;
    },
  },
  // 24+ characters with no separators: a token, not a word, an id or a number. Our own external
  // ids are one exception, so a message may still name the artifact it is about; a provider's error
  // code in capitals and underscores (`INVALID_AUTHENTICATION_CREDENTIALS`) is the other: letters
  // only, in two or more words, which no generated token looks like (#885 round 3).
  { pattern: new RegExp(`(?<![A-Za-z0-9_])(?!(?:${ID_LIKE}|[A-Z]+(?:_[A-Z]+)+)(?![A-Za-z0-9+/=_-]))[A-Za-z0-9+/_-]{24,}={0,2}`, 'g') },
];

const MARKER = '[redacted]';

/**
 * A text, and where each of its characters came from (#989). `origins[k]` is the offset, in the
 * input of `redactCredentials`, of the character at `text[k]`. A pass that copies text keeps every
 * character's own offset; a pass that replaces a value writes the marker with the origin of the
 * value's first character. `sound` says those offsets are non-decreasing, which is what makes an
 * original span map to an output range with one bound search: a pass that ever broke it sets it to
 * false and the shape passes then stand down.
 */
interface SpannedText {
  readonly text: string;
  readonly origins: Int32Array;
  readonly sound: boolean;
}

/** The input text: every character is its own origin. */
function unspanned(text: string): SpannedText {
  const origins = new Int32Array(text.length);
  for (let index = 0; index < text.length; index += 1) origins[index] = index;
  return { text, origins, sound: true };
}

/** A copied range of the source text, or text a pass inserted at a position of the source. */
interface Piece {
  readonly from: number;
  readonly to: number;
  readonly insert?: string;
}

/**
 * Builds the next pass's text and its origins in one go. A pass states only what it copies and
 * what it replaces, so its output can never drift from the released pass's slices. An insertion
 * names a position of the text the pass is reading, and its origin is that position's own origin:
 * the caller never has to translate an offset into the original text itself (#989 review).
 */
class SpannedBuilder {
  private readonly pieces: Piece[] = [];
  private size = 0;

  copy(from: number, to: number): void {
    if (to <= from) return;
    this.pieces.push({ from, to });
    this.size += to - from;
  }

  insert(text: string, at: number): void {
    if (text.length === 0) return;
    this.pieces.push({ from: at, to: at, insert: text });
    this.size += text.length;
  }

  build(source: SpannedText): SpannedText {
    const parts: string[] = new Array<string>(this.pieces.length);
    const origins = new Int32Array(this.size);
    const last = source.origins.length - 1;
    let at = 0;
    for (let index = 0; index < this.pieces.length; index += 1) {
      const piece = this.pieces[index]!;
      if (piece.insert === undefined) {
        parts[index] = source.text.slice(piece.from, piece.to);
        origins.set(source.origins.subarray(piece.from, piece.to), at);
        at += piece.to - piece.from;
      } else {
        parts[index] = piece.insert;
        // The insertion sits at a position of the source text: its origin is that character's.
        const origin = last < 0 ? 0 : source.origins[Math.min(piece.from, last)]!;
        origins.fill(origin, at, at + piece.insert.length);
        at += piece.insert.length;
      }
    }
    return { text: parts.join(''), origins, sound: source.sound && isMonotone(origins) };
  }
}

/** Whether `origins` never decreases, which the span mapping relies on. */
function isMonotone(origins: Int32Array): boolean {
  for (let index = 1; index < origins.length; index += 1) {
    if (origins[index]! < origins[index - 1]!) return false;
  }
  return true;
}

/**
 * How often the span-recording pipeline was distrusted and the frozen release's own output returned
 * instead (#989 review). No content is recorded; a non-zero count is a bug, and the differential
 * keeps it at zero.
 */
export const redactionFallbacks = { count: 0 };

/**
 * The released pipeline: the rules and every pass 0.14.25 shipped, on the whole original text, with
 * the original offset of every character it keeps.
 */
function redactReleasedPipeline(text: string): SpannedText {
  // A long camelCase credential key is replaced as a token by the rules below, after which its
  // value can no longer be told from any other text. So the plain value of such a key is replaced
  // first (#898); see redactLongKeyValues for why that cannot change what the rules below remove.
  // The #937 passes do not run before the pipeline: they read its output only, so nothing they do
  // can hide a value a released rule or pass would have removed.
  let out = applyRules(redactLongKeyValues(unspanned(text)));
  // Main's 0.14.23 passes converge first, on exactly the release's rules and qualifiers. Only then
  // do the #946/#956 additions run, so they can add redaction but can never consume a key main's
  // next round would have needed. If an addition exposes a new main match, main settles again.
  out = settleMain(out);
  for (let round = 0; round < 16; round += 1) {
    // The #937 passes that survive the rules run on the output of everything above, then main
    // settles again so an addition that exposes a main match is still handled.
    const shaped = redactSettledValueShapes(settleAdded(out));
    if (shaped.text === out.text) break;
    out = settleMain(shaped);
  }
  return out;
}

/**
 * The released pipeline's own output, byte-identical to 0.14.25: the rules, the passes of 0.14.23
 * and the value shapes of 0.14.25, without the #989 shapes on top. The differential compares it with
 * the vendored reference over every generated case, so the span bookkeeping the #989 shapes need
 * can never change what a released pass removes.
 */
export function releasedRedaction(text: string): string {
  return redactReleasedPipeline(text).text;
}

/**
 * The instrumented pipeline with its origins, for the tests that check the bookkeeping itself
 * (#989 review): every pass must leave the offsets monotone and each one pointing into the text the
 * caller gave.
 */
export function releasedRedactionWithOrigins(text: string): SpannedText {
  return redactReleasedPipeline(text);
}

/**
 * Whether the text can hold one of the #989 shapes at all: one cheap scan, and the only work a
 * message that names no shape pays. A scheme word only counts when a value can follow it.
 */
const TYPOGRAPHIC_START = '[\u201c\u2018\u00ab\u201e\u2039]';
const AUTH_SCHEME_WORDS =
  'bearer|basic|digest|token|negotiate|ntlm|hoba|mutual|oauth|hawk|apikey|aws4-hmac-sha256|scram-sha-1|scram-sha-256|vapid';
const MAY_HOLD_SHAPE = new RegExp(`PRIVATE KEY|=>|${TYPOGRAPHIC_START}|(?:${AUTH_SCHEME_WORDS})\\s`, 'i');

/**
 * Removes token-shaped values from free text: an exception's message, a provider's answer, a log
 * line that is about to become an AppError.
 *
 * The release's own function produces the output first. The shapes are read from the original text
 * (a linear scan, and nothing else for a message without one); only when a shape is actually there
 * is the instrumented pipeline run as well, and then the two base outputs must agree byte for byte:
 * a lost character, or an origin that stopped being monotone, means the span bookkeeping is not
 * trustworthy, and the release's output is returned with nothing added. Nothing new ever runs before
 * the release, and nothing here can remove less than it.
 */
export function redactCredentials(text: string): string {
  const released = releasedRedaction01425(text);
  const regions = originalShapeRegions(text);
  if (regions.length === 0) return released;
  const spans = redactReleasedPipeline(text);
  if (!spans.sound || spans.text !== released) {
    redactionFallbacks.count += 1;
    return released;
  }
  const shaped = applyRegions(spans, regions);
  if (shaped === spans.text) return shaped;
  // The replacement can leave the marker beside text the released passes had no reason to touch
  // (`token => 'x'y`). The release's own pass on the result reaches the fixed point, so a second
  // call to this function changes nothing.
  return releasedRedaction01425(shaped);
}

/** The #946/#956 additions, then the rules again, until nothing changes. */
function settleMain(input: SpannedText): SpannedText {
  let current = input;
  for (let round = 0; round < 16; round += 1) {
    const next = applyRules(redactCompoundKeys(redactUrlPasswords(current)));
    if (next.text === current.text) break;
    current = next;
  }
  return current;
}

/** Main's passes, then the additions of #946/#956, until nothing changes. */
function settleAdded(input: SpannedText): SpannedText {
  let current = input;
  for (let round = 0; round < 16; round += 1) {
    const next = applyRules(redactJoinedCompoundKeys(redactPrefixedCompoundKeys(current)));
    if (next.text === current.text) break;
    current = next;
  }
  return current;
}

/** Every rule, in order, each one pass over the text. */
function applyRules(source: SpannedText): SpannedText {
  let out = source;
  for (const rule of REDACTIONS) out = applyRule(out, rule);
  return out;
}

/**
 * One global replacement, read with an `exec` loop so the match offsets are known: everything
 * between matches is copied, the rule writes the match's own kept text, and the marker takes the
 * place of the value in between. The result is byte-identical to the released `$1$2$3[redacted]`
 * replacement.
 */
function applyRule(source: SpannedText, rule: Rule): SpannedText {
  const text = source.text;
  const pattern = rule.pattern;
  pattern.lastIndex = 0;
  const builder = new SpannedBuilder();
  let copied = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const start = match.index;
    const end = start + match[0].length;
    if (end === start) {
      // No rule matches an empty string; the guard keeps a future one from looping here.
      pattern.lastIndex += 1;
      continue;
    }
    builder.copy(copied, start);
    const head = rule.head ? rule.head(source, match, start, builder) : 0;
    builder.insert(MARKER, Math.min(start + head, end));
    if (rule.tail) rule.tail(source, match, end, builder);
    copied = end;
  }
  if (copied === 0) return source;
  builder.copy(copied, text.length);
  return builder.build(source);
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
function redactLongKeyValues(source: SpannedText): SpannedText {
  const text = source.text;
  const builder = new SpannedBuilder();
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
    builder.copy(copied, start + inset);
    builder.insert(MARKER, start + inset);
    copied = start + value.length - inset;
    COMPOUND_KEY.lastIndex = copied;
  }
  if (copied === 0) return source;
  builder.copy(copied, text.length);
  return builder.build(source);
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
function redactCompoundKeys(source: SpannedText): SpannedText {
  const text = source.text;
  const builder = new SpannedBuilder();
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
    builder.copy(copied, start);
    builder.insert(MARKER, start);
    copied = start + value[0].length;
  }
  if (copied === 0) return source;
  builder.copy(copied, text.length);
  return builder.build(source);
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
function redactCompoundRuns(source: SpannedText, candidateStart: CandidateStart, accept: (name: string) => boolean): SpannedText {
  const text = source.text;
  const builder = new SpannedBuilder();
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
    builder.copy(copied, start);
    builder.insert(MARKER, start);
    copied = valueEnd;
    index = valueEnd;
  }
  if (copied === 0) return source;
  builder.copy(copied, text.length);
  return builder.build(source);
}

function redactPrefixedCompoundKeys(source: SpannedText): SpannedText {
  if (!/[_.$-][A-Za-z]/.test(source.text)) return source;
  return redactCompoundRuns(source, prefixedStart, (name) => isCompoundCredentialKey(name) || isAddedProviderKey(name));
}

function redactJoinedCompoundKeys(source: SpannedText): SpannedText {
  if (!/[A-Z]/.test(source.text)) return source;
  return redactCompoundRuns(source, joinedStart, isAddedProviderKey);
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
  source: SpannedText,
  separator: (text: string, nameEnd: number) => number,
  valueSpan: (text: string, valueStart: number) => ValueSpan | null,
  accept: (name: string) => boolean = isShapesCredentialKey,
  replacement = MARKER,
): SpannedText {
  const text = source.text;
  const builder = new SpannedBuilder();
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
    if (value === MARKER || PLAIN_LITERAL.test(value)) {
      index = nameEnd;
      continue;
    }
    builder.copy(copied, span.start);
    builder.insert(replacement, span.start);
    copied = span.end;
    index = Math.max(span.end, nameEnd);
  }
  if (copied === 0) return source;
  builder.copy(copied, text.length);
  return builder.build(source);
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

function redactShortSchemeValues(source: SpannedText): SpannedText {
  if (!/bearer|basic/i.test(source.text)) return source;
  return redactPairValues(source, (value, nameEnd) => separatorEnd(value, nameEnd, true), schemeValueSpan);
}

const ESCAPED_QUOTE = '\\"';

/**
 * JSON written inside a string, where every quote is escaped: `{\"password\":\"x\"}`. The rules do
 * not recognise the key because an escaped quote sits where the separator starts, so this reads
 * `\"name\"`, the colon and the `\"value\"` pair by hand. Only the value between the escaped quotes
 * is replaced; the rest of the text keeps its escapes.
 */
function redactEscapedJsonPairs(source: SpannedText): SpannedText {
  const text = source.text;
  if (!text.includes(ESCAPED_QUOTE)) return source;
  const builder = new SpannedBuilder();
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
    if (value === MARKER || PLAIN_LITERAL.test(value)) {
      index = close + ESCAPED_QUOTE.length;
      continue;
    }
    builder.copy(copied, valueStart);
    builder.insert(MARKER, valueStart);
    copied = close;
    index = close + ESCAPED_QUOTE.length;
  }
  if (copied === 0) return source;
  builder.copy(copied, text.length);
  return builder.build(source);
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
function redactUrlEncodedPairs(source: SpannedText): SpannedText {
  const text = source.text;
  if (!text.includes('%')) return source;
  const builder = new SpannedBuilder();
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
    if (value === MARKER || PLAIN_LITERAL.test(value)) {
      index = Math.max(valueEnd, nameEnd);
      continue;
    }
    builder.copy(copied, valueStart);
    builder.insert(MARKER, valueStart);
    copied = valueEnd;
    index = Math.max(valueEnd, nameEnd);
  }
  if (copied === 0) return source;
  builder.copy(copied, text.length);
  return builder.build(source);
}

/**
 * `userPwd`, `dbPwd`, `dbPass`, `user_pass`: a `Pwd`/`Pass` ending the name after a camel boundary
 * or a separator. The rules do not know the abbreviation, so this pass carries its own classifier
 * (`isPwdPassKey`) and never widens the rules' one. A bare `pass` or `bypass` is an ordinary word
 * and is not matched.
 */
function redactPwdKeys(source: SpannedText): SpannedText {
  const text = source.text;
  if (!/[a-z0-9](?:Pwd|Pass)/.test(text) && !/[_.-](?:pwd|pass)(?![A-Za-z0-9])/i.test(text)) return source;
  const span = (value: string, start: number): ValueSpan | null => {
    SCHEME_START.lastIndex = start;
    if (SCHEME_START.test(value)) return null;
    const end = pairValueEnd(value, start);
    return end < 0 ? null : { start, end };
  };
  return redactPairValues(source, (value, nameEnd) => separatorEnd(value, nameEnd, true), span, isPwdPassKey);
}

/**
 * The end of the run ATTACHED to a marker: quoted fragments with their escapes and the `:`/`,`
 * directly between them (`"v":"x"`, `"a","b"`), or one bare token (`shortpw`). It stops at
 * whitespace (so `[redacted] "status":"ok"` is not glue), a closing bracket and at field
 * punctuation (`&`, `;`), so `?token=[redacted]&x=1` keeps its next field. It reads the whole run in
 * one scan, so a marker with many fragments reaches its fixed point in a single call.
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
      const next = text.charAt(index + 1);
      if (next !== '"' && next !== "'") break;
      index += 1;
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
 * `SIGNINGKEY=[redacted]'x'`. Only the attached run is removed, in one scan; it stops before a
 * credential key or scheme anchor, which a later pass still needs.
 *
 * The whole attached run goes, as the release does it (#989 review): attachment alone cannot tell a
 * credential remainder from an appended field, and `password=[redacted]"hunter2":"x"` proves the
 * run is not safe to keep.
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

function redactMarkerGlue(source: SpannedText): SpannedText {
  if (!hasGluedMarker(source.text)) return source;
  return redactPairValues(source, (value, nameEnd) => separatorEnd(value, nameEnd, true), gluedMarkerSpan, isShapesCredentialKey, '');
}

/**
 * Every #937 pass, on the released pipeline's output. Each reads the text once, reaches its fixed
 * point in that one call, and only replaces more of what the pipeline left. The typographic-quote,
 * `=>` and PEM shapes are not here: the pipeline's output has lost the evidence they need, so they
 * run afterwards from the original text (#989).
 */
function redactSettledValueShapes(source: SpannedText): SpannedText {
  let out = redactShortSchemeValues(source);
  out = redactEscapedJsonPairs(out);
  out = redactUrlEncodedPairs(out);
  out = redactPwdKeys(out);
  out = redactMarkerGlue(out);
  return out;
}

/**
 * The password in `scheme://user:password@host` (#920), for any scheme: a connection string a
 * driver or a client echoes. The authority ends at the first `/`, `?`, `#` or whitespace, and its
 * LAST `@` ends the userinfo, so a password that contains `@` is replaced whole. A URL without a
 * password (`https://user@host`, `mailto:a@b.c`, `https://host/path?x=a:b@c`) is left alone.
 */
const URL_PASSWORD: Rule = {
  pattern: /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/?#@:]*):[^\s/?#]*@/g,
  /** The scheme and userinfo and the `:` before the password, copied with their own origins. */
  head: (_source, match, start, builder) => {
    const length = match[1]!.length + 1;
    builder.copy(start, start + length);
    return length;
  },
  /** The `@` that closes the userinfo, which is the match's last character. */
  tail: (_source, _match, end, builder) => {
    builder.copy(end - 1, end);
    return 1;
  },
};

function redactUrlPasswords(source: SpannedText): SpannedText {
  return applyRule(source, URL_PASSWORD);
}

/**
 * #989: the value shapes whose evidence only the original text keeps. A PEM block's header is gone
 * from the pipeline's output, a typographic quote loses its opening half and an arrow its `>`, so
 * each of these is found in the original text and carried into the released output through the
 * recorded origins. Nothing here runs before the released pipeline, and every region replaces a
 * value the released pipeline left in part or whole: the output is always the released output with
 * more removed, never less.
 */

/** A span of the original text whose content is a credential value. */
interface Region {
  readonly start: number;
  readonly end: number;
}

/** The start of the line after the one `index` is on. */
function nextLineStart(text: string, index: number): number {
  const newline = text.indexOf('\n', index);
  return newline < 0 ? text.length : newline + 1;
}

/** Whether the rest of the line at `index` is only blanks (`\r` of a CRLF included). */
function lineRestIsBlank(text: string, index: number): boolean {
  let cursor = index;
  while (cursor < text.length && text.charAt(cursor) !== '\n') {
    const char = text.charAt(cursor);
    if (char !== ' ' && char !== '\t' && char !== '\r') return false;
    cursor += 1;
  }
  return true;
}

const PEM_BEGIN = '-----BEGIN ';
const PEM_END = '-----END ';
const PEM_DASHES = '-----';
/** A PEM label is a handful of capitals; the bound keeps a long run of them from being scanned. */
const PEM_LABEL_LIMIT = 64;

interface PemHeader {
  readonly label: string;
  /** Just after the closing `-----`. */
  readonly end: number;
}

/**
 * A PEM header at `index`, or null: `-----BEGIN <LABEL>-----` where the label ends in
 * `PRIVATE KEY` (or `PRIVATE KEY BLOCK`), so a certificate and a public key are not a secret. The
 * label is bounded and only capitals and spaces are read, so a run of dashes cannot make this grow.
 */
function pemHeaderAt(text: string, index: number): PemHeader | null {
  if (!text.startsWith(PEM_BEGIN, index)) return null;
  const labelStart = index + PEM_BEGIN.length;
  let labelEnd = labelStart;
  const limit = Math.min(text.length, labelStart + PEM_LABEL_LIMIT);
  while (labelEnd < limit) {
    const code = text.charCodeAt(labelEnd);
    if ((code >= 65 && code <= 90) || code === 32) labelEnd += 1;
    else break;
  }
  const label = text.slice(labelStart, labelEnd);
  if (!label.endsWith('PRIVATE KEY') && !label.endsWith('PRIVATE KEY BLOCK')) return null;
  if (!text.startsWith(PEM_DASHES, labelEnd)) return null;
  return { label, end: labelEnd + PEM_DASHES.length };
}

/** The end of `-----END <label>-----` at the start of the line at `lineStart`, or -1. */
function pemFooterEnd(text: string, lineStart: number, label: string): number {
  if (!text.startsWith(PEM_END, lineStart)) return -1;
  const labelStart = lineStart + PEM_END.length;
  if (!text.startsWith(label, labelStart)) return -1;
  const after = labelStart + label.length;
  if (!text.startsWith(PEM_DASHES, after)) return -1;
  const end = after + PEM_DASHES.length;
  return lineRestIsBlank(text, end) ? end : -1;
}

/** A PEM body line: base64 characters only, or an empty line (a CRLF's `\r` allowed). */
function isPemBodyLine(text: string, start: number): boolean {
  let index = start;
  while (index < text.length && text.charAt(index) !== '\n') {
    const code = text.charCodeAt(index);
    const base64 =
      (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47 || code === 61;
    if (!base64 && code !== 13) return false;
    index += 1;
  }
  return true;
}

/** How many RFC 1421 preamble lines an encrypted block may carry before its base64 body. */
const PEM_PREAMBLE_LIMIT = 4;
/** How much of one preamble line is read; a real one is short (`DEK-Info: AES-256-CBC,<32 hex>`). */
const PEM_PREAMBLE_LINE_LIMIT = 128;

/**
 * An RFC 1421 preamble line of an encrypted block: `Proc-Type: 4,ENCRYPTED` or
 * `DEK-Info: AES-256-CBC,0123…`, read case-insensitively and bounded, so the key material after
 * them is still inside the block (#989 review). The WHOLE line must fit the bound and use the
 * closed character set: a long line that merely starts like a header is prose, not a preamble, and
 * stays outside the block.
 */
function isPemPreambleLine(text: string, start: number): boolean {
  const end = lineEnd(text, start);
  if (end - start > PEM_PREAMBLE_LINE_LIMIT) return false;
  const line = text.slice(start, end).toLowerCase();
  const prefix = line.startsWith('proc-type:') ? 10 : line.startsWith('dek-info:') ? 9 : 0;
  if (prefix === 0) return false;
  for (let index = prefix; index < line.length; index += 1) {
    const code = line.charCodeAt(index);
    const value =
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 32 ||
      code === 44 ||
      code === 45 ||
      code === 47 ||
      code === 43 ||
      code === 61 ||
      code === 13;
    if (!value) return false;
  }
  return true;
}

/**
 * Where the block whose header ends at `headerEnd` ends: the end of its footer line, whose label
 * must match the header's exactly, or -- with no footer -- the end of its last body line, so a
 * truncated dump never runs past text that is not key material. An encrypted block's RFC 1421
 * preamble (`Proc-Type`, `DEK-Info`, a blank line) is part of the block (#989 review).
 *
 * Only this block's own lines are read (the scan stops at the first line that is neither a matching
 * footer, a preamble line nor a body line), so a text of many headers without footers is read once.
 */
function pemBlockEnd(text: string, headerEnd: number, label: string): number {
  let end = headerEnd;
  let lineStart = nextLineStart(text, headerEnd);
  let preambles = 0;
  while (lineStart < text.length) {
    const footer = pemFooterEnd(text, lineStart, label);
    if (footer >= 0) return footer;
    if (preambles < PEM_PREAMBLE_LIMIT && isPemPreambleLine(text, lineStart)) {
      preambles += 1;
    } else if (!isPemBodyLine(text, lineStart)) {
      return end;
    }
    end = lineEnd(text, lineStart);
    lineStart = nextLineStart(text, end);
  }
  return end;
}

/** A standalone PEM private-key block: a header that starts its line and its matching footer. */
function pemRegions(text: string, regions: Region[]): void {
  if (!text.includes(PEM_BEGIN)) return;
  let lineStart = 0;
  while (lineStart < text.length) {
    if (text.startsWith(PEM_BEGIN, lineStart)) {
      const header = pemHeaderAt(text, lineStart);
      if (header && lineRestIsBlank(text, header.end)) {
        const end = pemBlockEnd(text, header.end, header.label);
        regions.push({ start: lineStart, end });
        lineStart = nextLineStart(text, Math.max(end, header.end));
        continue;
      }
    }
    lineStart = nextLineStart(text, lineStart);
  }
}

/**
 * A PEM block whose header follows a credential key (`password=-----BEGIN RSA PRIVATE KEY-----…`):
 * there the released rule took `-----BEGIN` as the value and could not see the block. The header is
 * found in the original, so its label and footer bound the region the same way.
 */
function keyedPemValueSpan(text: string, valueStart: number): ValueSpan | null {
  const header = pemHeaderAt(text, valueStart);
  if (!header || !lineRestIsBlank(text, header.end)) return null;
  return { start: valueStart, end: pemBlockEnd(text, header.end, header.label) };
}

/** Opening typographic quotes and the character that closes each. */
const TYPOGRAPHIC_CLOSERS: ReadonlyMap<string, string> = new Map([
  ['\u201c', '\u201d'],
  ['\u2018', '\u2019'],
  ['\u00ab', '\u00bb'],
  ['\u201e', '\u201c'],
  ['\u2039', '\u203a'],
]);

/**
 * A value in typographic quotes: `token: “short pw”`. The rules read only up to the first space
 * (`“short`), which leaves the rest of the value; this takes the pair, and only the pair -- the
 * matching closer of the same pair on the same line. An unclosed quote ends at its line, so a value
 * broken across lines never survives and the next line stays readable. The scan reads the value
 * once: it stops at the closer or the line end, whichever comes first.
 */
function typographicValueSpan(text: string, start: number): ValueSpan | null {
  const close = TYPOGRAPHIC_CLOSERS.get(text.charAt(start));
  if (close === undefined) return null;
  let index = start + 1;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === close) return { start, end: index + 1 };
    if (char === '\n') return { start, end: index };
    index += 1;
  }
  return { start, end: text.length };
}

/** Where the `=>` separator that follows a name at `nameEnd` ends, or -1. */
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

/** A scheme name is a bounded word; anything longer is a token, not a scheme. */
const AUTH_SCHEME_LIMIT = 24;

/**
 * Authorization schemes whose value is one token. `bearer` and `basic` keep their released shape
 * after a key -- the short-scheme pass of 0.14.25 redacts the token and keeps the word -- while every
 * other scheme is only visible through the original text (#989 review).
 */
const AUTH_SCHEMES: ReadonlySet<string> = new Set([
  'digest',
  'token',
  'negotiate',
  'ntlm',
  'hoba',
  'mutual',
  'oauth',
  'hawk',
  'apikey',
  'aws4-hmac-sha256',
  'scram-sha-1',
  'scram-sha-256',
  'vapid',
]);
/** Behind an arrow the scheme word is part of the value: the released rule may have eaten it. */
const ARROW_SCHEMES: ReadonlySet<string> = new Set([...AUTH_SCHEMES, 'bearer', 'basic']);

/** The end of the scheme word at `start` (letters, digits and `-`, bounded), or `start`. */
function schemeWordEnd(text: string, start: number): number {
  const limit = Math.min(text.length, start + AUTH_SCHEME_LIMIT);
  let index = start;
  while (index < limit) {
    const code = text.charCodeAt(index);
    const word = (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57) || code === 45;
    if (!word) break;
    index += 1;
  }
  return index;
}

/**
 * The end of an authorization value at `start` (`Bearer abc`), or -1. The released rules keep a
 * scheme word and redact the token behind it, but a value behind an arrow stops at the space after
 * the scheme -- and `token=>Bearer abc` even loses the word to the rule -- so the token would stay.
 * Reads repeated scheme words (bounded) and the single token behind them; every character it reads
 * belongs to the value it covers, so it stays linear (#989 review).
 */
function schemeValueEnd(text: string, start: number, schemes: ReadonlySet<string>, least = 1): number {
  let index = start;
  let found = 0;
  for (;;) {
    const wordEnd = schemeWordEnd(text, index);
    if (wordEnd === index || !schemes.has(text.slice(index, wordEnd).toLowerCase())) break;
    if (!isSpace(text.charAt(wordEnd))) break;
    let next = wordEnd;
    while (isSpace(text.charAt(next))) next += 1;
    if (next >= text.length) break;
    found += 1;
    index = next;
  }
  if (found < least) return -1;
  return pairValueEnd(text, index);
}

/**
 * A value behind a credential key that starts with a scheme the released pass leaves in part: any
 * scheme other than `bearer`/`basic` (`token: Digest abc`), or a chain of them, which the released
 * scheme rule mangles by taking the second word as the token (`token: Bearer Bearer abc` leaves
 * `abc`). A single `bearer`/`basic` word keeps the released shape.
 */
function keyedSchemeValueSpan(text: string, valueStart: number): ValueSpan | null {
  const other = schemeValueEnd(text, valueStart, AUTH_SCHEMES);
  if (other >= 0) return { start: valueStart, end: other };
  const chain = schemeValueEnd(text, valueStart, ARROW_SCHEMES, 2);
  return chain < 0 ? null : { start: valueStart, end: chain };
}

/**
 * The span an `=>` pair replaces: from the `>` through the end of its value. The released rule reads
 * the `>` as the value (`'password' =[redacted] 'x'`), so starting at the arrow also replaces the
 * marker it left; the value itself is the quoted string, an authorization value (`Bearer abc`:
 * scheme word and token together) or the bare run after the arrow, and every quoted fragment it runs
 * into (a nested pair's `key="v"`, a chain `'a'"b"`) is part of it, so nothing is left glued to the
 * marker.
 */
function arrowValueSpan(text: string, valueStart: number): ValueSpan | null {
  let arrow = valueStart - 1;
  while (arrow >= 0 && isSpace(text.charAt(arrow))) arrow -= 1;
  if (text.charAt(arrow) !== '>') return null;
  const typed = typographicValueSpan(text, valueStart);
  const end = typed ? typed.end : arrowValueEnd(text, valueStart);
  if (end < 0 || end <= valueStart) return null;
  return { start: arrow, end };
}

/**
 * Where the value after `=>` ends: an authorization value, a bare run, every quoted fragment it
 * reaches, and their joins.
 */
function arrowValueEnd(text: string, valueStart: number): number {
  const scheme = schemeValueEnd(text, valueStart, ARROW_SCHEMES);
  let end = scheme >= 0 ? scheme : pairValueEnd(text, valueStart);
  if (end < 0) return -1;
  for (;;) {
    const next = text.charAt(end);
    const quote = next === '"' || next === "'";
    const join = (next === ':' || next === ',') && (text.charAt(end + 1) === '"' || text.charAt(end + 1) === "'");
    if (!quote && !join) return end;
    const fragment = pairValueEnd(text, quote ? end : end + 1);
    if (fragment < 0) return end;
    end = fragment;
  }
}

/**
 * Walks credential pairs the way `redactPairValues` does and records the value spans instead of
 * replacing them. One pass: a candidate starts only where the previous one ended.
 */
function collectPairRegions(
  text: string,
  separator: (text: string, nameEnd: number) => number,
  valueSpan: (text: string, valueStart: number) => ValueSpan | null,
  accept: (name: string) => boolean,
  regions: Region[],
): void {
  let index = 0;
  while (index < text.length) {
    if (!isShapeNameStart(text.charAt(index))) {
      index += 1;
      continue;
    }
    let nameEnd = index + 1;
    while (nameEnd < text.length && isShapeNameChar(text.charAt(nameEnd))) nameEnd += 1;
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
    if (value === MARKER || PLAIN_LITERAL.test(value)) {
      index = nameEnd;
      continue;
    }
    regions.push(span);
    index = Math.max(span.end, nameEnd);
  }
}

/** The first index at or after `from` whose origin is at least `offset` (origins never decrease). */
function firstOriginAtLeast(origins: Int32Array, offset: number, from: number): number {
  let index = from;
  while (index < origins.length) {
    const origin = origins[index]!;
    if (origin >= offset) break;
    index += 1;
  }
  return index;
}

/**
 * The union of overlapping regions, in order (#989 review). Two shapes can claim one value --
 * `password => token:“first pw”` is an arrow whose value starts a typographic pair -- and dropping
 * the second would leave the tail of the value in place. Only a region fully inside an earlier one
 * disappears, because the union already covers it.
 */
function mergeRegions(regions: Region[]): Region[] {
  regions.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: Region[] = [];
  for (const region of regions) {
    const last = merged[merged.length - 1];
    if (last && region.start <= last.end) {
      if (region.end > last.end) merged[merged.length - 1] = { start: last.start, end: region.end };
      continue;
    }
    merged.push(region);
  }
  return merged;
}

/**
 * The released output with each region replaced by the marker. A region the released pipeline
 * already removed whole (it maps to an empty range) changes nothing. The search cursor advances past
 * every region, empty or not, so a text of blocks the release already removed is read once and not
 * rescanned from the front for each one (#989 review).
 */
function applyRegions(released: SpannedText, regions: readonly Region[]): string {
  const { text, origins } = released;
  const parts: string[] = [];
  /** Where emitted output has reached. */
  let copied = 0;
  /** Where the origin search has reached: it never moves backwards, empty range or not. */
  let searched = 0;
  for (const region of regions) {
    const start = firstOriginAtLeast(origins, region.start, searched);
    const end = firstOriginAtLeast(origins, region.end, start);
    searched = end;
    if (end <= start) continue;
    parts.push(text.slice(copied, start), MARKER);
    copied = end;
  }
  if (parts.length === 0) return text;
  parts.push(text.slice(copied));
  return parts.join('');
}

/** The separator every credential pair uses: an optional closing quote, `:` or `=`, then blanks. */
const separatorEndPair = (text: string, nameEnd: number): number => separatorEnd(text, nameEnd, true);

/**
 * The value shapes of #989, decided from the original text: PEM private-key blocks (standalone or
 * under a credential key), typographic-quoted values, values after `=>` and authorization values the
 * released pass leaves in part. Their spans are merged and later mapped into the released output,
 * whose text they replace -- the released pipeline always runs first and byte-identically, and this
 * can only take away more of the same values.
 */
function originalShapeRegions(original: string): Region[] {
  if (!MAY_HOLD_SHAPE.test(original)) return [];
  const regions: Region[] = [];
  pemRegions(original, regions);
  if (original.includes('PRIVATE KEY')) {
    // A block under a credential key is a pair's value, whichever separator the line used.
    collectPairRegions(original, separatorEndPair, keyedPemValueSpan, isShapesCredentialKey, regions);
    if (original.includes('=>')) {
      collectPairRegions(original, arrowSeparatorEnd, keyedPemValueSpan, isShapesCredentialKey, regions);
    }
  }
  // The gate above already proved one of the shapes is present; each collector still pre-checks
  // its own trigger, so a text with only one of them costs one pass per trigger, not per shape.
  collectPairRegions(original, separatorEndPair, typographicValueSpan, isShapesCredentialKey, regions);
  // An authorization value whose scheme the released pass does not know (`token: Digest abc`).
  collectPairRegions(original, separatorEndPair, keyedSchemeValueSpan, isShapesCredentialKey, regions);
  if (original.includes('=>')) {
    collectPairRegions(original, arrowSeparatorEnd, arrowValueSpan, isShapesCredentialKey, regions);
  }
  return regions.length === 0 ? regions : mergeRegions(regions);
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

/** How much of one detail string survives (#996). */
export const ERROR_DETAILS_MAX_CHARS = 1000;
/** How deep `redactErrorDetails` walks before it replaces the rest (#996). */
export const ERROR_DETAILS_MAX_DEPTH = 8;
/** How many array items and object properties it keeps in total (#996). */
export const ERROR_DETAILS_MAX_ELEMENTS = 1000;
/** What a value cut by the depth or element limit becomes (#996). */
export const ERROR_DETAILS_TRUNCATED = '[truncated]';

/**
 * Detail values that are an API contract rather than prose: a client switches on them
 * (`details.reason`). The bare-token rule eats `idempotency_key_reversed` (24 characters, with
 * separators allowed), so these exact values are kept. The list is exact, so a free-text value in
 * the same field still goes through the redactor (#996).
 */
const STRUCTURAL_DETAIL_VALUES: ReadonlySet<string> = new Set([
  'idempotency_key_reused',
  'idempotency_key_reversed',
  'idempotency_in_progress',
]);

/**
 * The redacted, bounded form of one object key (#996 review). A Zod tree error keeps the caller's
 * input key as an object key, so a key can carry a credential exactly like a value. Redacting two
 * different keys can make them equal; the later one gets a deterministic ` #2`, ` #3` in original
 * key order so no entry is silently dropped. Keys already distinct stay byte-for-byte identical, so
 * a second pass changes nothing.
 */
function safeDetailKey(key: string, used: ReadonlySet<string>): string {
  const base = redactedText(key, ERROR_DETAILS_MAX_CHARS);
  let candidate = base;
  for (let n = 2; used.has(candidate); n += 1) {
    const suffix = ` #${n}`;
    candidate = `${redactedText(key, Math.max(1, ERROR_DETAILS_MAX_CHARS - suffix.length))}${suffix}`;
  }
  return candidate;
}

/**
 * The safe copy of an AppError's `details` (#996): every string redacted and bounded, nested arrays
 * and objects walked with a depth limit and one **global** element budget, object keys redacted and
 * bounded with the structure kept so `details.reason` or `details.problems[].path` stay
 * machine-readable, and non-string primitives untouched. The original value is never mutated, and
 * an unchanged value is returned as it is (so an error with nothing to redact keeps its identity).
 * Redaction is idempotent, so a second pass at a serialisation point changes nothing.
 *
 * The budget is passed down and charged back up (`used`): every array item, object entry and
 * truncation marker counts once, wherever it is nested, so the output never exceeds the limit. A
 * container keeps one slot in hand while it still has a sibling to visit, so its terminal marker
 * always fits.
 */
export function redactErrorDetails(details: unknown): unknown {
  const seen = new WeakSet<object>();
  type Emitted = { value: unknown; used: number };

  const walk = (value: unknown, depth: number, budget: number): Emitted => {
    if (typeof value === 'string') {
      // The marker and the API's own enum values are not text a redactor could improve.
      if (value === ERROR_DETAILS_TRUNCATED || STRUCTURAL_DETAIL_VALUES.has(value)) return { value, used: 1 };
      // Redact while the value is complete; cutting first could leave a token prefix (#885).
      return { value: redactedText(value, ERROR_DETAILS_MAX_CHARS), used: 1 };
    }
    if (value === null || typeof value !== 'object') return { value, used: 1 };
    if (depth > ERROR_DETAILS_MAX_DEPTH) return { value: ERROR_DETAILS_TRUNCATED, used: 1 };
    // A value already walked is a cycle (or a shared node): do not walk it twice.
    if (seen.has(value)) return { value: ERROR_DETAILS_TRUNCATED, used: 1 };

    const entries = Array.isArray(value) ? value : Object.entries(value as Record<string, unknown>);
    // The container itself takes one slot; anything inside needs at least one more. Without that,
    // a marker stands in for the whole container.
    if (entries.length === 0) return { value, used: 1 };
    if (budget < 2) return { value: ERROR_DETAILS_TRUNCATED, used: 1 };
    seen.add(value);
    const next = depth + 1;
    /** Slots for this container's contents, its terminal marker included. */
    const content = budget - 1;
    let usedContent = 0;
    let truncated = false;

    if (Array.isArray(value)) {
      const out: unknown[] = [];
      let changed = false;
      for (let index = 0; index < value.length; index += 1) {
        // Keep one slot back while a sibling follows, so a marker for the tail always fits.
        const allowance = content - usedContent - (index < value.length - 1 ? 1 : 0);
        if (allowance < 1) {
          truncated = true;
          break;
        }
        const item: unknown = value[index];
        const child = walk(item, next, allowance);
        usedContent += child.used;
        if (child.value !== item) changed = true;
        out.push(child.value);
      }
      if (truncated && content - usedContent >= 1) {
        out.push(ERROR_DETAILS_TRUNCATED);
        usedContent += 1;
        changed = true;
      }
      return { value: changed ? out : value, used: 1 + usedContent };
    }

    const used = new Set<string>();
    // Built with Object.fromEntries so a caller key such as `__proto__` stays an own property
    // instead of changing the prototype.
    const pairs: [string, unknown][] = [];
    let changed = false;
    for (let index = 0; index < entries.length; index += 1) {
      const allowance = content - usedContent - (index < entries.length - 1 ? 1 : 0);
      if (allowance < 1) {
        truncated = true;
        break;
      }
      const [key, item] = entries[index]!;
      const cleanKey = safeDetailKey(key, used);
      if (cleanKey !== key) changed = true;
      used.add(cleanKey);
      const child = walk(item, next, allowance);
      usedContent += child.used;
      if (child.value !== item) changed = true;
      pairs.push([cleanKey, child.value]);
    }
    if (truncated && content - usedContent >= 1) {
      pairs.push([safeDetailKey(ERROR_DETAILS_TRUNCATED, used), ERROR_DETAILS_TRUNCATED]);
      usedContent += 1;
      changed = true;
    }
    return { value: changed ? Object.fromEntries(pairs) : value, used: 1 + usedContent };
  };

  // The root container is not an element of its parent; budget one extra slot for it so its own
  // contents may use the whole limit.
  return walk(details, 0, ERROR_DETAILS_MAX_ELEMENTS + 1).value;
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
