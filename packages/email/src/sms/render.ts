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
// only when its tail is an instruction naming a stop keyword — "Reply STOP to opt out", "Text STOP
// to unsubscribe", or our own rendered footer. The bare word "stop" is not an instruction: "Don't
// stop reading" and "Visit Stop & Shop today" still get the footer. A duplicate footer is the safe
// failure; a missing one is the compliance defect.
const STOP_KEYWORD = '(?:stop|stopall|unsubscribe|cancel|end|quit|stopp|afmeld|avsluta)';
const OPT_OUT_TAIL = new RegExp(
  `\\b(?:reply|text|txt|send|message)\\s+${STOP_KEYWORD}\\b[^.!?]{0,20}[.!?]?\\s*$|\\b${STOP_KEYWORD}\\b[^.!?]{0,40}\\b(?:opt[\\s-]?out|unsubscribe|stop|cancel|end|quit)\\b[^.!?]{0,20}[.!?]?\\s*$`,
  'i',
);

/** True when the body already ends with a real opt-out instruction (not merely the word "stop"). */
export function hasOptOutInstruction(body: string): boolean {
  return body.endsWith(STOP_FOOTER) || OPT_OUT_TAIL.test(body);
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
