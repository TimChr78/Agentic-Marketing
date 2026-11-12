// Rule-based personal-data detection, shared by the AI context builder and the consent ledger.
// Kept here so both packages can use the same detectors without duplicating the patterns.
//
// #765: the phone detector used to require a `+` or `00` prefix, so national formats such as
// `555 123 4567` or `020 7946 0958` reached roles without profiles:pii through allowlisted
// consent-proof keys. It now also takes national numbers, and a conservative street-address
// detector covers postal addresses. For consent proof a false positive only withholds something
// harmless, while a false negative leaks, so the detectors err towards matching.

/** One detector: a pattern, its label, and an optional check on a candidate the pattern found. */
interface Detector {
  label: string;
  re: RegExp;
  accept?: (match: string, text: string, index: number) => boolean;
}

/**
 * A phone-shaped run: an optional international prefix, digits with spaces, dots, dashes and at
 * most one parenthesised group. Bounded quantifiers keep the scan linear (an `expectLinear` test
 * guards it). A run may also start with a parenthesised area code.
 */
const PHONE_CANDIDATE = /(?<![\p{L}\d])(?:\+|00)?(?:\(\d{1,5}\)[ .-]?|\d)[\d ().-]{6,24}\d(?![\p{L}\d])/gu;

/**
 * Whether a phone-shaped run really is a phone number. A plain 9-digit count, an ISO date, a
 * date-time or an id with adjacent letters is not: the run must be international, contain a
 * separator, or be a contiguous national number with a trunk 0, and it must hold 9–15 digits.
 * An 8-digit run (DK/NO) counts unless it is date-shaped.
 */
function isPhone(match: string, text: string, index: number): boolean {
  const digits = match.replace(/\D/g, '');
  // Danish and Norwegian numbers have 8 digits (12 34 56 78, 12345678). A contiguous 8-digit run
  // that reads as a date (YYYYMMDD) is not a phone; any other 8-digit run is, erring towards
  // withholding (0.14.11 review).
  if (digits.length === 8) {
    if (/^\d{8}$/.test(match) && /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/.test(match)) return false;
    if (/^\d{4}[-./]\d{2}[-./]?\d{2}$/.test(match)) return false;
    if (/[\p{L}][-_/.#]$/u.test(text.slice(Math.max(0, index - 2), index))) return false;
    return true;
  }
  if (digits.length < 9 || digits.length > 15) return false;
  // At most one parenthesised group, and it must be closed.
  const opens = (match.match(/\(/g) ?? []).length;
  const closes = (match.match(/\)/g) ?? []).length;
  if (opens > 1 || opens !== closes) return false;
  // ISO dates and date-times such as 2026-11-12 09:30 are not phone numbers.
  if (/^\d{1,4}[-./]\d{1,2}[-./]\d{1,4}(?:[ T]|$)/.test(match)) return false;
  // A 6+4 grouping without separators is a national id (CPR, personnummer), not a phone.
  if (/^\d{6}-\d{4}$/.test(match)) return false;
  // An order id carries letters right next to the number, e.g. ORD-123456789.
  if (/[\p{L}][-_/.#]$/u.test(text.slice(Math.max(0, index - 2), index))) return false;
  const international = /^(?:\+|00)/.test(match);
  const separated = /\d[ ().-]\d/.test(match);
  const nationalWithTrunk = /^0\d{8,14}$/.test(match);
  return international || separated || nationalWithTrunk;
}

/**
 * Street words that make a line an address. `via` is handled on its own: as an English word it
 * would otherwise match phrases like "sent via e-mail to 5 people".
 */
const STREET_WORDS =
  'street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|drive|dr|court|ct|place|pl|terrace|way|strasse|straße|gade|vej|gatan|gata|rue|calle|avenida';

const detectors: Detector[] = [
  { label: '[email]', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { label: '[iban]', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g },
  { label: '[card]', re: /\b(?:\d[ -]?){13,19}\b/g },
  // Before the phone detector: a CPR-shaped number is a national id, not a phone.
  { label: '[national-id]', re: /\b\d{6}-?\d{4}\b/g },
  { label: '[phone]', re: PHONE_CANDIDATE, accept: isPhone },
  { label: '[ip]', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  // 123 Main Street / 10 Downing St.: a house number, a name and a street word.
  {
    label: '[address]',
    re: new RegExp(`\\b\\d{1,5}[a-z]?(?:\\s+[\\p{L}][\\p{L}'’.\\-]*){1,4}\\s+(?:${STREET_WORDS})\\b\\.?`, 'giu'),
  },
  // 27 Rue de la Paix: a house number followed by the street word and its name.
  {
    label: '[address]',
    re: /\b\d{1,5}[a-z]?\s+(?:rue|calle|avenida|strasse|straße|street|road|avenue|gade|vej|gatan|gata)\s+(?:[\p{L}'’.-]+\s+){1,3}\p{L}[\p{L}'’.-]*/giu,
  },
  // Hauptstraße 12 / Nørregade 5 / Rue de la Paix 5: the street word first, a house number last.
  {
    label: '[address]',
    re: /\b[\p{L}'’.-]{0,30}(?:strasse|straße|gade|vej|gatan|gata|rue|calle|avenida|street|road|avenue)\b\.?(?:\s+[\p{L}'’.-]+){0,3}\s+\d{1,5}[a-z]?\b/giu,
  },
  // Via Roma 10: capitalized, so the English preposition "via" does not match.
  { label: '[address]', re: /\bVia\s+(?:\p{Lu}[\p{L}'’.-]*\s+){1,3}\d{1,5}[a-z]?\b/gu },
  // DK/NO (4 digits) and DE/FR (5 digits) postal codes followed by the place name.
  { label: '[address]', re: /\b\d{4}\s+\p{Lu}[\p{L}]{2,}/gu },
  { label: '[address]', re: /\b\d{5}\s+\p{Lu}[\p{L}]{2,}/gu },
  // SE postal code: 111 22 Stockholm.
  { label: '[address]', re: /\b\d{3}\s\d{2}\s+\p{Lu}[\p{L}]{2,}/gu },
  // UK postcode (SW1A 1AA, M1 1AE, GIR 0AA).
  { label: '[address]', re: /\b(?:gir ?0aa|[a-pr-uwyz][a-hk-y]?\d[a-hjkpstuw]?\s?\d[abd-hjlnp-uw-z]{2})\b/giu },
  // US ZIP+4, and "Austin, TX 78701".
  { label: '[address]', re: /\b\d{5}-\d{4}\b/g },
  { label: '[address]', re: /,\s*[a-z]{2}\s+\d{5}(?:-\d{4})?\b/giu },
];

/** Whether one detector finds an accepted candidate in the text (iterative, no state carried over). */
function scan(detector: Detector, text: string): boolean {
  detector.re.lastIndex = 0;
  let match: RegExpExecArray | null = detector.re.exec(text);
  while (match) {
    if (!detector.accept || detector.accept(match[0], text, match.index)) {
      detector.re.lastIndex = 0;
      return true;
    }
    match = detector.re.exec(text);
  }
  detector.re.lastIndex = 0;
  return false;
}

/** Replaces every accepted candidate of one detector, leaving rejected candidates as they are. */
function replaceMatches(input: string, detector: Detector): string {
  detector.re.lastIndex = 0;
  let out = '';
  let last = 0;
  for (const match of input.matchAll(detector.re)) {
    const index = match.index ?? 0;
    if (detector.accept && !detector.accept(match[0], input, index)) continue;
    out += input.slice(last, index) + detector.label;
    last = index + match[0].length;
  }
  detector.re.lastIndex = 0;
  return last === 0 ? input : out + input.slice(last);
}

/** Rule-based redaction of contact, address and payment details in free text. */
export function redactText(s: string): string {
  let out = s;
  for (const detector of detectors) out = replaceMatches(out, detector);
  return out;
}

/** Which kinds of personal data the same detectors find in free text, e.g. ["[email]"] (hosted memory notes, #340). */
export function personalDataInText(s: string): string[] {
  const found = new Set<string>();
  for (const detector of detectors) if (scan(detector, s)) found.add(detector.label);
  return [...found];
}

/** Markers for what a structural cap removed: a marker, never the original value. */
export const REDACTED_CYCLE = '[redacted: circular]';
export const REDACTED_LIMIT = '[redacted: too large]';

/** Arrays kept their original cap; objects and the whole walk get their own, larger ones. */
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 1_000;
const MAX_NODES = 10_000;

/**
 * Rule-based redaction of contact and payment details at every depth (#641). Walks iteratively
 * with no depth cap, the way `personalDataIn` does (#352), so a value nested fifty levels down
 * is still visited instead of returned unchanged. A cycle or a size cap fails closed: the part
 * that cannot be visited becomes a marker, never the original value.
 */
export function redact<T>(input: T): T {
  let result: unknown;
  const seen = new WeakSet<object>();
  type Job = { value: unknown; set: (out: unknown) => void };
  const jobs: Job[] = [
    {
      value: input,
      set: (out) => {
        result = out;
      },
    },
  ];
  let nodes = 0;
  while (jobs.length) {
    const job = jobs.pop();
    if (!job) break;
    const { value, set } = job;
    if (typeof value === 'string') {
      set(redactText(value));
      continue;
    }
    if (value === null || typeof value !== 'object') {
      set(value);
      continue;
    }
    // A cycle (or a value already seen) cannot be walked safely and must not be forwarded.
    if (seen.has(value)) {
      set(REDACTED_CYCLE);
      continue;
    }
    seen.add(value);
    if (++nodes > MAX_NODES) {
      set(REDACTED_LIMIT);
      continue;
    }
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      set(out);
      const kept = Math.min(value.length, MAX_ARRAY_ITEMS);
      for (let i = 0; i < kept; i++) {
        out.push(undefined);
        jobs.push({
          value: value[i],
          set: (x) => {
            out[i] = x;
          },
        });
      }
      if (value.length > kept) out.push(REDACTED_LIMIT);
      continue;
    }
    const out: Record<string, unknown> = {};
    set(out);
    const entries = Object.entries(value as Record<string, unknown>);
    const kept = Math.min(entries.length, MAX_OBJECT_KEYS);
    for (let i = 0; i < kept; i++) {
      const [k, x] = entries[i] as [string, unknown];
      out[k] = undefined;
      jobs.push({
        value: x,
        set: (y) => {
          out[k] = y;
        },
      });
    }
    if (entries.length > kept) out[REDACTED_LIMIT] = REDACTED_LIMIT;
  }
  return result as T;
}

/** Keys whose name alone marks personal data, even when the value does not match a detector. */
const PERSONAL_KEY =
  /^(e-?mail|phone|mobile|msisdn|first_?name|last_?name|full_?name|name|address|street|postcode|zip|ssn|iban|card(_?number)?)$/i;

/**
 * The kind of personal data in a value ("email", "phone", …), or null. Uses the same detectors
 * as `redact`, so a decision provider without a no-retention agreement can refuse a state
 * instead of sending it (#194).
 */
export function personalDataIn(v: unknown): string | null {
  // Iterative, with no depth cap: a value nested deeper than the old limit of 8 used to be
  // skipped entirely, so an e-mail nine levels down reached the provider (#352). The stack also
  // keeps a deeply nested value from overflowing the call stack.
  const stack: unknown[] = [v];
  const seen = new WeakSet<object>();
  while (stack.length) {
    const x = stack.pop();
    if (typeof x === 'string') {
      for (const detector of detectors) if (scan(detector, x)) return detector.label.replace(/[[\]]/g, '');
      continue;
    }
    if (x === null || typeof x !== 'object') continue;
    if (seen.has(x)) continue;
    seen.add(x);
    if (Array.isArray(x)) {
      for (const item of x) stack.push(item);
      continue;
    }
    for (const [k, item] of Object.entries(x as Record<string, unknown>)) {
      if (PERSONAL_KEY.test(k)) return 'identifier';
      stack.push(item);
    }
  }
  return null;
}
