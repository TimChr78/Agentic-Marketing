// Inbound SMS replies, normalised before classification (#636). Providers hand us the raw Body,
// so "STOP.", "stop," , "Please STOP" and a fullwidth "ＳＴＯＰ" must mean the same as "STOP".
//
// Rule:
// - Normalise: NFKC (fullwidth and other compatibility forms), lower-case, drop emoji, collapse
//   whitespace, then strip punctuation around the message and around each word.
// - Strong stop words (STOP, STOPALL, UNSUBSCRIBE) opt out anywhere they appear as a standalone
//   word, however long the reply: "Please stop sending me these messages right now" and "Don't
//   stop the music, it's great" both opt out. For replies to marketing SMS a false opt-out is the
//   compliant failure; a missed one keeps texting someone who asked us to stop.
// - Weak stop words (CANCEL, END, QUIT and the localised spellings) opt out only as the whole
//   message, as the first word, or in a short message of at most five words. That keeps "I want to
//   cancel my order please thanks" from opting out.
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
// These three are unambiguous enough to count anywhere in a reply.
const strongStop = new Set(['stop', 'stopall', 'unsubscribe']);
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

  // STOP first, so the ambiguity rule always favours opting out. A strong keyword anywhere is a
  // clear instruction even when the message goes on ("Please stop sending me these messages").
  const strong = words.find((word) => strongStop.has(word));
  if (strong) return { intent: 'stop', keyword: strong.toUpperCase() };
  const first = words[0];
  if (first && stop.has(first)) return { intent: 'stop', keyword: first.toUpperCase() };
  if (words.length <= SHORT_MESSAGE_WORDS) {
    const found = words.find((word) => stop.has(word));
    if (found) return { intent: 'stop', keyword: found.toUpperCase() };
  }
  if (start.has(text)) return { intent: 'start', keyword: text.toUpperCase() };
  if (help.has(text)) return { intent: 'help', keyword: text.toUpperCase() };
  return null;
}
