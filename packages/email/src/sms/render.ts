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
  if (marketing && !/\bstop\b/i.test(body)) body += STOP_FOOTER;
  return { body, ...smsSegments(body) };
}
