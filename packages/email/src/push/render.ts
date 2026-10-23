import type { PushTemplate } from '@agentic-marketing/artifacts';
import { Liquid } from 'liquidjs';

// Push text: Liquid without HTML escaping (notifications are plain text), sandboxed like e-mail
// and SMS templates.
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

export function validatePushTemplate(t: PushTemplate): string[] {
  const problems: string[] = [];
  for (const field of ['title', 'body', 'url'] as const) {
    const v = t[field];
    if (v === undefined) continue;
    try {
      engine.parse(v);
    } catch (e) {
      problems.push(`${field}: Liquid error: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  return problems;
}

const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The notification as sent: rendered and tidied; the link must be http(s). */
export async function renderPush(t: PushTemplate, vars: Record<string, unknown>) {
  const [title, body, url] = await Promise.all([
    engine.parseAndRender(t.title, vars),
    engine.parseAndRender(t.body, vars),
    t.url ? engine.parseAndRender(t.url, vars) : Promise.resolve(''),
  ]);
  const link = tidy(url);
  if (link && !/^https?:\/\//i.test(link)) throw new Error(`the link "${link.slice(0, 80)}" is not an http(s) URL`);
  return { title: tidy(title).slice(0, 200), body: tidy(body).slice(0, 1000), url: link || null };
}
