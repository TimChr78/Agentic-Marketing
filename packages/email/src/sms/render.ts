import type { SmsTemplate } from '@agentic-marketing/artifacts';
import { Liquid } from 'liquidjs';
import { smsSegments } from './adapters';

// SMS text: Liquid without HTML escaping (it is plain text), sandboxed like e-mail templates.
const engine = new Liquid({
  strictFilters: true,
  fs: {
    readFileSync: () => {
      throw new Error('includes are not available in templates');
    },
    readFile: async () => {
      throw new Error('includes are not available in templates');
    },
    existsSync: () => false,
    exists: async () => false,
    resolve: (_root: string, file: string) => file,
  },
  relativeReference: false,
  parseLimit: 10_000,
  renderLimit: 500,
  memoryLimit: 5_000_000,
});

export const STOP_FOOTER = ' Reply STOP to opt out.';

// Marketing texts always carry an opt-out instruction (#635). A body counts as already having one
// only when its tail is a real instruction: an instruction verb, a stop keyword and an opt-out
// purpose — "Reply STOP to opt out", "Text STOP to unsubscribe" — or our own rendered footer. The
// bare word "stop" is not an instruction: "Don't stop reading", "Visit Stop & Shop today" and
// "Stop by before the deals end!" still get the footer. A duplicate footer is the safe failure; a
// missing one is the compliance defect.
const STOP_KEYWORD = '(?:stop|stopall|unsubscribe|cancel|end|quit|stopp|afmeld|avsluta)';
const OPT_OUT_PURPOSE = '(?:to\\s+(?:opt[\\s-]?out|unsubscribe|stop|end|cancel)|opt[\\s-]?out)';
const OPT_OUT_TAIL = new RegExp(
  `\\b(?:reply|text|txt|send|respond)\\s+${STOP_KEYWORD}\\b[^.!?]{0,40}?\\b${OPT_OUT_PURPOSE}\\b[^.!?]{0,40}[.!?]?\\s*$`,
  'i',
);

// A carrier's own boilerplate may follow the instruction; it does not make it a different command.
// One clause at a time, tested against a short window at the end, so the cost is constant per clause:
// a single regex with a repeated group of optional whitespace backtracked exponentially (CodeQL).
const BOILERPLATE_CLAUSE = /msg\s?(?:&|and)?\s?(?:data rates may apply|freq(?:uency)? varies)\.?$/i;
const BOILERPLATE_WINDOW = 80;
const MAX_BOILERPLATE_CLAUSES = 4;

function stripTrailingBoilerplate(body: string): string {
  let text = body.trimEnd();
  for (let i = 0; i < MAX_BOILERPLATE_CLAUSES; i += 1) {
    const start = Math.max(0, text.length - BOILERPLATE_WINDOW);
    const window = text.slice(start).replace(/\s+/g, ' ');
    const match = BOILERPLATE_CLAUSE.exec(window);
    if (!match) break;
    // The window's whitespace was collapsed, so cut by the clause's length in collapsed form: the
    // remaining text before the clause is what the window held before the match.
    const kept = window.slice(0, match.index);
    text = (text.slice(0, start) + kept).trimEnd();
  }
  return text;
}

/** True when the body already ends with a real opt-out instruction (not merely the word "stop"). */
export function hasOptOutInstruction(body: string): boolean {
  const tail = stripTrailingBoilerplate(body);
  return tail.endsWith(STOP_FOOTER) || OPT_OUT_TAIL.test(tail);
}

export function validateSmsTemplate(t: SmsTemplate): string[] {
  try {
    engine.parse(t.body);
    return [];
  } catch (e) {
    return [`body: Liquid error: ${(e as Error).message.split('\n')[0]}`];
  }
}

/** The text as sent: rendered, whitespace tidied, with the opt-out footer for marketing texts. */
export async function renderSms(t: SmsTemplate, vars: Record<string, unknown>, marketing: boolean) {
  let body = (await engine.parseAndRender(t.body, vars)).replace(/[ \t]+/g, ' ').trim();
  if (marketing && !hasOptOutInstruction(body)) body += STOP_FOOTER;
  return { body, ...smsSegments(body) };
}
