// Inbound SMS replies, normalised before classification (#636). Providers hand us the raw Body,
// so "STOP.", "stop," , "Please STOP" and a fullwidth "ＳＴＯＰ" must mean the same as "STOP".
//
// Rule:
// - Normalise: NFKC (fullwidth and other compatibility forms), case fold, drop emoji, then split
//   on every run of characters that is not a letter or a digit. "STOP,please", "Please
//   STOP/UNSUBSCRIBE" and "Please stop—sending these messages" therefore all contain the token
//   "stop"; splitting only on spaces missed them.
// - ANY opt-out keyword as a token opts out, anywhere in the reply and however long it is. That
//   includes "I want to cancel my order": for replies to marketing SMS a false opt-out is the
//   compliant failure, because a missed one keeps texting someone who asked us to stop.
// - START and HELP still require the whole normalised message to be the keyword, so "please
//   start" is not an opt-in.
// - If a reply contains both an opt-out keyword and START, STOP wins for the same reason.

export const STOP_WORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'STOPP', 'AFMELD', 'AVSLUTA'];
export const START_WORDS = ['START', 'UNSTOP', 'YES'];
export const HELP_WORDS = ['HELP', 'INFO', 'HJÆLP', 'HJELP', 'HJÄLP'];

export type SmsIntent = 'stop' | 'start' | 'help';

export interface SmsReplyMatch {
  intent: SmsIntent;
  /** The matched keyword in its canonical spelling, for evidence on the consent record. */
  keyword: string;
}

const stop = new Set(STOP_WORDS.map((w) => w.toLowerCase()));
const start = new Set(START_WORDS.map((w) => w.toLowerCase()));
const help = new Set(HELP_WORDS.map((w) => w.toLowerCase()));

// After NFKC and case folding, any run of non-letters/non-digits separates tokens. Punctuation,
// slashes, dashes and emoji all become separators, so "STOP,please" and "stop—now" work.
const TOKEN_SEPARATOR = /[^\p{L}\p{N}]+/u;

// Emoji are not words; a reply of "STOP 🙂" is still a stop.
const EMOJI = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\uFE0F|\u200D/gu;
// Punctuation and symbols at the very start or end of a message (or of one word).
const EDGE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/** The reply as compared: compatibility-normalised, lower-case, without edge punctuation or emoji. */
export function normalizeSmsText(input: string): string {
  // An emoji is a separator, not a joiner: "stop🙂please" must still contain two tokens.
  return input.normalize('NFKC').toLowerCase().replace(EMOJI, ' ').replace(/\s+/g, ' ').trim().replace(EDGE, '').trim();
}

/** STOP, START, HELP or null, with the rule documented at the top of this file. */
export function classifySmsReply(body: string): SmsReplyMatch | null {
  const text = normalizeSmsText(body);
  if (!text) return null;
  const words = text.split(TOKEN_SEPARATOR).filter(Boolean);

  // STOP first, so a message that contains both START and an opt-out keyword still opts out.
  const found = words.find((word) => stop.has(word));
  if (found) return { intent: 'stop', keyword: found.toUpperCase() };
  if (words.length !== 1) return null;
  if (start.has(words[0]!)) return { intent: 'start', keyword: words[0]!.toUpperCase() };
  if (help.has(words[0]!)) return { intent: 'help', keyword: words[0]!.toUpperCase() };
  return null;
}
