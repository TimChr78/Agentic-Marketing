// What a failure may say about itself (#885). An AppError message is written for a person and
// copied verbatim into the audit log and the agent ledger, so text that came from a provider, a
// driver or an exception must be reduced to a safe diagnostic before it is put there: a provider's
// own error code and message, never its body, and never a token the body or an exception echoes.

/** Anything whose value is a credential: the key is kept (it says what failed), the value is not. */
const CREDENTIAL_KEY =
  '(?:access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|developer[_-]?token|api[_-]?key|' +
  'client[_-]?secret|app[_-]?secret|private[_-]?key|secret|password|passwd|authorization)';

/**
 * Token-shaped values, in the order they must be applied: a named credential (`access_token=…`,
 * `"developer-token": "…"`), an Authorization value (`Bearer …`), then a bare long token
 * (base64, base64url or hex), which is what a gateway echoing a header leaves behind.
 */
const REDACTIONS: readonly (readonly [RegExp, string])[] = [
  [
    // A quoted or bare value, unless it is only an auth scheme word (the `Bearer` rule covers that).
    new RegExp(`\\b(${CREDENTIAL_KEY})\\b(["']?)\\s*[:=]\\s*(?!Bearer\\b|Basic\\b)("(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s,;&}\\]"']+)`, 'gi'),
    '$1$2=[redacted]',
  ],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [redacted]'],
  // 40+ characters with no separators: a token, not a word, an id or a number.
  [/[A-Za-z0-9+/_-]{40,}={0,2}/g, '[redacted]'],
];

/**
 * Removes token-shaped values from free text: an exception's message, a provider's answer, a log
 * line that is about to become an AppError.
 */
export function redactCredentials(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

const CODE_FIELDS = ['code', 'status', 'type'] as const;
const TEXT_FIELDS = ['message', 'error_description', 'detail', 'description'] as const;
/** The keys a provider nests its error object under. */
const NESTED_FIELDS = ['error', 'errors', 'details', 'cause'] as const;
/** Fields one diagnostic may carry: a code, a message, and a little context. */
const MAX_PARTS = 4;
const MAX_PART_CHARS = 200;

function addPart(out: string[], value: string) {
  const text = value.trim();
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
