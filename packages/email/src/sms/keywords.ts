// Inbound SMS replies, normalised before classification (#636). Providers hand us the raw Body,
// so "STOP.", "stop," , "Please STOP" and a fullwidth "ＳＴＯＰ" must mean the same as "STOP".
//
// Rule:
// - Normalise: NFKC (fullwidth and other compatibility forms), lower-case, drop emoji, collapse
//   whitespace, then strip punctuation around the message and around each word.
// - STOP when the whole normalised message is a stop keyword, or when it is short (at most five
//   words) and contains a stop keyword as a standalone word. "Please STOP" opts out; "STOP!!!"
//   too. A long conversational sentence ("Don't stop the music, it's great") does not.
// - START and HELP only as the whole normalised message, so "please start" is not an opt-in.
// - Ambiguity: a short message with both a stop and a start word is a STOP. Opting out is the
//   compliant default: a wrong opt-out is recoverable, a missed one keeps texting someone who
//   asked us to stop.

export const STOP_WORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'STOPP', 'AFMELD', 'AVSLUTA'];
export const START_WORDS = ['START', 'UNSTOP', 'YES'];
export const HELP_WORDS = ['HELP', 'INFO', 'HJÆLP', 'HJELP', 'HJÄLP'];

export type SmsIntent = 'stop' | 'start' | 'help';

export interface SmsReplyMatch {
  intent: SmsIntent;
  /** The matched keyword in its canonical spelling, for evidence on the consent record. */
  keyword: string;
}

const SHORT_MESSAGE_WORDS = 5;

const stop = new Set(STOP_WORDS.map((w) => w.toLowerCase()));
const start = new Set(START_WORDS.map((w) => w.toLowerCase()));
const help = new Set(HELP_WORDS.map((w) => w.toLowerCase()));

// Emoji are not words; a reply of "STOP 🙂" is still a stop.
const EMOJI = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\uFE0F|\u200D/gu;
// Punctuation and symbols at the very start or end of a message (or of one word).
const EDGE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/** The reply as compared: compatibility-normalised, lower-case, without edge punctuation or emoji. */
export function normalizeSmsText(input: string): string {
  return input.normalize('NFKC').toLowerCase().replace(EMOJI, '').replace(/\s+/g, ' ').trim().replace(EDGE, '').trim();
}

const wordOf = (token: string) => token.replace(EDGE, '');

/** STOP, START, HELP or null, with the rule documented at the top of this file. */
export function classifySmsReply(body: string): SmsReplyMatch | null {
  const text = normalizeSmsText(body);
  if (!text) return null;
  const words = text.split(' ').map(wordOf).filter(Boolean);

  // STOP first, so the ambiguity rule always favours opting out.
  if (words.length <= SHORT_MESSAGE_WORDS) {
    const found = words.find((word) => stop.has(word));
    if (found) return { intent: 'stop', keyword: found.toUpperCase() };
  }
  if (start.has(text)) return { intent: 'start', keyword: text.toUpperCase() };
  if (help.has(text)) return { intent: 'help', keyword: text.toUpperCase() };
  return null;
}
